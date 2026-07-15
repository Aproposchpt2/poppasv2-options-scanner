// POPPAS PRO — daily scan, wired to a LIVE end-of-day options feed.
// INTERIM DATA SOURCE: CBOE free delayed/EOD quotes (no API key, no brokerage account).
//   https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json
// When Poppa's paid API key arrives, replace ONLY fetchSym() with that provider's adapter —
// the parsing, condor build, blueprint filters, and output shape all stay the same.
//
// Implements Poppa's SP500_Tight_Condor_Scan blueprint: ±0.10-delta short strikes, $5-wide,
// 15–45 DTE regular monthly, ROC 5%–10% default, monthly OI ≥ 10,000,
// short-leg OI reviewed separately, IV ≥ 40%, and ask−bid ≤ $0.05 across all four legs.
// Returns one row per name (passers first), shaped for the front-end.
// NOTE: the earnings shield (blueprint §4) needs an earnings-calendar source — CBOE doesn't
// carry it, so earnings is left for on-platform verification until that feed is wired.

// On-demand QUICK scan (~16 liquid names) — the front-end's instant fallback while the
// full S&P 500 board (scan-build-background.js → Netlify Blobs) is building. Not scheduled.

const WIDTH = 5;
const CONCURRENCY = 8;
const MIN_MONTHLY_OI = 10000;
const MIN_SHORT_LEG_OI = 500;
const MIN_LONG_LEG_OI = 100;
const MAX_ALL_LEG_SPREAD = 0.05;

// Interim universe: highly-liquid, optionable S&P 500 names (kept modest so an on-demand
// scan returns inside the function timeout). Swap to the full S&P 500 with the paid feed.
const UNIVERSE = [
  ["NVDA","NVIDIA","Technology","both"],["TSLA","Tesla","Consumer Disc.","both"],["AMD","Advanced Micro Devices","Technology","both"],
  ["AAPL","Apple","Technology","both"],["MSFT","Microsoft","Technology","both"],["META","Meta Platforms","Communications","both"],
  ["AMZN","Amazon","Consumer Disc.","both"],["GOOGL","Alphabet","Communications","both"],["AVGO","Broadcom","Technology","both"],
  ["NFLX","Netflix","Communications","both"],["MU","Micron","Technology","both"],["CRM","Salesforce","Technology","sp"],
  ["BA","Boeing","Industrials","sp"],["BAC","Bank of America","Financials","sp"],["F","Ford","Consumer Disc.","sp"],
  ["DIS","Walt Disney","Communications","sp"]
];

const cboeUrl = s => `https://cdn.cboe.com/api/global/delayed_quotes/options/${s}.json`;

// ---- DATA ADAPTER (the only thing that changes when the paid API key arrives) ----
async function fetchSym(sym) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(cboeUrl(sym), { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return j.data || j; // { symbol, current_price, options:[{option,bid,ask,iv,delta,open_interest,...}] }
  } catch (_) { return null; } finally { clearTimeout(t); }
}

const parseOcc = s => { const m = s.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/); return m ? { y: 2000 + +m[2], mo: +m[3], d: +m[4], type: m[5], strike: +m[6] / 1000 } : null; };
const dteOf = (y, mo, d, now) => Math.round((Date.UTC(y, mo - 1, d) - now) / 864e5);
const isThirdFriday = (y, mo, d) => { const x = new Date(Date.UTC(y, mo - 1, d)); return x.getUTCDay() === 5 && d >= 15 && d <= 21; };
const ivPct = v => (v > 1.5 ? v : v * 100); // CBOE iv is a decimal (0.42 = 42%)
// Wing width scaled to the stock's price — $5 baseline for the core $80–250 range.
const widthFor = spot => (spot < 250 ? 5 : 10);
function expectedMoveFields(spot, iv, dte, shortPut, shortCall) {
  const s = +spot, v = +iv, d = +dte;
  if (!Number.isFinite(s) || !Number.isFinite(v) || !Number.isFinite(d) || s <= 0 || v <= 0 || d <= 0) {
    return { expectedMove: null, expectedLow: null, expectedHigh: null, expectedMoveStatus: "Verify" };
  }
  const move = +(s * (v / 100) * Math.sqrt(d / 365)).toFixed(2);
  const low = +(s - move).toFixed(2);
  const high = +(s + move).toFixed(2);
  let status = "Review";
  const put = +shortPut, call = +shortCall;
  if (Number.isFinite(put) && Number.isFinite(call)) {
    const buffer = Math.max(move * 0.10, s * 0.005);
    if (put < low && call > high) status = "Outside EM";
    else if (put >= low + buffer || call <= high - buffer) status = "Inside EM";
    else status = "Near EM";
  }
  return { expectedMove: move, expectedLow: low, expectedHigh: high, expectedMoveStatus: status };
}

