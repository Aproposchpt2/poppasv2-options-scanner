// POPPA'S Option Scanner v3 — Supabase REST scanner candidate builder.
// Source: Schwab/TOS market-data-only option-chain endpoint.
// Backend ingestion rule: monthly third-Friday expirations only, DTE 0-45 only (temporary validation window).
// Scanner/Band Intake filters remain in scan-results-db.js.

const CHUNK = 24;
const CONCURRENCY = 4;
const MAX_RUN_MS = 55 * 1000;
const SP500_CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const STRATEGY = "SP500_Tight_Condor_Scan_v3_SchwabLive";
const SCAN_MODE = "Schwab live · Monthly option chain only · 0-45 DTE · Supabase persistence";
const DATA_SOURCE = "Schwab/TOS Market Data API; ingestion extracts monthly option-chain records with 0-45 DTE only using Pacific market-date calculation. All other filters are user Band Intake controls.";
const UPSTREAM_FILTERS_ONLY = ["Schwab live option chain", "Monthly third-Friday expiration", "0-45 DTE", "Duplicate structural record removal"];

const CURATED = [
  ["SPY","SPDR S&P 500 ETF","ETF","both"], ["QQQ","Invesco QQQ Trust","ETF","both"],
  ["NVDA","NVIDIA","Technology","both"],["TSLA","Tesla","Consumer Disc.","both"],["AMD","Advanced Micro Devices","Technology","both"],
  ["AAPL","Apple","Technology","both"],["MSFT","Microsoft","Technology","both"],["META","Meta Platforms","Communications","both"],
  ["AMZN","Amazon","Consumer Disc.","both"],["GOOGL","Alphabet","Communications","both"],["AVGO","Broadcom","Technology","both"],
  ["NFLX","Netflix","Communications","both"],["MU","Micron","Technology","both"],["QCOM","Qualcomm","Technology","both"],
  ["COST","Costco","Consumer Staples","both"],["COIN","Coinbase","Financials","both"],["MSTR","Strategy","Technology","ndx"]
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hasNum = v => Number.isFinite(Number(v));
const num = v => hasNum(v) ? Number(v) : null;
const round2 = v => hasNum(v) ? Number(Number(v).toFixed(2)) : null;
const bid = o => num(o.bid) ?? 0;
const ask = o => num(o.ask) ?? 0;
const mark = o => num(o.mark) ?? ((bid(o) + ask(o)) / 2);

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function sbConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return { url: url.replace(/\/$/, ""), key };
}

async function sbFetch(path, opts = {}) {
  const { url, key } = sbConfig();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} failed ${res.status}: ${text}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json") && text) return { data: JSON.parse(text), headers: res.headers };
  return { data: text, headers: res.headers };
}

