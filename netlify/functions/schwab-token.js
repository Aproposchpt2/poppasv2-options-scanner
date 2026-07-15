import { getStore } from "@netlify/blobs";

// POPPA'S Option Scanner v3 — Schwab OAuth token helper
// Purpose: generate a Schwab OAuth authorization URL, exchange authorization codes, and refresh tokens.
// Security posture: market-data only. This function never calls Schwab account, trading, position, balance,
// order, transaction, or ACCT_ACTIVITY endpoints.

const DEFAULT_AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";

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

const MARKET_DATA_ONLY_NOTE = "POPPA'S is configured for Schwab market data only. Do not authorize accounts, trading, balances, positions, orders, or ACCT_ACTIVITY.";

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

function redact(value = "") {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "[redacted]";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function tokenMetadata(tokenResponse = {}) {
  return {
    token_type: tokenResponse.token_type || null,
    expires_in: tokenResponse.expires_in || null,
    scope: tokenResponse.scope || null,
    access_token_present: Boolean(tokenResponse.access_token),
    access_token_preview: redact(tokenResponse.access_token),
    refresh_token_present: Boolean(tokenResponse.refresh_token),
    refresh_token_preview: redact(tokenResponse.refresh_token),
    id_token_present: Boolean(tokenResponse.id_token)
  };
}

function basicAuthHeader() {
  const clientId = getEnv("SCHWAB_CLIENT_ID");
  const clientSecret = getEnv("SCHWAB_CLIENT_SECRET");
  const encoded = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
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

function buildAuthorizeUrl() {
  requireEnv(["SCHWAB_CLIENT_ID", "SCHWAB_REDIRECT_URI"]);
  assertMarketDataOnlyConfig();

  const authorizeUrl = new URL(getEnv("SCHWAB_AUTHORIZE_URL", DEFAULT_AUTHORIZE_URL));
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", getEnv("SCHWAB_CLIENT_ID"));
  authorizeUrl.searchParams.set("redirect_uri", getEnv("SCHWAB_REDIRECT_URI"));

  const scope = getEnv("SCHWAB_OAUTH_SCOPE");
  if (scope) {
    authorizeUrl.searchParams.set("scope", scope);
  }

  const state = getEnv("SCHWAB_OAUTH_STATE");
  if (state) {
    authorizeUrl.searchParams.set("state", state);
  }

  return authorizeUrl.toString();
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

async function resolveRefreshToken(explicitRefreshToken = "") {
  const explicit = String(explicitRefreshToken || "").trim();
  if (explicit) {
    return { refreshToken: explicit, source: "request_body", storedRecord: null };
  }

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

async function postTokenRequest(bodyParams) {
  requireEnv(["SCHWAB_CLIENT_ID", "SCHWAB_CLIENT_SECRET", "SCHWAB_TOKEN_URL"]);
  assertMarketDataOnlyConfig();

  const tokenUrl = getEnv("SCHWAB_TOKEN_URL", DEFAULT_TOKEN_URL);
  const body = new URLSearchParams(bodyParams);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body
  });

  const rawText = await response.text();
  let parsed;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch (_) {
    parsed = { raw: "[non-json response redacted]" };
  }

  if (!response.ok) {
    const error = new Error("Schwab token endpoint returned an error.");
    error.status = response.status;
    error.safeDetails = {
      status: response.status,
      statusText: response.statusText,
      schwabError: parsed.error || null,
      schwabErrorDescription: parsed.error_description || null
    };
    throw error;
  }

  return parsed;
}

async function exchangeAuthorizationCode(code, setupSecret = "") {
  requireEnv(["SCHWAB_REDIRECT_URI"]);

  if (!code || typeof code !== "string" || code.trim().length < 8) {
    const error = new Error("Missing or invalid authorization code.");
    error.status = 400;
    throw error;
  }

  const tokenResponse = await postTokenRequest({
    grant_type: "authorization_code",
    code: code.trim(),
    redirect_uri: getEnv("SCHWAB_REDIRECT_URI")
  });

  await writeStoredTokenRecord({}, tokenResponse);
  return buildTokenResponsePayload(tokenResponse, setupSecret, "authorization_code", "schwab_token_exchange");
}

async function refreshAccessToken(refreshToken = "") {
  const resolved = await resolveRefreshToken(refreshToken);
  const token = resolved.refreshToken;

  if (!token) {
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

  const tokenResponse = await postTokenRequest({
    grant_type: "refresh_token",
    refresh_token: token
  });

  if (resolved.source === "netlify_blob_store" || tokenResponse.refresh_token) {
    await writeStoredTokenRecord(resolved.storedRecord || {}, {
      ...tokenResponse,
      refresh_token: tokenResponse.refresh_token || token
    });
  }

  return buildTokenResponsePayload(tokenResponse, "", "refresh_token", resolved.source);
}

function tokenExportAllowed(setupSecret = "") {
  const exportEnabled = getEnv("SCHWAB_TOKEN_EXPORT_ENABLED") === "true";
  const expectedSecret = getEnv("SCHWAB_SETUP_SECRET");
  return Boolean(exportEnabled && expectedSecret && setupSecret && setupSecret === expectedSecret);
}

function buildTokenResponsePayload(tokenResponse, setupSecret = "", grantType = "", tokenSource = "") {
  const exportTokens = tokenExportAllowed(setupSecret);

  const payload = {
    ok: true,
    grantType,
    tokenSource,
    marketDataOnly: true,
    accountAccessEnabled: false,
    tradingAccessEnabled: false,
    tokenReturnedToFrontend: exportTokens,
    accountDataReturnedToFrontend: false,
    metadata: tokenMetadata(tokenResponse),
    nextStep: exportTokens && tokenResponse.refresh_token
      ? "Save refresh_token into Netlify as SCHWAB_REFRESH_TOKEN, mark it secret, then disable SCHWAB_TOKEN_EXPORT_ENABLED."
      : "Token values are redacted. Refresh-token storage is server-side; token export is disabled unless setupSecret is provided during setup mode.",
    securityNote: MARKET_DATA_ONLY_NOTE
  };

  if (exportTokens) {
    payload.oneTimeTokenExport = {
      access_token: tokenResponse.access_token || null,
      refresh_token: tokenResponse.refresh_token || null,
      token_type: tokenResponse.token_type || null,
      expires_in: tokenResponse.expires_in || null,
      scope: tokenResponse.scope || null
    };
  }

  return payload;
}

async function parseRequest(req, url) {
  if (req.method === "GET") {
    return {
      action: url.searchParams.get("action") || "status",
      code: url.searchParams.get("code") || "",
      setupSecret: url.searchParams.get("setupSecret") || ""
    };
  }

  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = await req.json().catch(() => ({}));
    return payload || {};
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const form = new URLSearchParams(text);
    return Object.fromEntries(form.entries());
  }

  const text = await req.text().catch(() => "");
  if (text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return { action: "unknown" };
    }
  }

  return {};
}

function statusPayload() {
  return {
    ok: true,
    endpoint: "schwab-token",
    purpose: "Schwab OAuth authorization URL, token exchange, and token refresh helper",
    marketDataOnly: true,
    accountAccessEnabled: false,
    tradingAccessEnabled: false,
    tokenStore: {
      name: TOKEN_STORE_NAME,
      key: TOKEN_STORE_KEY
    },
    env: {
      SCHWAB_CLIENT_ID: Boolean(getEnv("SCHWAB_CLIENT_ID")),
      SCHWAB_CLIENT_SECRET: Boolean(getEnv("SCHWAB_CLIENT_SECRET")),
      SCHWAB_REDIRECT_URI: Boolean(getEnv("SCHWAB_REDIRECT_URI")),
      SCHWAB_TOKEN_URL: Boolean(getEnv("SCHWAB_TOKEN_URL")),
      SCHWAB_API_BASE_URL: Boolean(getEnv("SCHWAB_API_BASE_URL")),
      SCHWAB_REFRESH_TOKEN: Boolean(getEnv("SCHWAB_REFRESH_TOKEN")),
      SCHWAB_TOKEN_EXPORT_ENABLED: getEnv("SCHWAB_TOKEN_EXPORT_ENABLED") === "true",
      SCHWAB_SETUP_SECRET: Boolean(getEnv("SCHWAB_SETUP_SECRET"))
    },
    allowedActions: ["status", "authorize", "exchange", "refresh"],
    securityNote: MARKET_DATA_ONLY_NOTE
  };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  }

  if (!["GET", "POST"].includes(req.method)) {
    return json({ ok: false, error: "Method not allowed. Use GET or POST." }, 405);
  }

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return json({ ok: false, error: "Invalid request URL." }, 400);
  }

  try {
    const payload = await parseRequest(req, url);
    const action = String(payload.action || url.searchParams.get("action") || "status").toLowerCase();

    if (action === "status" || action === "health" || action === "test") {
      return json(statusPayload());
    }

    if (action === "authorize") {
      const authorizationUrl = buildAuthorizeUrl();
      return json({
        ok: true,
        action: "authorize",
        authorizationUrl,
        redirectUri: getEnv("SCHWAB_REDIRECT_URI"),
        marketDataOnly: true,
        accountAccessEnabled: false,
        tradingAccessEnabled: false,
        instructions: [
          "Open authorizationUrl in a browser.",
          "Authorize Market Data only.",
          "If Schwab shows brokerage accounts, uncheck every account before submitting.",
          "After redirect, schwab-callback auto-exchanges the authorization code server-side when enabled."
        ],
        securityNote: MARKET_DATA_ONLY_NOTE
      });
    }

    if (action === "exchange") {
      if (req.method !== "POST") {
        return json({ ok: false, error: "Use POST for token exchange. Do not place authorization codes in browser URLs." }, 405);
      }
      const result = await exchangeAuthorizationCode(payload.code, payload.setupSecret);
      return json(result);
    }

    if (action === "refresh") {
      if (req.method !== "POST") {
        return json({ ok: false, error: "Use POST for token refresh." }, 405);
      }
      const result = await refreshAccessToken(payload.refreshToken || "");
      return json(result);
    }

    return json({ ok: false, error: `Unsupported action: ${action}`, allowedActions: ["status", "authorize", "exchange", "refresh"] }, 400);
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Schwab token helper error.",
      details: error.safeDetails || undefined,
      marketDataOnly: true,
      tokenReturnedToFrontend: false,
      accountDataReturnedToFrontend: false
    }, error.status || 500);
  }
}