// Build the tightest ±0.10-delta, $5-wide condor in the nearest 15–45 DTE regular monthly.
function buildCondor(ch, now) {
  if (!ch || !Array.isArray(ch.options)) return null;
  const spot = ch.current_price;
  const rows = [];
  for (const o of ch.options) {
    const p = parseOcc(o.option); if (!p) continue;
    const dte = dteOf(p.y, p.mo, p.d, now);
    if (dte < 15 || dte > 45) continue;
    if (!isThirdFriday(p.y, p.mo, p.d)) continue; // regular monthly only
    rows.push({ ...o, type: p.type, strike: p.strike, dte, ek: `${p.y}-${String(p.mo).padStart(2,"0")}-${String(p.d).padStart(2,"0")}` });
  }
  if (!rows.length) return null;
  const byExp = {}; rows.forEach(o => { (byExp[o.ek] = byExp[o.ek] || []).push(o); });
  const exps = Object.keys(byExp).sort((a, b) => Math.abs(byExp[a][0].dte - 30) - Math.abs(byExp[b][0].dte - 30));
  const pickShort = (set, type) => {
    let best = null, bd = 9;
    for (const o of set) {
      if (o.type !== type) continue;
      const dl = o.delta;
      if (type === "C" && !(dl > 0.03 && dl <= 0.10)) continue;
      if (type === "P" && !(dl < -0.03 && dl >= -0.10)) continue;
      const dist = Math.abs(Math.abs(dl) - 0.10);
      if (dist < bd) { bd = dist; best = o; }
    }
    return best;
  };
  const width0 = widthFor(spot);
  const nearest = (set, type, target) => { let b = null, bd = Infinity; for (const o of set) { if (o.type !== type) continue; const d = Math.abs(o.strike - target); if (d < bd) { bd = d; b = o; } } return b; };
  for (const ek of exps) {
    const set = byExp[ek];
    const monthlyOI = set.reduce((s, o) => s + (o.open_interest || 0), 0); // OI of THIS monthly expiry only (all calls + puts)
    const sc = pickShort(set, "C"), sp = pickShort(set, "P");
    if (!sc || !sp) continue;
    const lc = nearest(set, "C", sc.strike + width0), lp = nearest(set, "P", sp.strike - width0);
    if (!lc || !lp) continue;
    const callW = +(lc.strike - sc.strike).toFixed(2), putW = +(sp.strike - lp.strike).toFixed(2);
    if (callW <= 0 || putW <= 0) continue;
    const width = Math.max(callW, putW);
    if (width < width0 * 0.5 || width > width0 * 2.5) continue;
    const bid = o => Number.isFinite(+o.bid) ? +o.bid : 0;
    const ask = o => Number.isFinite(+o.ask) ? +o.ask : 0;
    const mid = o => +( (bid(o) + ask(o)) / 2 ).toFixed(2);
    // Conservative credit: sell short legs at bid, buy wings at ask.
    const credit = +(((bid(sc) + bid(sp)) - (ask(lc) + ask(lp)))).toFixed(2);
    const midCredit = +(((mid(sc) + mid(sp)) - (mid(lc) + mid(lp)))).toFixed(2);
    if (credit <= 0) continue;
    const roc = credit / (width - credit) * 100;
    if (roc < 5 || roc > 30) continue; // broad sane band; front-end ROC slider filters to target (default 5–10%)
    const iv = Math.max(ivPct(sc.iv), ivPct(sp.iv));
    const em = expectedMoveFields(spot, iv, sc.dte, sp.strike, sc.strike);
    return {
      spot, dte: sc.dte, ek, sc, sp, lc, lp, credit, width,
      expectedMove: em.expectedMove, expectedLow: em.expectedLow, expectedHigh: em.expectedHigh, expectedMoveStatus: em.expectedMoveStatus,
      iv,
      oiMin: Math.min(sc.open_interest || 0, sp.open_interest || 0), monthlyOI,
      shortPutOI: sp.open_interest || 0, shortCallOI: sc.open_interest || 0,
      longPutOI: lp.open_interest || 0, longCallOI: lc.open_interest || 0,
      shortDelta: Math.max(Math.abs(sc.delta), Math.abs(sp.delta)),
      putDelta: Math.abs(sp.delta), callDelta: Math.abs(sc.delta), // anchor legs = short put & short call
      spreadMax: +Math.max(sc.ask - sc.bid, sp.ask - sp.bid, lc.ask - lc.bid, lp.ask - lp.bid).toFixed(2),
      midCredit
    };
  }
  return null;
}

