import { getStore } from "@netlify/blobs";

// POPPA'S Option Scanner v3 — Schwab daily price-history market data function.
// Purpose: pull Schwab/TOS daily OHLC candles for Directional Bias calculation using server-side OAuth.
// Security posture: market-data only, mirrors schwab-option-chain.js. This function never calls Schwab
// account, trading, position, balance, order, transaction, or ACCT_ACTIVITY endpoints. It never returns
// Schwab access tokens, refresh tokens, client secrets, account IDs, account hashes, balances, positions,
// orders, or trading data.

const DEFAULT_TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const DEFAULT_API_BASE_URL = "https://api.schwabapi.com";
const PRICE_HISTORY_PATH = "/marketdata/v1/pricehistory";

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

const ALLOWED_MARKET_DATA_PATHS = new Set([
  PRICE_HISTORY_PATH
]);

const BLOCKED_TERMS = [
  "account",
  "accounts",
  "acct_activity",
  "accountactivity",
  "accountnumber",
  "accounthash",
  "hashvalue",
  "balance",
  "balances",
  "position",
  "positions",
  "order",
  "orders",
  "transaction",
  "transactions",
  "trade",
  "trading"
];

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function getEnv(name, fallback = "") {
  return (process.env[name] || fallback || "").trim();
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

function assertMarketDataOnlyConfig() {
  if (getEnv("SCHWAB_ACCOUNT_ACCESS_ENABLED") === "true") {
    const error = new Error("Blocked: SCHWAB_ACCOUNT_ACCESS_ENABLED must not be true for POPPA'S market-data-only setup.");
    error.status = 403;
    throw error;
  }

  if (getEnv("SCHWAB_TRADING_ACCESS_ENABLED") === "true") {
    const error = new Error("Blocked: SCHWAB_TRADING_ACCESS_ENABLED must not be true for POPPA'S market-data-only setup.");
    error.status = 403;
    throw error;
  }
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

function assertAllowedMarketDataPath(pathname) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (!ALLOWED_MARKET_DATA_PATHS.has(normalizedPath)) {
    const error = new Error(`Blocked Schwab path: ${normalizedPath}. Only market-data price-history path is allowed.`);
    error.status = 403;
    throw error;
  }
  assertNoBlockedTerms(normalizedPath, "Schwab path");
}

function basicAuthHeader() {
  const clientId = getEnv("SCHWAB_CLIENT_ID");
  const clientSecret = getEnv("SCHWAB_CLIENT_SECRET");
  const encoded = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

async function readStoredTokenRecord() {
  try {
    const store = getStore(TOKEN_STORE_NAME);
    const stored = await store.get(TOKEN_STORE_KEY);
    if (!stored) return null;
    return JSON.parse(stored);
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
  if (storedRecord?.refresh_token) {
    return { refreshToken: storedRecord.refresh_token, source: "netlify_blob_store", storedRecord };
  }

  const envToken = getEnv("SCHWAB_REFRESH_TOKEN");
  if (envToken) {
    return { refreshToken: envToken, source: "env", storedRecord: null };
  }

  return { refreshToken: "", source: "missing", storedRecord };
}

async function refreshAccessToken() {
  requireEnv(["SCHWAB_CLIENT_ID", "SCHWAB_CLIENT_SECRET", "SCHWAB_TOKEN_URL"]);
  assertMarketDataOnlyConfig();

  const resolved = await resolveRefreshToken();
  if (!resolved.refreshToken) {
    const error = new Error("Missing refresh token. Complete Schwab authorization or configure SCHWAB_REFRESH_TOKEN.");
    error.status = 400;
    error.safeDetails = {
      tokenStoreName: TOKEN_STORE_NAME,
      tokenStoreKey: TOKEN_STORE_KEY,
      tokenStoreFound: Boolean(resolved.storedRecord),
      envRefreshTokenConfigured: Boolean(getEnv("SCHWAB_REFRESH_TOKEN"))
    };
    throw error;
  }

  const tokenUrl = getEnv("SCHWAB_TOKEN_URL", DEFAULT_TOKEN_URL);
  assertNoBlockedTerms(tokenUrl, "token URL");

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: resolved.refreshToken
    })
  });

  const rawText = await response.text();
  let parsed;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch (_) {
    parsed = { raw: "[non-json token response redacted]" };
  }

  if (!response.ok || !parsed.access_token) {
    const error = new Error("Unable to refresh Schwab access token.");
    error.status = response.status || 500;
    error.safeDetails = {
      status: response.status,
      statusText: response.statusText,
      schwabError: parsed.error || null,
      schwabErrorDescription: parsed.error_description || null,
      tokenSource: resolved.source
    };
    throw error;
  }

  if (resolved.source === "netlify_blob_store" || parsed.refresh_token) {
    await writeStoredTokenRecord(resolved.storedRecord || {}, {
      ...parsed,
      refresh_token: parsed.refresh_token || resolved.refreshToken
    });
  }

  return {
    accessToken: parsed.access_token,
    metadata: {
      token_type: parsed.token_type || null,
      expires_in: parsed.expires_in || null,
      scope: parsed.scope || null,
      token_source: resolved.source,
      access_token_present: true,
      refresh_token_returned_by_refresh: Boolean(parsed.refresh_token)
    }
  };
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

