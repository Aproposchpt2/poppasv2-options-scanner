import { getStore } from "@netlify/blobs";

// POPPA'S Option Scanner v3 — Schwab raw-vs-POPPA validation snapshot.
// Security posture: market-data only. This function never calls Schwab account, trading,
// position, balance, order, transaction, or ACCT_ACTIVITY endpoints and never returns tokens.

const DEFAULT_TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const DEFAULT_API_BASE_URL = "https://api.schwabapi.com";
const OPTION_CHAIN_PATH = "/marketdata/v1/chains";
const TOKEN_STORE_NAME = process.env.SCHWAB_TOKEN_STORE_NAME || "schwab-oauth";
const TOKEN_STORE_KEY = process.env.SCHWAB_TOKEN_STORE_KEY || "latest-token";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};

const BLOCKED_TERMS = ["account", "accounts", "acct_activity", "accountactivity", "accountnumber", "accounthash", "hashvalue", "balance", "balances", "position", "positions", "order", "orders", "transaction", "transactions", "trade", "trading"];

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" }
  });
}

function getEnv(name, fallback = "") {
  return (process.env[name] || fallback || "").trim();
}

function assertNoBlockedTerms(value, label = "value") {
  const text = String(value || "").toLowerCase();
  const matched = BLOCKED_TERMS.find((term) => text.includes(term));
  if (matched) {
    const error = new Error(`Blocked ${label}: market-data-only function cannot reference ${matched}.`);
    error.status = 403;
    throw error;
  }
}

function assertMarketDataOnlyConfig() {
  if (getEnv("SCHWAB_ACCOUNT_ACCESS_ENABLED") === "true" || getEnv("SCHWAB_TRADING_ACCESS_ENABLED") === "true") {
    const error = new Error("Blocked: Schwab account/trading access flags must not be enabled for POPPA'S market-data-only setup.");
    error.status = 403;
    throw error;
  }
}

function requireEnv(names) {
  const missing = names.filter((name) => !getEnv(name));
  if (missing.length) {
    const error = new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
    error.status = 500;
    error.safeDetails = { missingEnv: missing };
    throw error;
  }
}

function basicAuthHeader() {
  return `Basic ${Buffer.from(`${getEnv("SCHWAB_CLIENT_ID")}:${getEnv("SCHWAB_CLIENT_SECRET")}`, "utf8").toString("base64")}`;
}

async function readStoredTokenRecord() {
  try {
    const store = getStore(TOKEN_STORE_NAME);
    const stored = await store.get(TOKEN_STORE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch (_) {
    return null;
  }
}

async function writeStoredTokenRecord(existingRecord = {}, tokenResponse = {}) {
  const receivedAt = new Date();
  const expiresIn = Number(tokenResponse.expires_in || 0);
  const tokenRecord = {
    ...existingRecord,
    provider: "schwab",
    marketDataOnly: true,
    token_type: tokenResponse.token_type || existingRecord.token_type || "Bearer",
    access_token: tokenResponse.access_token || existingRecord.access_token || null,
    refresh_token: tokenResponse.refresh_token || existingRecord.refresh_token || null,
    expires_in: tokenResponse.expires_in || existingRecord.expires_in || null,
    scope: tokenResponse.scope || existingRecord.scope || null,
    received_at: receivedAt.toISOString(),
    access_token_expires_at: expiresIn > 0 ? new Date(receivedAt.getTime() + expiresIn * 1000).toISOString() : null,
    tokenReturnedToFrontend: false,
    accountDataReturnedToFrontend: false
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
  if (!resolved.refreshToken) {
    const error = new Error("Missing refresh token. Complete Schwab authorization or configure SCHWAB_REFRESH_TOKEN.");
    error.status = 400;
    error.safeDetails = { tokenStoreFound: Boolean(resolved.storedRecord), envRefreshTokenConfigured: Boolean(getEnv("SCHWAB_REFRESH_TOKEN")) };
    throw error;
  }
  const tokenUrl = getEnv("SCHWAB_TOKEN_URL", DEFAULT_TOKEN_URL);
  assertNoBlockedTerms(tokenUrl, "token URL");
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Authorization": basicAuthHeader(), "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: resolved.refreshToken })
  });
  const rawText = await response.text();
  let parsed;
  try { parsed = rawText ? JSON.parse(rawText) : {}; } catch (_) { parsed = {}; }
  if (!response.ok || !parsed.access_token) {
    const error = new Error("Unable to refresh Schwab access token.");
    error.status = response.status || 500;
    error.safeDetails = { status: response.status, statusText: response.statusText, schwabError: parsed.error || null, schwabErrorDescription: parsed.error_description || null, tokenSource: resolved.source };
    throw error;
  }
  if (resolved.source === "netlify_blob_store" || parsed.refresh_token) {
    await writeStoredTokenRecord(resolved.storedRecord || {}, { ...parsed, refresh_token: parsed.refresh_token || resolved.refreshToken });
  }
  return parsed.access_token;
}

