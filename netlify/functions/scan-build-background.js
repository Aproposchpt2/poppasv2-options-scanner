// POPPAS PRO v2 — FULL S&P 500 + NASDAQ scan, CHUNKED + RESUMABLE + SELF-CHAINING.
// v2 DIFFERENCES vs OPTIONS-PRO (v1):
//   • Spread quality checks ALL FOUR legs (sc, sp, lc, lp) — v1 only checked short legs.
//   • Liquidity split: shortPutOI/shortCallOI (≥500 each) + longPutOI/longCallOI (≥100 each).
//   • midCredit output alongside conservative credit (bid-side sell, ask-side buy).
//   • Probability language: anchor-leg OTM only ("Matches primary filters" vs v1 "High Edge").
//   • Note labels: "Matches primary filters ✓" / "Needs review: <misses>" (safer framing).
//   • checks object has 7 keys (roc, monthlyLiquidity, shortLegLiquidity, longLegLiquidity,
//     iv, probOtm, spread) vs v1's 6 (roc, liquidity, iv, probOtm, spread, earnings).
//     Earnings is surfaced as a field for verification but does NOT block pass/fail here.
//
// Data source, universe, and infrastructure are identical to v1:
//   CBOE free delayed/EOD: https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json
//   S&P 500 CSV: https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv
//   Earnings calendar: https://api.nasdaq.com/api/calendar/earnings?date={YYYY-MM-DD}
//   Storage: Netlify Blobs, namespace "poppas-scan"
// When Poppa's paid API arrives, swap ONLY fetchSym().

import { getStore } from "@netlify/blobs";

const CHUNK = 24;
const CONCURRENCY = 3;
const MAX_RUN_MS = 12 * 60 * 1000;
const SP500_CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

// v2 thresholds (match daily-options-scan.js)
const MIN_MONTHLY_OI    = 10000;
const MIN_SHORT_LEG_OI  = 500;
const MIN_LONG_LEG_OI   = 100;
const MAX_ALL_LEG_SPREAD = 0.05; // widest bid/ask across all four legs

const CURATED = [
  ["NVDA","NVIDIA","Technology","both"],["TSLA","Tesla","Consumer Disc.","both"],["AMD","Advanced Micro Devices","Technology","both"],
  ["AAPL","Apple","Technology","both"],["MSFT","Microsoft","Technology","both"],["META","Meta Platforms","Communications","both"],
  ["AMZN","Amazon","Consumer Disc.","both"],["GOOGL","Alphabet","Communications","both"],["AVGO","Broadcom","Technology","both"],
  ["NFLX","Netflix","Communications","both"],["MU","Micron","Technology","both"],["MRVL","Marvell","Technology","both"],
  ["QCOM","Qualcomm","Technology","both"],["AMAT","Applied Materials","Technology","both"],["LRCX","Lam Research","Technology","both"],
  ["KLAC","KLA Corp","Technology","both"],["INTC","Intel","Technology","both"],["ON","ON Semiconductor","Technology","both"],
  ["ENPH","Enphase","Technology","both"],["FSLR","First Solar","Technology","both"],["SMCI","Super Micro","Technology","both"],
  ["PLTR","Palantir","Technology","both"],["ADBE","Adobe","Technology","both"],["PANW","Palo Alto Networks","Technology","both"],
  ["CRWD","CrowdStrike","Technology","both"],["ABNB","Airbnb","Consumer Disc.","both"],["SBUX","Starbucks","Consumer Disc.","both"],
  ["BKNG","Booking","Consumer Disc.","both"],["MRNA","Moderna","Health Care","both"],["COST","Costco","Consumer Staples","both"],
  ["COIN","Coinbase","Financials","both"],["APP","AppLovin","Technology","both"],["DASH","DoorDash","Consumer Disc.","both"],
  ["CSCO","Cisco","Technology","both"],["TMUS","T-Mobile","Communications","both"],["AMGN","Amgen","Health Care","both"],
  ["GILD","Gilead Sciences","Health Care","both"],["PEP","PepsiCo","Consumer Staples","both"],["MDLZ","Mondelez","Consumer Staples","both"],
  ["MSTR","Strategy","Technology","ndx"],["MARA","MARA Holdings","Financials","ndx"],["RIOT","Riot Platforms","Financials","ndx"],
  ["SOFI","SoFi Technologies","Financials","ndx"],["DKNG","DraftKings","Consumer Disc.","ndx"],["ARM","Arm Holdings","Technology","ndx"],
  ["ROKU","Roku","Communications","ndx"],["HOOD","Robinhood","Financials","ndx"],["SNOW","Snowflake","Technology","ndx"],
  ["DDOG","Datadog","Technology","ndx"],["PDD","PDD Holdings","Consumer Disc.","ndx"],["AFRM","Affirm","Financials","ndx"],
  ["RBLX","Roblox","Communications","ndx"]
];

