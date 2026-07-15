// POPPA'S Option Scanner v3 — Schwab/TOS market-data-first scan builder.
// Data lineage rule: preserve Schwab raw values, label POPPA-calculated values, and do not use CBOE for the active board.

import { getStore } from "@netlify/blobs";

const CHUNK = 10;
const CONCURRENCY = 2;
const MAX_RUN_MS = 12 * 60 * 1000;
const SP500_CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const DEFAULT_TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const DEFAULT_API_BASE_URL = "https://api.schwabapi.com";
const OPTION_CHAIN_PATH = "/marketdata/v1/chains";
const TOKEN_STORE_NAME = process.env.SCHWAB_TOKEN_STORE_NAME || "schwab-oauth";
const TOKEN_STORE_KEY = process.env.SCHWAB_TOKEN_STORE_KEY || "latest-token";

const MIN_MONTHLY_OI = 10000;
const MIN_SHORT_LEG_OI = 500;
const MIN_LONG_LEG_OI = 100;
const MAX_ALL_LEG_SPREAD = 0.05;

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

const BLOCKED_TERMS = ["account", "accounts", "acct_activity", "accountactivity", "accountnumber", "accounthash", "hashvalue", "balance", "balances", "position", "positions", "order", "orders", "transaction", "transactions", "trade", "trading"];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = o => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
const hasNum = v => Number.isFinite(+v);
const toNumber = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const bid = o => hasNum(o.bidRaw) ? +o.bidRaw : 0;
const ask = o => hasNum(o.askRaw) ? +o.askRaw : 0;
const mark = o => hasNum(o.markRaw) ? +o.markRaw : (bid(o) || ask(o) ? +((bid(o) + ask(o)) / 2).toFixed(2) : 0);
const round2 = n => Number.isFinite(+n) ? +(+n).toFixed(2) : null;
const widthsFor = spot => spot < 250 ? [5, 10] : [10, 5];
const ivPct = v => { const n = toNumber(v); return n === null ? null : (n > 1.5 ? n : n * 100); };

function getEnv(name, fallback = "") { return (process.env[name] || fallback || "").trim(); }
function assertNoBlockedTerms(value, label = "value") {
  const text = String(value || "").toLowerCase();
  const matched = BLOCKED_TERMS.find(term => text.includes(term));
  if (matched) { const error = new Error(`Blocked ${label}: market-data-only function cannot reference ${matched}.`); error.status = 403; throw error; }
}
function assertMarketDataOnlyConfig() {
  if (getEnv("SCHWAB_ACCOUNT_ACCESS_ENABLED") === "true" || getEnv("SCHWAB_TRADING_ACCESS_ENABLED") === "true") {
    const error = new Error("Blocked: Schwab account/trading access flags must not be enabled for POPPA'S market-data-only setup."); error.status = 403; throw error;
  }
}
function requireEnv(names) {
  const missing = names.filter(name => !getEnv(name));
  if (missing.length) { const error = new Error(`Missing required environment variable(s): ${missing.join(", ")}`); error.status = 500; error.safeDetails = { missingEnv: missing }; throw error; }
}
function basicAuthHeader() { return `Basic ${Buffer.from(`${getEnv("SCHWAB_CLIENT_ID")}:${getEnv("SCHWAB_CLIENT_SECRET")}`, "utf8").toString("base64")}`; }