export default async function handler() {
  const d = new Date();
  const now = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const queue = [...UNIVERSE];
  const results = [];

  async function worker() {
    while (queue.length) {
      const [sym, name, sector, market] = queue.shift();
      const c = buildCondor(await fetchSym(sym), now);
      if (!c) continue;
      const checks = {
        roc: c.credit / (c.width - c.credit) * 100 >= 5 && c.credit / (c.width - c.credit) * 100 <= 30,
        monthlyLiquidity: c.monthlyOI >= MIN_MONTHLY_OI,
        shortLegLiquidity: c.shortPutOI >= MIN_SHORT_LEG_OI && c.shortCallOI >= MIN_SHORT_LEG_OI,
        longLegLiquidity: c.longPutOI >= MIN_LONG_LEG_OI && c.longCallOI >= MIN_LONG_LEG_OI,
        iv: c.iv >= 40,
        probOtm: (1 - c.putDelta) >= 0.90 && (1 - c.callDelta) >= 0.90,
        spread: c.spreadMax <= MAX_ALL_LEG_SPREAD
      };
      const misses = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      const passed = misses.length === 0;
      results.push({
        symbol: sym, name, sector, market: market || "both",
        iv: +c.iv.toFixed(1), hv: +c.iv.toFixed(1), earnings: false,
        dte: c.dte, expiry: c.sc.ek, credit: c.credit, midCredit: c.midCredit, width: c.width,
        probOtm: +Math.min(1 - c.putDelta, 1 - c.callDelta).toFixed(3), putProbOtm: +(1 - c.putDelta).toFixed(3), callProbOtm: +(1 - c.callDelta).toFixed(3), shortDelta: +c.shortDelta.toFixed(3),
        openInterest: c.monthlyOI, shortPutOI: c.shortPutOI, shortCallOI: c.shortCallOI,
        longPutOI: c.longPutOI, longCallOI: c.longCallOI, spreadMax: +c.spreadMax.toFixed(2), spot: +c.spot.toFixed(2),
        expectedMove: c.expectedMove, expectedLow: c.expectedLow, expectedHigh: c.expectedHigh, expectedMoveStatus: c.expectedMoveStatus,
        shortCall: c.sc.strike, shortPut: c.sp.strike, longCall: c.lc.strike, longPut: c.lp.strike,
        passed, score: Object.keys(checks).length - misses.length,
        note: passed ? "Matches primary filters ✓" : ("Needs review: " + misses.join(", "))
      });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  results.sort((a, b) => (b.passed - a.passed) || (b.score - a.score) || (b.credit - a.credit));

  const body = {
    strategy: "SP500_Tight_Condor_Scan",
    scanMode: "Live · CBOE EOD (delayed)",
    dataSource: "CBOE free delayed/EOD quotes (interim — swap to paid API on key arrival)",
    generatedAt: new Date().toISOString(),
    universeCount: UNIVERSE.length,
    passCount: results.filter(r => r.passed).length,
    earningsShield: "verify before trade (no earnings calendar wired yet)",
    results
  };

  if (process.env.SCAN_WEBHOOK_URL) {
    try { await fetch(process.env.SCAN_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); } catch (_) {}
  }

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=900" }
  });
}