async function sbCount(table, filter = "") {
  const suffix = `${table}?select=id${filter ? `&${filter}` : ""}`;
  const { headers } = await sbFetch(suffix, { method: "HEAD", headers: { Prefer: "count=exact" } });
  const cr = headers.get("content-range") || "";
  const m = cr.match(/\/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function parseCsvLine(ln) {
  const r = []; let cur = "", q = false;
  for (const ch of ln) { if (ch === '"') q = !q; else if (ch === "," && !q) { r.push(cur); cur = ""; } else cur += ch; }
  r.push(cur); return r;
}

async function loadUniverse() {
  try {
    const r = await fetch(SP500_CSV);
    if (!r.ok) throw new Error("csv " + r.status);
    const lines = (await r.text()).split(/\r?\n/).filter(Boolean);
    lines.shift();
    const seen = new Set(), uni = [];
    for (const c of CURATED) { uni.push(c); seen.add(c[0]); }
    for (const ln of lines) {
      const f = parseCsvLine(ln);
      const sym = (f[0] || "").trim().toUpperCase();
      if (!sym || sym.includes(".") || seen.has(sym)) continue;
      seen.add(sym);
      uni.push([sym, (f[1] || sym).trim(), (f[2] || "S&P 500").trim(), "sp"]);
    }
    return uni;
  } catch (_) { return CURATED; }
}

async function loadEarnings(days = 90) {
  const map = {}, base = Date.now(), queue = [];
  for (let i = 0; i <= days; i++) queue.push(pacificDateString(i, base));
  async function worker() {
    while (queue.length) {
      const d = queue.shift();
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch("https://api.nasdaq.com/api/calendar/earnings?date=" + d, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json, text/plain, */*" }, signal: ctrl.signal });
        if (r.ok) { const j = await r.json(); for (const row of ((j.data && j.data.rows) || [])) { const s = (row.symbol || "").toUpperCase().trim(); if (s && (!map[s] || d < map[s])) map[s] = d; } }
      } catch (_) {} finally { clearTimeout(t); }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return map;
}

function baseUrl(req) {
  try { const u = new URL(req.url); return process.env.URL || process.env.DEPLOY_URL || `${u.protocol}//${u.host}`; }
  catch (_) { return process.env.URL || process.env.DEPLOY_URL || ""; }
}

function ymdFromDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function pacificDateString(addDays = 0, baseMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(baseMs));
  const y = Number(parts.find(p => p.type === "year")?.value);
  const m = Number(parts.find(p => p.type === "month")?.value);
  const d = Number(parts.find(p => p.type === "day")?.value);
  const utc = new Date(Date.UTC(y, m - 1, d + Number(addDays || 0)));
  return ymdFromDate(utc);
}

function offsetDate(days) { return pacificDateString(days); }

function dteOf(expiry) {
  if (!expiry) return null;
  const today = pacificDateString(0);
  const [ty, tm, td] = today.split("-").map(Number);
  const [ey, em, ed] = String(expiry).slice(0, 10).split("-").map(Number);
  if (![ty, tm, td, ey, em, ed].every(Number.isFinite)) return null;
  const now = Date.UTC(ty, tm - 1, td);
  const exp = Date.UTC(ey, em - 1, ed);
  return Math.round((exp - now) / 864e5);
}

function isThirdFriday(expiry) {
  const d = new Date(`${expiry}T00:00:00Z`);
  const day = d.getUTCDate();
  return d.getUTCDay() === 5 && day >= 15 && day <= 21;
}

function flattenContracts(mapLike = {}, optionType = "") {
  const rows = [];
  for (const [expKey, strikeMap] of Object.entries(mapLike || {})) {
    for (const contracts of Object.values(strikeMap || {})) {
      for (const contract of Array.isArray(contracts) ? contracts : []) rows.push({ contract, expKey, optionType });
    }
  }
  return rows;
}

function expiryOf(contract, expKey) {
  if (contract.expirationDate) return String(contract.expirationDate).slice(0, 10);
  const k = String(expKey || "").split(":")[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(k) ? k : null;
}

function schwabOptionRows(chain) {
  const spot = num(chain.underlyingPrice) ?? num(chain.underlying?.last) ?? num(chain.underlying?.mark);
  if (!spot) return [];
  const rows = [];
  const items = [...flattenContracts(chain.callExpDateMap, "C"), ...flattenContracts(chain.putExpDateMap, "P")];
  for (const item of items) {
    const c = item.contract || {};
    const expiry = expiryOf(c, item.expKey);
    const dte = dteOf(expiry);
    if (!expiry || dte < 15 || dte > 45 || !isThirdFriday(expiry)) continue;
    const type = c.putCall === "CALL" ? "C" : c.putCall === "PUT" ? "P" : item.optionType;
    const strike = num(c.strikePrice);
    if (!type || !strike) continue;
    rows.push({ ...c, type, strike, dte, ek: expiry, spot, option: c.symbol || c.description, schwabDaysToExpiration: c.daysToExpiration ?? null });
  }
  return rows;
}

async function fetchSchwabChain(req, sym) {
  const base = baseUrl(req);
  if (!base) throw new Error("No base URL available for Schwab option-chain call.");
  const u = new URL(`${base}/.netlify/functions/schwab-option-chain`);
  u.searchParams.set("symbol", sym);
  u.searchParams.set("range", "NTM");
  u.searchParams.set("strikeCount", "40");
  u.searchParams.set("includeQuotes", "TRUE");
  u.searchParams.set("fromDate", offsetDate(15));
  u.searchParams.set("toDate", offsetDate(45));
  u.searchParams.set("includeRaw", "true");
  const r = await fetch(u.toString(), { method: "GET", headers: { accept: "application/json" } });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.ok || !body?.rawOptionChain) return null;
  return body.rawOptionChain;
}

function nearestByStrike(set, type, target) {
  let b = null, bd = Infinity;
  for (const o of set) { if (o.type !== type) continue; const d = Math.abs(o.strike - target); if (d < bd) { bd = d; b = o; } }
  return b;
}

function widthsFor(spot) { return spot < 250 ? [5, 10] : [10, 5]; }

function expectedMoveFields(spot, iv, dte, shortPut, shortCall) {
  const s = +spot, v = +iv, d = +dte;
  if (!Number.isFinite(s) || !Number.isFinite(v) || !Number.isFinite(d) || s <= 0 || v <= 0 || d <= 0) return { expectedMove: null, expectedLow: null, expectedHigh: null, expectedMoveStatus: "Verify" };
  const move = +(s * (v / 100) * Math.sqrt(d / 365)).toFixed(2);
  const low = +(s - move).toFixed(2);
  const high = +(s + move).toFixed(2);
  let status = "Review";
  if (Number.isFinite(+shortPut) && Number.isFinite(+shortCall)) {
    const buffer = Math.max(move * 0.10, s * 0.005);
    if (+shortPut < low && +shortCall > high) status = "Outside EM";
    else if (+shortPut >= low + buffer || +shortCall <= high - buffer) status = "Inside EM";
    else status = "Near EM";
  }
  return { expectedMove: move, expectedLow: low, expectedHigh: high, expectedMoveStatus: status };
}

function qualityScore(x) {
  return [x.roc >= 5 && x.roc <= 10, x.probOtm >= 0.90, x.iv >= 30, x.monthlyOI >= 10000, x.shortPutOI >= 1 && x.shortCallOI >= 1, x.spreadMax <= 0.25, !x.earnInWindow, x.expectedMoveStatus === "Outside EM", x.credit > 0, x.width > 0].filter(Boolean).length;
}

function scanAll(chain, sym, name, sector, market, earningsMap = {}, todayStr = "") {
  const monthly = schwabOptionRows(chain);
  if (!monthly.length) return [];
  const spot = monthly[0].spot;
  const byExp = {}; monthly.forEach(o => { (byExp[o.ek] = byExp[o.ek] || []).push(o); });
  const out = [];
  for (const ek of Object.keys(byExp)) {
    const set = byExp[ek];
    const monthlyOI = set.reduce((s, o) => s + (num(o.openInterest) || 0), 0);
    const calls = set.filter(o => o.type === "C" && o.strike > spot && (1 - Math.abs(num(o.delta) || 0)) >= 0.70).sort((a,b) => a.strike - b.strike);
    const puts = set.filter(o => o.type === "P" && o.strike < spot && (1 - Math.abs(num(o.delta) || 0)) >= 0.70).sort((a,b) => b.strike - a.strike);
    const erDate = earningsMap[sym] || null;
    const earnInWindow = !!(erDate && erDate >= todayStr && erDate <= ek);
    for (const widthTarget of widthsFor(spot)) {
      const putStructures = [], callStructures = [];
      for (const sp of puts) { const lp = nearestByStrike(set, "P", sp.strike - widthTarget); if (lp && lp.strike < sp.strike) putStructures.push({ sp, lp }); }
      for (const sc of calls) { const lc = nearestByStrike(set, "C", sc.strike + widthTarget); if (lc && lc.strike > sc.strike) callStructures.push({ sc, lc }); }
      const widthOut = [];
      for (const ps of putStructures) for (const cs of callStructures) {
        const { sp, lp } = ps, { sc, lc } = cs;
        const callW = +(lc.strike - sc.strike).toFixed(2), putW = +(sp.strike - lp.strike).toFixed(2);
        if (callW <= 0 || putW <= 0) continue;
        const width = Math.max(callW, putW);
        const credit = round2((bid(sc) + bid(sp)) - (ask(lc) + ask(lp)));
        const midCredit = round2((mark(sc) + mark(sp)) - (mark(lc) + mark(lp)));
        const maxRisk = Number.isFinite(width - credit) ? round2(width - credit) : null;
        const roc = Number.isFinite(maxRisk) && maxRisk > 0 ? +(credit / maxRisk * 100).toFixed(2) : -999;
        const ivRaw = Math.max(num(sc.volatility) || 0, num(sp.volatility) || 0);
        const iv = ivRaw > 1.5 ? ivRaw : +(ivRaw * 100).toFixed(2); // convert decimal to % (e.g. 0.35 → 35)
        const putDelta = Math.abs(num(sp.delta) || 0), callDelta = Math.abs(num(sc.delta) || 0);
        const putProbOtm = +(1 - putDelta).toFixed(3), callProbOtm = +(1 - callDelta).toFixed(3);
        const probOtm = +Math.min(putProbOtm, callProbOtm).toFixed(3);
        const spreadMax = +Math.max(ask(sc) - bid(sc), ask(sp) - bid(sp), ask(lc) - bid(lc), ask(lp) - bid(lp)).toFixed(2);
        const shortPutOI = num(sp.openInterest) || 0, shortCallOI = num(sc.openInterest) || 0;
        const longPutOI = num(lp.openInterest) || 0, longCallOI = num(lc.openInterest) || 0;
        const em = expectedMoveFields(spot, iv, sc.dte, sp.strike, sc.strike);
        const score = qualityScore({ roc, probOtm, iv, monthlyOI, shortPutOI, shortCallOI, spreadMax, earnInWindow, expectedMoveStatus: em.expectedMoveStatus, credit, width });
        widthOut.push({ symbol: sym, name, sector, market: market || "both", spot: round2(spot), iv: round2(iv), hv: round2(iv), dte: sc.dte, expiry: ek, earnings: earnInWindow, earnings_date: earnInWindow ? erDate : null, next_earnings: erDate, short_put: sp.strike, long_put: lp.strike, short_call: sc.strike, long_call: lc.strike, credit, mid_credit: midCredit, width, max_risk: maxRisk, roc, prob_otm: probOtm, put_prob_otm: putProbOtm, call_prob_otm: callProbOtm, short_delta: +Math.max(putDelta, callDelta).toFixed(3), open_interest: monthlyOI, short_put_oi: shortPutOI, short_call_oi: shortCallOI, long_put_oi: longPutOI, long_call_oi: longCallOI, spread_max: spreadMax, expected_move: em.expectedMove, expected_low: em.expectedLow, expected_high: em.expectedHigh, expected_move_status: em.expectedMoveStatus, passed: true, score, review_status: "Raw Schwab monthly-chain candidate — apply Band Intake filters", note: "Raw Schwab candidate. User Band Intake values determine display eligibility.", raw_chain_eligible: true, raw_chain_rule: "Schwab live monthly third-Friday expiration, 0-45 DTE only using Pacific market date", source_payload: { symbol: sym, option_put_short: sp.option, option_put_long: lp.option, option_call_short: sc.option, option_call_long: lc.option, schwab_dte_put: sp.schwabDaysToExpiration, schwab_dte_call: sc.schwabDaysToExpiration } });
      }
      // Dedup: keep the highest-score (Blueprint fit) condor per width,
      // then ROC as tiebreaker. Score counts Blueprint criteria met.
      if (widthOut.length) {
        widthOut.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.roc ?? -999) - (a.roc ?? -999));
        out.push(widthOut[0]);
      }
    }
  }
  return out;
}

function candidateKey(r) { return [r.scan_run_id, r.symbol, r.expiry, r.short_put, r.long_put, r.short_call, r.long_call, r.width].join("|"); }

async function insertRows(scanRunId, rows) {
  if (!rows.length) return 0;
  // Layer 1: exact-key dedup (same 8-field combo)
  const seen = new Map();
  for (const r of rows) { const mapped = { ...r, scan_run_id: scanRunId }; seen.set(candidateKey(mapped), mapped); }
  // Layer 2: best-ROC dedup per (symbol, expiry, width)
  const best = new Map();
  for (const r of seen.values()) {
    const gk = [r.scan_run_id, r.symbol, r.expiry, r.width].join("|");
    const ex = best.get(gk);
    const rScore = r.score ?? 0, eScore = ex?.score ?? 0;
    if (!ex || rScore > eScore || (rScore === eScore && (r.roc ?? -999) > (ex.roc ?? -999))) best.set(gk, r);
  }
  const mapped = Array.from(best.values());
  for (let i = 0; i < mapped.length; i += 500) {
    await sbFetch("scan_candidates?on_conflict=scan_run_id,symbol,expiry,short_put,long_put,short_call,long_call,width", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(mapped.slice(i, i + 500)) });
  }
  return mapped.length;
}

async function candidateCount(scanRunId) { return sbCount("scan_candidates", `scan_run_id=eq.${encodeURIComponent(scanRunId)}`); }

async function createRun() {
  const universe = await loadUniverse();
  const earnings = await loadEarnings(90);
  const body = [{ strategy: STRATEGY, status: "running", scan_mode: SCAN_MODE, data_source: DATA_SOURCE, universe_count: universe.length, scanned_count: 0, candidate_count: 0, pass_count: 0, pending_index: 0, metadata: { universe, earnings, createdBy: "scan-build-db-schwab-live", backendFiltersRemoved: true, upstreamFiltersOnly: UPSTREAM_FILTERS_ONLY, marketDate: pacificDateString(0), fromDate: offsetDate(0), toDate: offsetDate(45), dteBasis: "America/Los_Angeles market date" } }];
  const { data } = await sbFetch("scan_runs?select=*", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
  return data[0];
}

async function latestActiveRun() { const { data } = await sbFetch(`scan_runs?select=*&strategy=eq.${encodeURIComponent(STRATEGY)}&status=in.(running,stale)&order=started_at.desc&limit=1`); return Array.isArray(data) ? data[0] : null; }
async function loadRun(restart) { if (restart) return createRun(); const active = await latestActiveRun(); return active || createRun(); }
async function updateRun(id, updates) { await sbFetch(`scan_runs?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(updates) }); }

export default async (req) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const restart = url.searchParams.get("restart") === "1" || url.searchParams.get("action") === "restart";
  let run;
  try { run = await loadRun(restart); } catch (err) { return json({ ok: false, error: String(err?.message || err) }, 500); }
  let universe = Array.isArray(run.metadata?.universe) ? run.metadata.universe : null;
  let earnings = run.metadata?.earnings || null;
  if (!universe) universe = await loadUniverse();
  if (!earnings) earnings = await loadEarnings(90);
  const todayStr = pacificDateString(0);
  let pending = Math.max(0, Number(run.pending_index || 0));
  let scanned = Math.max(0, Number(run.scanned_count || 0));
  const total = universe.length;
  let lastBatchRows = 0, lastInsertedRows = 0, batchesProcessed = 0;
  try {
    while (pending < total && (Date.now() - t0) < MAX_RUN_MS) {
      const batch = universe.slice(pending, pending + CHUNK);
      const queue = [...batch];
      const allRows = [];
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, async () => {
        while (queue.length) {
          const [sym, name, sector, market] = queue.shift();
          const ch = await fetchSchwabChain(req, sym);
          scanned++;
          if (ch) allRows.push(...scanAll(ch, sym, name, sector, market, earnings, todayStr));
          await sleep(100 + Math.random() * 180);
        }
      }));
      lastInsertedRows = allRows.length ? await insertRows(run.id, allRows) : 0;
      lastBatchRows = allRows.length;
      pending += batch.length;
      batchesProcessed++;
      const count = await candidateCount(run.id);
      await updateRun(run.id, { status: pending >= total ? "completed" : "running", universe_count: total, scanned_count: scanned, pending_index: pending, candidate_count: count, pass_count: count, completed_at: pending >= total ? new Date().toISOString() : null, error: null, metadata: { ...(run.metadata || {}), universe, earnings, backendFiltersRemoved: true, upstreamFiltersOnly: UPSTREAM_FILTERS_ONLY, marketDate: todayStr, fromDate: offsetDate(0), toDate: offsetDate(45), dteBasis: "America/Los_Angeles market date", batchSize: CHUNK, concurrency: CONCURRENCY, batchesProcessed, lastSymbolBatchSize: batch.length, lastGeneratedRows: lastBatchRows, lastInsertedRows, lastContinuationAt: new Date().toISOString() } });
    }
  } catch (err) {
    try { await updateRun(run.id, { status: "failed", error: String(err?.message || err) }); } catch (_) {}
    return json({ ok: false, scanRunId: run.id, error: String(err?.message || err) }, 500);
  }
  const complete = pending >= total;
  if (!complete) {
    const base = baseUrl(req);
    if (base) { try { fetch(`${base}/.netlify/functions/scan-build-db?continue=1&scanRunId=${encodeURIComponent(run.id)}`, { method: "POST" }); } catch (_) {} }
  }
  const count = await candidateCount(run.id);
  return json({ ok: true, scanRunId: run.id, status: complete ? "completed" : "running", scanned, total, pendingIndex: pending, candidateCount: count || 0, lastBatchRows, lastInsertedRows, batchesProcessed, backendFiltersRemoved: true, upstreamFiltersOnly: UPSTREAM_FILTERS_ONLY, dataSource: "Schwab/TOS Market Data API", marketDataOnly: true, tokenReturnedToFrontend: false, accountDataReturnedToFrontend: false, dteBasis: "America/Los_Angeles market date", marketDate: todayStr, fromDate: offsetDate(0), toDate: offsetDate(45), framework: "v3 Schwab live monthly-chain first · Supabase REST persistence" });
};