async function readStoredTokenRecord() {
  try { const store = getStore(TOKEN_STORE_NAME); const stored = await store.get(TOKEN_STORE_KEY); return stored ? JSON.parse(stored) : null; } catch (_) { return null; }
}
async function writeStoredTokenRecord(existingRecord = {}, tokenResponse = {}) {
  const receivedAt = new Date();
  const expiresIn = Number(tokenResponse.expires_in || 0);
  const tokenRecord = {
    ...existingRecord, provider: "schwab", marketDataOnly: true,
    token_type: tokenResponse.token_type || existingRecord.token_type || "Bearer",
    access_token: tokenResponse.access_token || existingRecord.access_token || null,
    refresh_token: tokenResponse.refresh_token || existingRecord.refresh_token || null,
    expires_in: tokenResponse.expires_in || existingRecord.expires_in || null,
    scope: tokenResponse.scope || existingRecord.scope || null,
    received_at: receivedAt.toISOString(),
    access_token_expires_at: expiresIn > 0 ? new Date(receivedAt.getTime() + expiresIn * 1000).toISOString() : null,
    tokenReturnedToFrontend: false, accountDataReturnedToFrontend: false
  };
  const store = getStore(TOKEN_STORE_NAME);
  await store.set(TOKEN_STORE_KEY, JSON.stringify(tokenRecord));
  return tokenRecord;
}
async function resolveRefreshToken() {
  const storedRecord = await readStoredTokenRecord();
  if (storedRecord?.refresh_token) return { refreshToken: storedRecord.refresh_token, source: "netlify_blob_store", storedRecord };
  const envToken = getEnv("SCHWAB_REFRESH_TOKEN");
  if (envToken) return { refreshToken: envToken, source: "env", storedRecord: null };
  return { refreshToken: "", source: "missing", storedRecord };
}
async function refreshAccessToken() {
  requireEnv(["SCHWAB_CLIENT_ID", "SCHWAB_CLIENT_SECRET", "SCHWAB_TOKEN_URL"]);
  assertMarketDataOnlyConfig();
  const resolved = await resolveRefreshToken();
  if (!resolved.refreshToken) { const error = new Error("Missing refresh token. Complete Schwab authorization or configure SCHWAB_REFRESH_TOKEN."); error.status = 400; error.safeDetails = { tokenSource: resolved.source }; throw error; }
  const tokenUrl = getEnv("SCHWAB_TOKEN_URL", DEFAULT_TOKEN_URL);
  assertNoBlockedTerms(tokenUrl, "token URL");
  const response = await fetch(tokenUrl, { method: "POST", headers: { "Authorization": basicAuthHeader(), "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: resolved.refreshToken }) });
  const rawText = await response.text();
  let parsed; try { parsed = rawText ? JSON.parse(rawText) : {}; } catch (_) { parsed = {}; }
  if (!response.ok || !parsed.access_token) { const error = new Error("Unable to refresh Schwab access token."); error.status = response.status || 500; error.safeDetails = { status: response.status, statusText: response.statusText, schwabError: parsed.error || null, schwabErrorDescription: parsed.error_description || null, tokenSource: resolved.source }; throw error; }
  if (resolved.source === "netlify_blob_store" || parsed.refresh_token) await writeStoredTokenRecord(resolved.storedRecord || {}, { ...parsed, refresh_token: parsed.refresh_token || resolved.refreshToken });
  return parsed.access_token;
}

let cachedAccessToken = null;
async function getAccessToken() {
  if (!cachedAccessToken) cachedAccessToken = await refreshAccessToken();
  return cachedAccessToken;
}

function parseCsvLine(ln) { const r = []; let cur = "", q = false; for (const ch of ln) { if (ch === '"') q = !q; else if (ch === "," && !q) { r.push(cur); cur = ""; } else cur += ch; } r.push(cur); return r; }
async function loadUniverse() {
  try {
    const r = await fetch(SP500_CSV);
    if (!r.ok) throw new Error("csv " + r.status);
    const lines = (await r.text()).split(/\r?\n/).filter(Boolean); lines.shift();
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
  await Promise.all(Array.from({ length: 6 }, worker));
  return map;
}

function normalizeSymbol(symbol) {
  const normalized = String(symbol || "").trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(normalized)) throw new Error("Invalid symbol " + symbol);
  return normalized;
}

async function fetchSchwabSym(sym, tries = 2) {
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      requireEnv(["SCHWAB_API_BASE_URL"]);
      const accessToken = await getAccessToken();
      const apiBase = getEnv("SCHWAB_API_BASE_URL", DEFAULT_API_BASE_URL).replace(/\/+$/, "");
      assertNoBlockedTerms(apiBase, "API base URL");
      const u = new URL(`${apiBase}${OPTION_CHAIN_PATH}`);
      u.searchParams.set("symbol", normalizeSymbol(sym));
      u.searchParams.set("contractType", "ALL");
      u.searchParams.set("includeQuotes", "TRUE");
      u.searchParams.set("includeUnderlyingQuote", "TRUE");
      u.searchParams.set("strategy", "SINGLE");
      u.searchParams.set("range", "NTM");
      u.searchParams.set("strikeCount", "50");
      const r = await fetch(u.toString(), { headers: { "Authorization": `Bearer ${accessToken}`, "Accept": "application/json" }, signal: ctrl.signal });
      const text = await r.text();
      if (r.ok) { clearTimeout(t); return text ? JSON.parse(text) : null; }
      if (r.status === 401 && i === 0) cachedAccessToken = null;
    } catch (_) { cachedAccessToken = null; } finally { clearTimeout(t); }
    await sleep(450 + Math.random() * 350);
  }
  return null;
}

function dteOfDate(dateStr, now) {
  const date = String(dateStr || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - now) / 864e5);
}
function isThirdFridayDate(dateStr) {
  const date = String(dateStr || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, d));
  return x.getUTCDay() === 5 && d >= 15 && d <= 21;
}
function pickFirstDefined(object, keys) { if (!object || typeof object !== "object") return undefined; for (const key of keys) if (object[key] !== undefined && object[key] !== null) return object[key]; return undefined; }
function contractsFromMap(mapLike, side) {
  const out = [];
  for (const [expirationKey, strikes] of Object.entries(mapLike || {})) {
    const expDate = String(expirationKey).split(":")[0];
    for (const [strikeKey, contracts] of Object.entries(strikes || {})) {
      for (const c of Array.isArray(contracts) ? contracts : []) out.push(sanitizeContract(c, side, expDate, strikeKey, expirationKey));
    }
  }
  return out;
}
function sanitizeContract(c = {}, side, expDate, strikeKey, expirationKey) {
  const strike = toNumber(c.strikePrice ?? strikeKey);
  return {
    raw: c,
    symbol: c.symbol || null,
    description: c.description || null,
    type: String(c.putCall || side || "").toUpperCase().startsWith("P") ? "P" : "C",
    expirationDate: c.expirationDate || expDate,
    expirationKey,
    dte: toNumber(c.daysToExpiration),
    strike,
    bidRaw: toNumber(c.bid),
    askRaw: toNumber(c.ask),
    markRaw: toNumber(c.mark),
    lastRaw: toNumber(c.last),
    volumeRaw: toNumber(c.totalVolume ?? c.volume),
    openInterestRaw: toNumber(c.openInterest),
    deltaRaw: toNumber(c.delta),
    gammaRaw: toNumber(c.gamma),
    thetaRaw: toNumber(c.theta),
    vegaRaw: toNumber(c.vega),
    rhoRaw: toNumber(c.rho),
    volatilityRaw: toNumber(c.volatility),
    theoreticalOptionValueRaw: toNumber(c.theoreticalOptionValue),
    theoreticalVolatilityRaw: toNumber(c.theoreticalVolatility),
    probabilityOTMRaw: toNumber(pickFirstDefined(c, ["probabilityOTM", "probabilityOtm", "probOTM", "probOtm", "probabilityOutOfTheMoney", "pOTM"])),
    quoteTimeRaw: c.quoteTimeInLong || null,
    tradeTimeRaw: c.tradeTimeInLong || null
  };
}
function nearestByStrike(set, type, target) {
  let b = null, bd = Infinity;
  for (const o of set) { if (o.type !== type) continue; const d = Math.abs(o.strike - target); if (d < bd) { bd = d; b = o; } }
  return b;
}
function expectedMoveFields(spot, iv, dte, shortPut, shortCall, chainExpectedMoveRaw) {
  const s = +spot, v = +iv, d = +dte;
  let source = chainExpectedMoveRaw !== null && chainExpectedMoveRaw !== undefined ? "Schwab raw" : "POPPA calculated";
  let method = source === "Schwab raw" ? "Schwab/TOS API-provided expected move" : "Underlying Price × IV × sqrt(DTE / 365)";
  let fallbackReason = source === "Schwab raw" ? null : "Schwab expected move unavailable";
  if (!Number.isFinite(s) || !Number.isFinite(v) || !Number.isFinite(d) || s <= 0 || v <= 0 || d <= 0) return { expectedMove: chainExpectedMoveRaw ?? null, expectedLow: null, expectedHigh: null, expectedMoveStatus: "Verify", expectedMoveSource: source, expectedMoveMethod: method, expectedMoveFallbackReason: fallbackReason };
  const move = chainExpectedMoveRaw !== null && chainExpectedMoveRaw !== undefined ? +chainExpectedMoveRaw : +(s * (v / 100) * Math.sqrt(d / 365)).toFixed(2);
  const low = +(s - move).toFixed(2), high = +(s + move).toFixed(2);
  let status = "Review";
  const put = +shortPut, call = +shortCall;
  if (Number.isFinite(put) && Number.isFinite(call)) {
    const buffer = Math.max(move * 0.10, s * 0.005);
    if (put < low && call > high) status = "Outside EM";
    else if (put >= low + buffer || call <= high - buffer) status = "Inside EM";
    else status = "Near EM";
  }
  return { expectedMove: move, expectedLow: low, expectedHigh: high, expectedMoveStatus: status, expectedMoveSource: source, expectedMoveMethod: method, expectedMoveFallbackReason: fallbackReason };
}
function lineage(rawValue, displayValue, source, method, asOf = null, fallbackReason = null) { return { rawValue, displayValue, source, method, asOf, fallbackReason }; }