const cboeUrl  = s => `https://cdn.cboe.com/api/global/delayed_quotes/options/${s}.json`;
const parseOcc = s => { const m = s.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/); return m ? { y: 2000 + +m[2], mo: +m[3], d: +m[4], type: m[5], strike: +m[6] / 1000 } : null; };
const dteOf    = (y, mo, d, now) => Math.round((Date.UTC(y, mo - 1, d) - now) / 864e5);
const isThirdFriday = (y, mo, d) => { const x = new Date(Date.UTC(y, mo - 1, d)); return x.getUTCDay() === 5 && d >= 15 && d <= 21; };
const ivPct    = v => (v > 1.5 ? v : v * 100);
const widthFor = spot => (spot < 250 ? 5 : 10);
const sleep    = ms => new Promise(r => setTimeout(r, ms));
const json     = o => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
const bid      = o => Number.isFinite(+o.bid) ? +o.bid : 0;
const ask      = o => Number.isFinite(+o.ask) ? +o.ask : 0;
const mid      = o => +((bid(o) + ask(o)) / 2).toFixed(2);

function parseCsvLine(ln) { const r = []; let cur = "", q = false; for (const ch of ln) { if (ch === '"') q = !q; else if (ch === "," && !q) { r.push(cur); cur = ""; } else cur += ch; } r.push(cur); return r; }

async function loadUniverse() {
  try {
    const r = await fetch(SP500_CSV);
    if (!r.ok) throw new Error("csv " + r.status);
    const lines = (await r.text()).split(/\r?\n/).filter(Boolean);
    lines.shift();
    const override = Object.fromEntries(CURATED.map(([s, , , m]) => [s, m]));
    const seen = new Set(), uni = [];
    for (const ln of lines) {
      const f = parseCsvLine(ln);
      const sym = (f[0] || "").trim().toUpperCase();
      if (!sym || sym.includes(".")) continue;
      if (seen.has(sym)) continue; seen.add(sym);
      uni.push([sym, (f[1] || sym).trim(), (f[2] || "S&P 500").trim(), override[sym] || "sp"]);
    }
    for (const c of CURATED) if (!seen.has(c[0])) { uni.push(c); seen.add(c[0]); }
    return uni.length >= 50 ? uni : CURATED;
  } catch (_) { return CURATED; }
}

async function loadEarnings(days = 90) {
  const map = {}, base = Date.now(), queue = [];
  for (let i = 0; i <= days; i++) queue.push(new Date(base + i * 864e5).toISOString().slice(0, 10));
  async function worker() {
    while (queue.length) {
      const d = queue.shift();
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
      try {
        const r = await fetch("https://api.nasdaq.com/api/calendar/earnings?date=" + d, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "application/json, text/plain, */*" }, signal: ctrl.signal });
        if (r.ok) { const j = await r.json(); for (const row of ((j.data && j.data.rows) || [])) { const s = (row.symbol || "").toUpperCase().trim(); if (s && (!map[s] || d < map[s])) map[s] = d; } }
      } catch (_) {} finally { clearTimeout(t); }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  return map;
}

async function fetchSym(sym, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(cboeUrl(sym), { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal });
      if (r.ok) { const j = await r.json(); clearTimeout(t); return j.data || j; }
    } catch (_) {} finally { clearTimeout(t); }
    await sleep(450 + Math.random() * 350);
  }
  return null;
}