function buildPriceHistoryUrl(url) {
  requireEnv(["SCHWAB_API_BASE_URL"]);
  assertMarketDataOnlyConfig();
  assertAllowedMarketDataPath(PRICE_HISTORY_PATH);

  const apiBase = getEnv("SCHWAB_API_BASE_URL", DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  assertNoBlockedTerms(apiBase, "API base URL");

  const phUrl = new URL(`${apiBase}${PRICE_HISTORY_PATH}`);
  phUrl.searchParams.set("symbol", normalizeSymbol(url.searchParams.get("symbol")));
  // 3 months of daily candles ≈ 60-65 trading days — matches the Directional Bias spec's
  // recommended 60-day lookback (minimum usable: 35 trading days).
  phUrl.searchParams.set("periodType", "month");
  phUrl.searchParams.set("period", "3");
  phUrl.searchParams.set("frequencyType", "daily");
  phUrl.searchParams.set("frequency", "1");
  phUrl.searchParams.set("needExtendedHoursData", "false");
  phUrl.searchParams.set("needPreviousClose", "false");

  return phUrl;
}

async function fetchPriceHistory(url) {
  const { accessToken, metadata } = await refreshAccessToken();
  const phUrl = buildPriceHistoryUrl(url);
  assertAllowedMarketDataPath(phUrl.pathname);

  const response = await fetch(phUrl.toString(), {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json"
    }
  });

  const rawText = await response.text();
  let parsed;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch (_) {
    parsed = { raw: "[non-json price-history response redacted]" };
  }

  if (!response.ok) {
    const error = new Error("Schwab price-history market data request failed.");
    error.status = response.status;
    error.safeDetails = {
      status: response.status,
      statusText: response.statusText,
      schwabError: parsed.error || null,
      schwabErrorDescription: parsed.error_description || null,
      requestedPath: phUrl.pathname,
      requestedSymbol: phUrl.searchParams.get("symbol")
    };
    throw error;
  }

  return { data: parsed, tokenMetadata: metadata, requestedUrl: phUrl };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeCandles(rawCandles = []) {
  return (Array.isArray(rawCandles) ? rawCandles : [])
    .map((c) => ({
      datetime: toNumber(c.datetime),
      open: toNumber(c.open),
      high: toNumber(c.high),
      low: toNumber(c.low),
      close: toNumber(c.close),
      volume: toNumber(c.volume)
    }))
    .filter((c) => c.datetime !== null && c.close !== null)
    .sort((a, b) => a.datetime - b.datetime);
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  }

  if (req.method !== "GET") {
    return json({ ok: false, error: "Method not allowed. Use GET only." }, 405);
  }

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return json({ ok: false, error: "Invalid request URL." }, 400);
  }

  try {
    const includeRaw = url.searchParams.get("includeRaw") === "true";
    const startedAt = new Date().toISOString();
    const result = await fetchPriceHistory(url);
    const candles = sanitizeCandles(result.data?.candles);

    const payload = {
      ok: true,
      endpoint: "schwab-price-history",
      marketDataOnly: true,
      accountAccessEnabled: false,
      tradingAccessEnabled: false,
      tokenReturnedToFrontend: false,
      accountDataReturnedToFrontend: false,
      dataSource: "Schwab/TOS Market Data API",
      requestedAt: startedAt,
      receivedAt: new Date().toISOString(),
      requestedPath: result.requestedUrl.pathname,
      requestedSymbol: result.requestedUrl.searchParams.get("symbol"),
      candleCount: candles.length,
      candles
    };

    if (includeRaw) {
      payload.rawPriceHistory = result.data;
      payload.rawDataWarning = "Raw market-data price-history included because includeRaw=true. Do not use this mode for broad public frontend display.";
    }

    return json(payload);
  } catch (error) {
    return json({
      ok: false,
      endpoint: "schwab-price-history",
      error: error.message || "Schwab price-history function error.",
      details: error.safeDetails || undefined,
      marketDataOnly: true,
      tokenReturnedToFrontend: false,
      accountDataReturnedToFrontend: false
    }, error.status || 500);
  }
}