function rawLeg(o) {
  return {
    contractSymbol: o.symbol, expirationDate: o.expirationDate, strike: o.strike, type: o.type,
    bidRaw: o.bidRaw, askRaw: o.askRaw, markRaw: o.markRaw, lastRaw: o.lastRaw, volumeRaw: o.volumeRaw, openInterestRaw: o.openInterestRaw,
    deltaRaw: o.deltaRaw, gammaRaw: o.gammaRaw, thetaRaw: o.thetaRaw, vegaRaw: o.vegaRaw, rhoRaw: o.rhoRaw,
    volatilityRaw: o.volatilityRaw, probabilityOTMRaw: o.probabilityOTMRaw, quoteTimeRaw: o.quoteTimeRaw, tradeTimeRaw: o.tradeTimeRaw,
    source: "Schwab raw"
  };
}

function scanAll(chain, sym, name, sector, market, now, earningsMap = {}, todayStr = "") {
  if (!chain || typeof chain !== "object") return [];
  const spot = toNumber(chain.underlyingPrice ?? chain.underlying?.lastPrice ?? chain.underlying?.mark);
  if (!Number.isFinite(+spot) || +spot <= 0) return [];
  const callsAll = contractsFromMap(chain.callExpDateMap, "CALL");
  const putsAll = contractsFromMap(chain.putExpDateMap, "PUT");
  for (const o of [...callsAll, ...putsAll]) if (!o.dte) o.dte = dteOfDate(o.expirationDate, now);
  const eligible = [...callsAll, ...putsAll].filter(o => o.dte >= 15 && o.dte <= 45 && isThirdFridayDate(o.expirationDate));
  if (!eligible.length) return [];

  const byExp = {}; eligible.forEach(o => { (byExp[o.expirationDate] = byExp[o.expirationDate] || []).push(o); });
  const chainVolRaw = toNumber(chain.volatility);
  const chainExpectedMoveRaw = toNumber(pickFirstDefined(chain, ["expectedMove", "expectedMoveValue", "expectedMoveAmount", "expectedPriceMove"]));
  const out = [];

  for (const ek of Object.keys(byExp)) {
    const set = byExp[ek];
    const monthlyOI = set.reduce((s, o) => s + (o.openInterestRaw || 0), 0);
    const calls = set.filter(o => o.type === "C" && o.strike > spot).sort((a,b) => a.strike - b.strike);
    const puts = set.filter(o => o.type === "P" && o.strike < spot).sort((a,b) => b.strike - a.strike);
    const erDate = earningsMap[sym] || null;
    const earnInWindow = !!(erDate && erDate >= todayStr && erDate <= ek);

    for (const widthTarget of widthsFor(spot)) {
      const putStructures = [];
      const callStructures = [];
      for (const sp of puts) { const lp = nearestByStrike(set, "P", sp.strike - widthTarget); if (lp && lp.strike < sp.strike) putStructures.push({ sp, lp }); }
      for (const sc of calls) { const lc = nearestByStrike(set, "C", sc.strike + widthTarget); if (lc && lc.strike > sc.strike) callStructures.push({ sc, lc }); }
      for (const ps of putStructures) {
        for (const cs of callStructures) {
          const { sp, lp } = ps, { sc, lc } = cs;
          const callW = +(lc.strike - sc.strike).toFixed(2), putW = +(sp.strike - lp.strike).toFixed(2);
          if (callW <= 0 || putW <= 0) continue;
          const width = Math.max(callW, putW);
          const credit = round2((bid(sc) + bid(sp)) - (ask(lc) + ask(lp)));
          const midCredit = round2((mark(sc) + mark(sp)) - (mark(lc) + mark(lp)));
          const maxRisk = Number.isFinite(+credit) ? width - credit : null;
          const roc = Number.isFinite(+maxRisk) && maxRisk !== 0 ? credit / maxRisk * 100 : -999;
          const legVols = [sc, sp, lc, lp].map(o => ivPct(o.volatilityRaw)).filter(v => Number.isFinite(+v));
          const monthlyChainIV = ivPct(chainVolRaw);
          const iv = monthlyChainIV ?? (legVols.length ? Math.max(...legVols) : 0);
          const monthlyChainIVSource = monthlyChainIV !== null ? "Schwab raw" : (legVols.length ? "Fallback" : "Missing");
          const monthlyChainIVMethod = monthlyChainIV !== null ? "Schwab/TOS API-provided chain volatility" : (legVols.length ? "Derived from selected option-leg volatility" : "No Schwab IV field available");
          const monthlyChainIVFallbackReason = monthlyChainIV !== null ? null : "Schwab chain-level volatility unavailable";
          const putDelta = Math.abs(+sp.deltaRaw || 0), callDelta = Math.abs(+sc.deltaRaw || 0);
          const rawPutProb = sp.probabilityOTMRaw, rawCallProb = sc.probabilityOTMRaw;
          const putProbOtm = rawPutProb !== null ? +rawPutProb : +(1 - putDelta).toFixed(3);
          const callProbOtm = rawCallProb !== null ? +rawCallProb : +(1 - callDelta).toFixed(3);
          const probabilitySource = rawPutProb !== null && rawCallProb !== null ? "Schwab raw" : "POPPA calculated";
          const probabilityMethod = probabilitySource === "Schwab raw" ? "Schwab/TOS API-provided Probability OTM" : "Delta approximation: 1 - abs(delta)";
          const probabilityFallbackReason = probabilitySource === "Schwab raw" ? null : "Schwab Probability OTM field unavailable on one or more short legs";
          const probOtm = Math.min(putProbOtm, callProbOtm);
          const spreadMax = +Math.max(ask(sc) - bid(sc), ask(sp) - bid(sp), ask(lc) - bid(lc), ask(lp) - bid(lp)).toFixed(2);
          const shortPutOI = sp.openInterestRaw || 0, shortCallOI = sc.openInterestRaw || 0, longPutOI = lp.openInterestRaw || 0, longCallOI = lc.openInterestRaw || 0;
          const checks = {
            roc: roc >= 5 && roc <= 30,
            monthlyLiquidity: monthlyOI >= MIN_MONTHLY_OI,
            shortLegLiquidity: shortPutOI >= MIN_SHORT_LEG_OI && shortCallOI >= MIN_SHORT_LEG_OI,
            longLegLiquidity: longPutOI >= MIN_LONG_LEG_OI && longCallOI >= MIN_LONG_LEG_OI,
            iv: iv >= 40,
            probOtm: putProbOtm >= 0.90 && callProbOtm >= 0.90,
            spread: spreadMax <= MAX_ALL_LEG_SPREAD
          };
          const misses = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
          const passed = misses.length === 0;
          const em = expectedMoveFields(spot, iv, sc.dte, sp.strike, sc.strike, chainExpectedMoveRaw);
          const quoteTimeRaw = [sc.quoteTimeRaw, sp.quoteTimeRaw, lc.quoteTimeRaw, lp.quoteTimeRaw].filter(Boolean).sort().pop() || null;
          const tradeTimeRaw = [sc.tradeTimeRaw, sp.tradeTimeRaw, lc.tradeTimeRaw, lp.tradeTimeRaw].filter(Boolean).sort().pop() || null;
          const row = {
            symbol: sym, name, sector, market: market || "both",
            dataSource: "Schwab/TOS Market Data API", dataMode: "Schwab market-data EOD snapshot", rawSourcePreserved: true, sourceAuditEnabled: true,
            ivRaw: chainVolRaw, ivDisplay: +(+iv).toFixed(1), iv: +(+iv).toFixed(1), hv: +(+iv).toFixed(1),
            monthlyChainIVRaw: chainVolRaw, monthlyChainIVDisplay: +(+iv).toFixed(1), monthlyChainIV: +(+iv).toFixed(1), monthlyChainIVSource, monthlyChainIVMethod, monthlyChainIVFallbackReason,
            earnings: earnInWindow, earningsDate: earnInWindow ? erDate : null, nextEarnings: erDate,
            dte: sc.dte, expiry: ek,
            credit, midCredit, width, maxRisk: round2(maxRisk),
            netCreditSource: "POPPA calculated from Schwab leg bid/ask", roc: +roc.toFixed(2), rocSource: "POPPA calculated", rocMethod: "Net Credit / Max Risk × 100",
            probOtm: +probOtm.toFixed(3), putProbOtm, callProbOtm, probabilityOTMRaw: rawPutProb !== null && rawCallProb !== null ? Math.min(rawPutProb, rawCallProb) : null, probabilitySource, probabilityMethod, probabilityFallbackReason,
            shortDelta: +Math.max(putDelta, callDelta).toFixed(3),
            openInterest: monthlyOI, openInterestSource: "Schwab raw", shortPutOI, shortCallOI, longPutOI, longCallOI,
            volumeSource: "Schwab raw", greeksSource: "Schwab raw", spreadMax, spotRaw: +(+spot).toFixed(2), spotDisplay: +(+spot).toFixed(2), spot: +(+spot).toFixed(2), spotSource: "Schwab raw",
            expectedMoveRaw: chainExpectedMoveRaw, expectedMove: em.expectedMove, expectedMoveDisplay: em.expectedMove, expectedLow: em.expectedLow, expectedHigh: em.expectedHigh, expectedMoveStatus: em.expectedMoveStatus, expectedMoveSource: em.expectedMoveSource, expectedMoveMethod: em.expectedMoveMethod, expectedMoveFallbackReason: em.expectedMoveFallbackReason,
            shortCall: sc.strike, shortPut: sp.strike, longCall: lc.strike, longPut: lp.strike,
            rawLegs: { shortPut: rawLeg(sp), longPut: rawLeg(lp), shortCall: rawLeg(sc), longCall: rawLeg(lc) },
            shortPutContractSymbol: sp.symbol, longPutContractSymbol: lp.symbol, shortCallContractSymbol: sc.symbol, longCallContractSymbol: lc.symbol,
            quoteTimeRaw, tradeTimeRaw, asOf: quoteTimeRaw || tradeTimeRaw || null,
            passed, score: Object.keys(checks).length - misses.length,
            rawChainEligible: true, rawChainRule: "Schwab/TOS monthly third-Friday expiration, 15-45 DTE only",
            reviewStatus: passed ? "Matches primary filters ✓" : ("Needs review: " + misses.join(", ")),
            reviewStatusSource: "POPPA calculated", reviewStatusMethod: "Scanner review criteria; educational review classification only; not a trade recommendation.",
            note: passed ? "Matches primary filters ✓" : ("Needs review: " + misses.join(", "))
          };
          row.sourceLabels = {
            dataSource: "Schwab/TOS Market Data API", spot: "Schwab raw", bid: "Schwab raw", ask: "Schwab raw", mark: "Schwab raw", mid: "POPPA calculated", openInterest: "Schwab raw", volume: "Schwab raw", greeks: "Schwab raw", monthlyChainIV: monthlyChainIVSource, probabilityOTM: probabilitySource, expectedMove: em.expectedMoveSource, roc: "POPPA calculated", netCredit: row.netCreditSource, maxRisk: "POPPA calculated", spreadWidth: "POPPA calculated", reviewStatus: "POPPA calculated"
          };
          row.fieldLineage = {
            spot: lineage(row.spotRaw, row.spotDisplay, "Schwab raw", "Schwab underlying price", row.asOf),
            monthlyChainIV: lineage(row.monthlyChainIVRaw, row.monthlyChainIVDisplay, monthlyChainIVSource, monthlyChainIVMethod, row.asOf, monthlyChainIVFallbackReason),
            probabilityOTM: lineage(row.probabilityOTMRaw, row.probOtm, probabilitySource, probabilityMethod, row.asOf, probabilityFallbackReason),
            expectedMove: lineage(row.expectedMoveRaw, row.expectedMoveDisplay, em.expectedMoveSource, em.expectedMoveMethod, row.asOf, em.expectedMoveFallbackReason),
            roc: lineage(null, row.roc, "POPPA calculated", "Net Credit / Max Risk × 100", row.asOf),
            reviewStatus: lineage(null, row.reviewStatus, "POPPA calculated", "Scanner review criteria; educational only", row.asOf)
          };
          out.push(row);
        }
      }
    }
  }
  return out;
}