// v2 scanAll — all expiries in the 15-45 DTE window, using v2 logic throughout.
function scanAll(ch, sym, name, sector, market, now, earningsMap = {}, todayStr = "") {
  if (!ch || !Array.isArray(ch.options)) return [];
  const spot = ch.current_price;
  const all = [];
  for (const o of ch.options) {
    const p = parseOcc(o.option); if (!p) continue;
    const dte = dteOf(p.y, p.mo, p.d, now);
    if (dte < 15 || dte > 45) continue;
    if (!isThirdFriday(p.y, p.mo, p.d)) continue;
    all.push({ ...o, type: p.type, strike: p.strike, dte, ek: `${p.y}-${String(p.mo).padStart(2,"0")}-${String(p.d).padStart(2,"0")}` });
  }
  if (!all.length) return [];

  const byExp = {}; all.forEach(o => { (byExp[o.ek] = byExp[o.ek] || []).push(o); });
  const width0 = widthFor(spot);
  const pickShort = (set, type) => { let b = null, bd = 9; for (const o of set) { if (o.type !== type) continue; const dl = o.delta; if (type === "C" && !(dl > 0.03 && dl <= 0.10)) continue; if (type === "P" && !(dl < -0.03 && dl >= -0.10)) continue; const dist = Math.abs(Math.abs(dl) - 0.10); if (dist < bd) { bd = dist; b = o; } } return b; };
  const nearest  = (set, type, target) => { let b = null, bd = Infinity; for (const o of set) { if (o.type !== type) continue; const d = Math.abs(o.strike - target); if (d < bd) { bd = d; b = o; } } return b; };

  const out = [];
  for (const ek of Object.keys(byExp)) {
    const set = byExp[ek];
    const monthlyOI = set.reduce((s, o) => s + (o.open_interest || 0), 0);
    const sc = pickShort(set, "C"), sp = pickShort(set, "P"); if (!sc || !sp) continue;
    const lc = nearest(set, "C", sc.strike + width0), lp = nearest(set, "P", sp.strike - width0); if (!lc || !lp) continue;
    const callW = +(lc.strike - sc.strike).toFixed(2), putW = +(sp.strike - lp.strike).toFixed(2);
    if (callW <= 0 || putW <= 0) continue;
    const width = Math.max(callW, putW);
    if (width < width0 * 0.5 || width > width0 * 2.5) continue;

    // v2: conservative credit (bid-side sell, ask-side buy) + midCredit
    const credit    = +(((bid(sc) + bid(sp)) - (ask(lc) + ask(lp)))).toFixed(2);
    const midCredit = +(((mid(sc) + mid(sp)) - (mid(lc) + mid(lp)))).toFixed(2);
    if (credit <= 0) continue;
    const roc = credit / (width - credit) * 100;
    if (roc < 5 || roc > 30) continue;

    const iv          = Math.max(ivPct(sc.iv), ivPct(sp.iv));
    const putDelta    = Math.abs(sp.delta), callDelta = Math.abs(sc.delta);
    const putProbOtm  = +(1 - putDelta).toFixed(3), callProbOtm = +(1 - callDelta).toFixed(3);
    const probOtm     = Math.min(putProbOtm, callProbOtm);
    // v2: spread = widest bid/ask across ALL FOUR legs (v1 only checked sc + sp)
    const spreadMax   = +Math.max(sc.ask - sc.bid, sp.ask - sp.bid, lc.ask - lc.bid, lp.ask - lp.bid).toFixed(2);

    const shortPutOI  = sp.open_interest || 0;
    const shortCallOI = sc.open_interest || 0;
    const longPutOI   = lp.open_interest || 0;
    const longCallOI  = lc.open_interest || 0;

    const erDate = earningsMap[sym] || null;
    const earnInWindow = !!(erDate && erDate >= todayStr && erDate <= ek);

    // v2 checks — 7 criteria, earnings surfaced separately (not a pass/fail gate)
    const checks = {
      roc:              roc >= 5 && roc <= 30,
      monthlyLiquidity: monthlyOI >= MIN_MONTHLY_OI,
      shortLegLiquidity: shortPutOI >= MIN_SHORT_LEG_OI && shortCallOI >= MIN_SHORT_LEG_OI,
      longLegLiquidity:  longPutOI >= MIN_LONG_LEG_OI  && longCallOI >= MIN_LONG_LEG_OI,
      iv:               iv >= 40,
      probOtm:          putProbOtm >= 0.90 && callProbOtm >= 0.90,
      spread:           spreadMax <= MAX_ALL_LEG_SPREAD
    };
    const misses = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    const passed = misses.length === 0;

    out.push({
      symbol: sym, name, sector, market: market || "both",
      iv: +iv.toFixed(1), hv: +iv.toFixed(1),
      earnings: earnInWindow, earningsDate: earnInWindow ? erDate : null, nextEarnings: erDate,
      dte: sc.dte, expiry: ek,
      credit, midCredit, width,
      probOtm: +probOtm.toFixed(3), putProbOtm, callProbOtm,
      shortDelta: +Math.max(putDelta, callDelta).toFixed(3),
      openInterest: monthlyOI, shortPutOI, shortCallOI, longPutOI, longCallOI,
      spreadMax, spot: +spot.toFixed(2),
      shortCall: sc.strike, shortPut: sp.strike, longCall: lc.strike, longPut: lp.strike,
      passed, score: Object.keys(checks).length - misses.length,
      note: passed ? "Matches primary filters ✓" : ("Needs review: " + misses.join(", "))
    });
  }
  return out;
}