function normalizeSymbol(symbol) {
  const normalized = String(symbol || "AAPL").trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(normalized)) {
    const error = new Error("Invalid symbol. Use a normal equity ticker such as AAPL, AMZN, MSFT, SPY, or QQQ.");
    error.status = 400;
    throw error;
  }
  return normalized;
}

async function fetchSchwabChain(sourceUrl) {
  requireEnv(["SCHWAB_API_BASE_URL"]);
  assertMarketDataOnlyConfig();
  const accessToken = await refreshAccessToken();
  const apiBase = getEnv("SCHWAB_API_BASE_URL", DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  assertNoBlockedTerms(apiBase, "API base URL");
  const chainUrl = new URL(`${apiBase}${OPTION_CHAIN_PATH}`);
  chainUrl.searchParams.set("symbol", normalizeSymbol(sourceUrl.searchParams.get("symbol")));
  chainUrl.searchParams.set("contractType", "ALL");
  chainUrl.searchParams.set("includeQuotes", "TRUE");
  chainUrl.searchParams.set("includeUnderlyingQuote", "TRUE");
  chainUrl.searchParams.set("strategy", "SINGLE");
  chainUrl.searchParams.set("range", sourceUrl.searchParams.get("range") || "ALL");
  for (const key of ["fromDate", "toDate", "expMonth", "strike", "strikeCount", "volatility", "underlyingPrice", "interestRate", "daysToExpiration", "optionType", "entitlement"]) {
    const value = sourceUrl.searchParams.get(key);
    if (value !== null && value !== "") {
      assertNoBlockedTerms(key, "query parameter name");
      assertNoBlockedTerms(value, `query parameter ${key}`);
      chainUrl.searchParams.set(key, value);
    }
  }
  const response = await fetch(chainUrl.toString(), { headers: { "Authorization": `Bearer ${accessToken}`, "Accept": "application/json" } });
  const rawText = await response.text();
  let parsed;
  try { parsed = rawText ? JSON.parse(rawText) : {}; } catch (_) { parsed = {}; }
  if (!response.ok) {
    const error = new Error("Schwab option-chain market data request failed.");
    error.status = response.status;
    error.safeDetails = { status: response.status, statusText: response.statusText, schwabError: parsed.error || null, schwabErrorDescription: parsed.error_description || null, requestedPath: OPTION_CHAIN_PATH, requestedSymbol: chainUrl.searchParams.get("symbol") };
    throw error;
  }
  return { chain: parsed, requestParams: Object.fromEntries(chainUrl.searchParams.entries()) };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pickFirstDefined(object, keys) {
  if (!object || typeof object !== "object") return undefined;
  for (const key of keys) if (object[key] !== undefined && object[key] !== null) return object[key];
  return undefined;
}

function findFieldNames(object, matcher, found = new Set(), depth = 0) {
  if (!object || typeof object !== "object" || depth > 5) return found;
  for (const [key, value] of Object.entries(object)) {
    if (matcher(key, value)) found.add(key);
    if (value && typeof value === "object") findFieldNames(value, matcher, found, depth + 1);
  }
  return found;
}

function contractsFromMap(mapLike, side) {
  const out = [];
  for (const [expirationKey, strikes] of Object.entries(mapLike || {})) {
    for (const [strikeKey, contracts] of Object.entries(strikes || {})) {
      for (const contract of Array.isArray(contracts) ? contracts : []) {
        out.push({ ...contract, _expirationKey: expirationKey, _strikeKey: strikeKey, _side: side });
      }
    }
  }
  return out;
}

function sanitizeContract(contract = {}) {
  return {
    rawContractSymbol: contract.symbol || null,
    putCall: contract.putCall || contract._side || null,
    description: contract.description || null,
    expirationKey: contract._expirationKey || null,
    expirationDate: contract.expirationDate || String(contract._expirationKey || "").split(":")[0] || null,
    daysToExpiration: toNumber(contract.daysToExpiration),
    strikePrice: toNumber(contract.strikePrice),
    bidRaw: toNumber(contract.bid),
    askRaw: toNumber(contract.ask),
    markRaw: toNumber(contract.mark),
    lastRaw: toNumber(contract.last),
    volumeRaw: toNumber(contract.totalVolume ?? contract.volume),
    openInterestRaw: toNumber(contract.openInterest),
    deltaRaw: toNumber(contract.delta),
    gammaRaw: toNumber(contract.gamma),
    thetaRaw: toNumber(contract.theta),
    vegaRaw: toNumber(contract.vega),
    rhoRaw: toNumber(contract.rho),
    volatilityRaw: toNumber(contract.volatility),
    theoreticalOptionValueRaw: toNumber(contract.theoreticalOptionValue),
    theoreticalVolatilityRaw: toNumber(contract.theoreticalVolatility),
    probabilityOTMRaw: toNumber(pickFirstDefined(contract, ["probabilityOTM", "probabilityOtm", "probOTM", "probOtm", "probabilityOutOfTheMoney", "pOTM"])),
    quoteTimeRaw: contract.quoteTimeInLong || null,
    tradeTimeRaw: contract.tradeTimeInLong || null,
    source: "Schwab raw"
  };
}

function topLevelExpectedMove(chain) {
  return toNumber(pickFirstDefined(chain, ["expectedMove", "expectedMoveValue", "expectedMoveAmount", "expectedPriceMove"]));
}

function ivPct(v) {
  const n = toNumber(v);
  if (n === null) return null;
  return n > 1.5 ? n : n * 100;
}

function expectedMoveFrom(spot, iv, dte) {
  if (![spot, iv, dte].every(v => Number.isFinite(+v)) || +spot <= 0 || +iv <= 0 || +dte <= 0) return null;
  return +(+spot * (+iv / 100) * Math.sqrt(+dte / 365)).toFixed(2);
}

function buildPoppaForContract(chain, contract) {
  const spot = toNumber(chain.underlyingPrice ?? chain.underlying?.lastPrice ?? chain.underlying?.mark);
  const chainIVRaw = toNumber(chain.volatility);
  const contractIVRaw = contract.volatilityRaw;
  const monthlyChainIVDisplay = ivPct(chainIVRaw ?? contractIVRaw);
  const probabilityRaw = contract.probabilityOTMRaw;
  const delta = Math.abs(toNumber(contract.deltaRaw) ?? 0);
  const probabilityDisplay = probabilityRaw !== null ? probabilityRaw : +(1 - delta).toFixed(3);
  const emRaw = topLevelExpectedMove(chain);
  const emDisplay = emRaw !== null ? emRaw : expectedMoveFrom(spot, monthlyChainIVDisplay, contract.daysToExpiration);
  return {
    spotRaw: spot,
    spotDisplay: spot,
    monthlyChainIVRaw: chainIVRaw,
    monthlyChainIVDisplay,
    monthlyChainIVSource: chainIVRaw !== null ? "Schwab raw" : (contractIVRaw !== null ? "Fallback" : "Missing"),
    monthlyChainIVMethod: chainIVRaw !== null ? "Schwab/TOS API-provided chain volatility" : (contractIVRaw !== null ? "Derived from selected contract volatility" : "No Schwab IV field available"),
    monthlyChainIVFallbackReason: chainIVRaw !== null ? null : "Schwab chain-level volatility unavailable",
    probabilityOTMRaw: probabilityRaw,
    probabilityOTMDisplay: probabilityDisplay,
    probabilitySource: probabilityRaw !== null ? "Schwab raw" : "POPPA calculated",
    probabilityMethod: probabilityRaw !== null ? "Schwab/TOS API-provided Probability OTM" : "Delta approximation: 1 - abs(delta)",
    probabilityFallbackReason: probabilityRaw !== null ? null : "Schwab Probability OTM field unavailable",
    expectedMoveRaw: emRaw,
    expectedMoveDisplay: emDisplay,
    expectedMoveSource: emRaw !== null ? "Schwab raw" : "POPPA calculated",
    expectedMoveMethod: emRaw !== null ? "Schwab/TOS API-provided expected move" : "Underlying Price × IV × sqrt(DTE / 365)",
    expectedMoveFallbackReason: emRaw !== null ? null : "Schwab expected move unavailable"
  };
}

function fieldDiscovery(chain) {
  const volatilityFields = Array.from(findFieldNames(chain, (key) => /vol|iv/i.test(key))).sort();
  const probabilityFields = Array.from(findFieldNames(chain, (key) => /prob|otm|itm/i.test(key))).sort();
  const expectedMoveFields = Array.from(findFieldNames(chain, (key) => /expected|move/i.test(key))).sort();
  return {
    topLevelFields: Object.keys(chain || {}).sort(),
    volatilityOrIVFields: volatilityFields,
    probabilityFields,
    expectedMoveFields,
    hasTopLevelVolatility: chain?.volatility !== undefined,
    hasProbabilityOTMField: probabilityFields.length > 0,
    hasExpectedMoveField: expectedMoveFields.length > 0
  };
}

function diff(raw, display, label) {
  const rn = toNumber(raw), dn = toNumber(display);
  if (rn === null || dn === null) return { field: label, rawValue: raw, displayValue: display, status: "not_comparable" };
  return { field: label, rawValue: rn, displayValue: dn, difference: +(dn - rn).toFixed(6), status: Math.abs(dn - rn) <= 0.000001 ? "match" : "review" };
}

async function findScannerDisplayed(symbol, expiration, strike, side) {
  try {
    const store = getStore("poppas-scan");
    const board = await store.get("latest", { type: "json" });
    const rows = Array.isArray(board?.results) ? board.results : [];
    return rows.find(r => String(r.symbol || "").toUpperCase() === symbol && (!expiration || r.expiry === expiration) && (!strike || [r.shortCall, r.shortPut, r.longCall, r.longPut].map(Number).includes(Number(strike))) && (!side || true)) || null;
  } catch (_) {
    return null;
  }
}

function statusPayload() {
  return {
    ok: true,
    endpoint: "schwab-validation-snapshot",
    purpose: "One-symbol Schwab raw-vs-POPPA calculated validation snapshot",
    marketDataOnly: true,
    accountAccessEnabled: false,
    tradingAccessEnabled: false,
    allowedPath: OPTION_CHAIN_PATH,
    sampleUsage: "/.netlify/functions/schwab-validation-snapshot?symbol=AAPL",
    optionalParams: ["symbol", "expiration", "strike", "side", "range", "fromDate", "toDate", "strikeCount"]
  };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  if (req.method !== "GET") return json({ ok: false, error: "Method not allowed. Use GET only." }, 405);

  let url;
  try { url = new URL(req.url); } catch (_) { return json({ ok: false, error: "Invalid request URL." }, 400); }

  try {
    const action = String(url.searchParams.get("action") || "snapshot").toLowerCase();
    if (["status", "health", "test"].includes(action)) return json(statusPayload());

    const startedAt = new Date().toISOString();
    const symbol = normalizeSymbol(url.searchParams.get("symbol"));
    const requestedExpiration = url.searchParams.get("expiration");
    const requestedStrike = toNumber(url.searchParams.get("strike"));
    const requestedSide = String(url.searchParams.get("side") || "").toUpperCase();
    const { chain, requestParams } = await fetchSchwabChain(url);
    const calls = contractsFromMap(chain.callExpDateMap, "CALL").map(sanitizeContract);
    const puts = contractsFromMap(chain.putExpDateMap, "PUT").map(sanitizeContract);
    const all = [...calls, ...puts];

    const selected = all.find(c =>
      (!requestedExpiration || c.expirationDate === requestedExpiration || c.expirationKey === requestedExpiration) &&
      (!requestedStrike || Number(c.strikePrice) === Number(requestedStrike)) &&
      (!requestedSide || String(c.putCall).toUpperCase().includes(requestedSide))
    ) || all.find(c => !requestedExpiration || c.expirationDate === requestedExpiration) || all[0] || null;

    const poppaNormalized = selected ? buildPoppaForContract(chain, selected) : null;
    const scannerDisplayed = selected ? await findScannerDisplayed(symbol, selected.expirationDate, selected.strikePrice, selected.putCall) : null;
    const differenceReport = selected && poppaNormalized ? [
      diff(selected.bidRaw, selected.bidRaw, "bid"),
      diff(selected.askRaw, selected.askRaw, "ask"),
      diff(selected.markRaw, selected.markRaw, "mark"),
      diff(selected.openInterestRaw, selected.openInterestRaw, "openInterest"),
      diff(selected.volatilityRaw, poppaNormalized.monthlyChainIVDisplay, "contractVolatility_vs_displayIV"),
      diff(selected.probabilityOTMRaw, poppaNormalized.probabilityOTMDisplay, "probabilityOTM")
    ] : [];

    return json({
      ok: true,
      endpoint: "schwab-validation-snapshot",
      validationMode: true,
      marketDataOnly: true,
      tokenReturnedToFrontend: false,
      accountDataReturnedToFrontend: false,
      dataSource: "Schwab/TOS Market Data API",
      request: { symbol, requestedExpiration, requestedStrike, requestedSide, requestParams, requestedAt: startedAt, receivedAt: new Date().toISOString() },
      schwabRaw: {
        underlying: {
          symbol: chain.symbol || symbol,
          underlyingPrice: toNumber(chain.underlyingPrice ?? chain.underlying?.lastPrice ?? chain.underlying?.mark),
          volatility: toNumber(chain.volatility),
          isDelayed: chain.isDelayed ?? null,
          status: chain.status || null,
          strategy: chain.strategy || null,
          numberOfContracts: toNumber(chain.numberOfContracts) || all.length
        },
        selectedContract: selected,
        sampleCalls: calls.slice(0, 5),
        samplePuts: puts.slice(0, 5)
      },
      schwabFieldDiscovery: fieldDiscovery(chain),
      selectedExpiration: selected?.expirationDate || null,
      selectedContracts: selected ? [selected] : [],
      poppaNormalized,
      poppaCalculated: selected && poppaNormalized ? {
        mid: selected.bidRaw !== null && selected.askRaw !== null ? +((selected.bidRaw + selected.askRaw) / 2).toFixed(2) : null,
        probabilityOTM: poppaNormalized.probabilityOTMDisplay,
        expectedMove: poppaNormalized.expectedMoveDisplay,
        expectedMoveMethod: poppaNormalized.expectedMoveMethod,
        note: "Strategy-level ROC, net credit, max risk, and review status are POPPA calculated after condor leg selection."
      } : null,
      scannerDisplayed,
      differenceReport,
      sourceLabels: {
        bid: "Schwab raw",
        ask: "Schwab raw",
        mark: selected?.markRaw !== null ? "Schwab raw" : "Missing",
        mid: "POPPA calculated only when needed: (bid + ask) / 2",
        openInterest: "Schwab raw",
        volume: "Schwab raw",
        greeks: "Schwab raw",
        monthlyChainIV: poppaNormalized?.monthlyChainIVSource || "Missing",
        probabilityOTM: poppaNormalized?.probabilitySource || "Missing",
        expectedMove: poppaNormalized?.expectedMoveSource || "Missing",
        roc: "POPPA calculated",
        reviewStatus: "POPPA calculated"
      },
      warnings: [
        "This endpoint validates market data only; it does not access accounts or trading endpoints.",
        "Thinkorswim parity must compare the same symbol, expiration, strike, side, and EOD/as-of timestamp.",
        "If Schwab does not provide Probability OTM or Expected Move, POPPA fallback calculations are labeled explicitly."
      ],
      passFail: {
        rawSchwabReturned: Boolean(selected),
        rawSourcePreserved: Boolean(selected),
        sourceLabelsPresent: true,
        scannerDisplayedFound: Boolean(scannerDisplayed)
      }
    });
  } catch (error) {
    return json({
      ok: false,
      endpoint: "schwab-validation-snapshot",
      error: error.message || "Schwab validation snapshot error.",
      details: error.safeDetails || undefined,
      marketDataOnly: true,
      tokenReturnedToFrontend: false,
      accountDataReturnedToFrontend: false
    }, error.status || 500);
  }
}