async function writeBoard(store, state, earningsOk, complete, error = null) {
  const rows = state.rows.slice().sort((a, b) => (b.passed - a.passed) || (b.score - a.score) || ((b.roc || 0) - (a.roc || 0)) || ((b.credit || 0) - (a.credit || 0)));
  await store.setJSON("latest", {
    strategy: "SP500_Tight_Condor_Scan_v3_Schwab_Lineage",
    scanMode: "Schwab/TOS market-data EOD snapshot · monthly 15-45 DTE · source audit enabled" + (complete ? "" : " · building…"),
    dataSource: "Schwab/TOS Market Data API",
    dataMode: "Schwab market-data EOD snapshot",
    generatedAt: new Date().toISOString(),
    universeCount: state.total, scanned: state.scanned, withCondor: rows.length,
    rawMonthlyChainRule: "Only monthly third-Friday option-chain records with DTE 15-45 are extracted before scanner display controls.",
    etlNotFilteredBy: ["ROC", "probability", "delta band", "IV", "open interest", "bid/ask spread", "positive credit", "earnings", "pass/fail"],
    rawSourcePreserved: true, normalizationApplied: true, calculationApplied: true, sourceAuditEnabled: true,
    passCount: rows.filter(r => r.passed).length,
    earningsShield: earningsOk ? "active (Nasdaq calendar)" : "source unavailable — verify on platform",
    earningsFlagged: rows.filter(r => r.earnings).length,
    probabilityDisclosure: "Anchor-leg probability only; not guaranteed whole-condor probability. Schwab raw Probability OTM is used when available; otherwise POPPA calculated delta fallback is labeled.",
    monthlyChainIVDisclosure: "Monthly Chain IV is Schwab raw when provided; otherwise selected-leg volatility fallback is labeled.",
    expectedMoveDisclosure: "Expected Move is Schwab raw when provided; otherwise POPPA calculates Underlying × IV × sqrt(DTE / 365) and labels the fallback.",
    building: !complete, progress: { scanned: state.scanned, total: state.total },
    buildError: error ? { message: error.message || String(error), details: error.safeDetails || null } : null,
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

  try {
    assertMarketDataOnlyConfig();
    let state = await store.get("build", { type: "json" }).catch(() => null);
    if (!isContinue) {
      if (state && state.status === "running" && (Date.now() - new Date(state.updatedAt).getTime()) < 4 * 60 * 1000) return json({ ok: true, note: "already running", scanned: state.scanned, total: state.total, dataSource: "Schwab/TOS Market Data API" });
      const universe = await loadUniverse();
      const earnings = await loadEarnings(90);
      state = { status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), total: universe.length, scanned: 0, pendingIdx: 0, universe, earnings, rows: [] };
      await store.setJSON("build", state);
    }
    if (!state) return json({ ok: false, note: "no state", dataSource: "Schwab/TOS Market Data API" });

    const { universe, earnings } = state;
    const earningsOk = Object.keys(earnings || {}).length > 0;
    while (state.pendingIdx < state.total && (Date.now() - t0) < MAX_RUN_MS) {
      const batch = universe.slice(state.pendingIdx, state.pendingIdx + CHUNK);
      const queue = [...batch];
      await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length) {
          const [sym, name, sector, market] = queue.shift();
          const ch = await fetchSchwabSym(sym);
          state.scanned++;
          if (ch) for (const row of scanAll(ch, sym, name, sector, market, now, earnings, todayStr)) state.rows.push(row);
          await sleep(160 + Math.random() * 320);
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
      return json({ ok: true, status: "complete", scanned: state.scanned, withCondor: state.rows.length, dataSource: "Schwab/TOS Market Data API", framework: "v3 Schwab raw-preserved lineage" });
    }

    const base = process.env.URL || process.env.DEPLOY_URL;
    if (base) { try { fetch(`${base}/.netlify/functions/scan-build-background?continue=1`, { method: "POST" }); } catch (_) {} }
    return json({ ok: true, status: "running", scanned: state.scanned, pendingIdx: state.pendingIdx, total: state.total, dataSource: "Schwab/TOS Market Data API", framework: "v3 Schwab raw-preserved lineage" });
  } catch (error) {
    const state = await store.get("build", { type: "json" }).catch(() => ({ total: 0, scanned: 0, rows: [] }));
    await writeBoard(store, state || { total: 0, scanned: 0, rows: [] }, false, true, error);
    return json({ ok: false, error: error.message || "Schwab scan build error", details: error.safeDetails || null, dataSource: "Schwab/TOS Market Data API", marketDataOnly: true, accountDataReturnedToFrontend: false, tokenReturnedToFrontend: false });
  }
};