async function writeBoard(store, state, earningsOk, complete) {
  const rows = state.rows.slice().sort((a, b) => (b.passed - a.passed) || (b.score - a.score) || (b.credit - a.credit));
  await store.setJSON("latest", {
    strategy: "SP500_Tight_Condor_Scan_v2",
    scanMode: "Live · Full S&P 500 + Nasdaq · CBOE EOD (delayed) · v2 framework" + (complete ? "" : " · building…"),
    dataSource: "CBOE free delayed/EOD quotes (interim — swap fetchSym() on paid API arrival)",
    generatedAt: new Date().toISOString(),
    universeCount: state.total, scanned: state.scanned, withCondor: rows.length,
    passCount: rows.filter(r => r.passed).length,
    earningsShield: earningsOk ? "active (Nasdaq calendar)" : "source unavailable — verify on platform",
    earningsFlagged: rows.filter(r => r.earnings).length,
    probabilityDisclosure: "Anchor-leg probability only; not guaranteed whole-condor probability.",
    building: !complete, progress: { scanned: state.scanned, total: state.total },
    results: rows
  }).catch(() => {});
}

export default async (req) => {
  const store = getStore("poppas-scan");
  const isContinue = (() => { try { return new URL(req.url).searchParams.get("continue") === "1"; } catch (_) { return false; } })();
  const t0 = Date.now();
  const d = new Date();
  const now = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const todayStr = new Date(now).toISOString().slice(0, 10);

  let state = await store.get("build", { type: "json" }).catch(() => null);

  if (!isContinue) {
    if (state && state.status === "running" && (Date.now() - new Date(state.updatedAt).getTime()) < 4 * 60 * 1000) {
      return json({ ok: true, note: "already running", scanned: state.scanned, total: state.total });
    }
    const universe = await loadUniverse();
    const earnings = await loadEarnings(90);
    state = { status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), total: universe.length, scanned: 0, pendingIdx: 0, universe, earnings, rows: [] };
    await store.setJSON("build", state);
  }
  if (!state) return json({ ok: false, note: "no state" });

  const { universe, earnings } = state;
  const earningsOk = Object.keys(earnings || {}).length > 0;

  while (state.pendingIdx < state.total && (Date.now() - t0) < MAX_RUN_MS) {
    const batch = universe.slice(state.pendingIdx, state.pendingIdx + CHUNK);
    const queue = [...batch];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const [sym, name, sector, market] = queue.shift();
        const ch = await fetchSym(sym);
        state.scanned++;
        if (ch) { for (const row of scanAll(ch, sym, name, sector, market, now, earnings, todayStr)) state.rows.push(row); }
        await sleep(120 + Math.random() * 260);
      }
    }));
    state.pendingIdx += batch.length;
    state.updatedAt = new Date().toISOString();
    await store.setJSON("build", state);
    await writeBoard(store, state, earningsOk, false);
  }

  if (state.pendingIdx >= state.total) {
    state.status = "complete"; state.updatedAt = new Date().toISOString();
    await store.setJSON("build", state);
    await writeBoard(store, state, earningsOk, true);
    return json({ ok: true, status: "complete", scanned: state.scanned, withCondor: state.rows.length });
  }

  const base = process.env.URL || process.env.DEPLOY_URL;
  if (base) { try { fetch(`${base}/.netlify/functions/scan-build-background?continue=1`, { method: "POST" }); } catch (_) {} }
  return json({ ok: true, status: "running", scanned: state.scanned, pendingIdx: state.pendingIdx, total: state.total });
};
