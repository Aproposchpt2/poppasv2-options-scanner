import { getStore } from "@netlify/blobs";

// POPPA'S Option Scanner v3 — Schwab OAuth callback receiver and token exchanger
// Purpose: receive Schwab OAuth callback codes and exchange them immediately server-side.
// Security: this function never displays, logs, or returns authorization codes, tokens, account IDs,
// account hashes, balances, positions, orders, or any account/trading data.

const SECURITY_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};

const TOKEN_STORE_NAME = process.env.SCHWAB_TOKEN_STORE_NAME || "schwab-oauth";
const TOKEN_STORE_KEY = process.env.SCHWAB_TOKEN_STORE_KEY || "latest-token";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function html(title, body, status = 200) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #070d18;
      color: #f4f7fb;
      font-family: Arial, Helvetica, sans-serif;
    }
    main {
      max-width: 760px;
      margin: 24px;
      padding: 28px;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.03));
      box-shadow: 0 24px 70px rgba(0,0,0,.35);
    }
    .eyebrow {
      color: #d6ad47;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: .14em;
      text-transform: uppercase;
      margin-bottom: 10px;
    }
    h1 { margin: 0 0 14px; font-size: 28px; line-height: 1.2; }
    p { color: #d7e3f3; line-height: 1.55; }
    .ok { color: #4df0a4; font-weight: 800; }
    .warn { color: #ffce6a; font-weight: 800; }
    code {
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px;
      padding: 2px 6px;
      color: #cfe7ff;
    }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">POPPA'S Option Scanner v3</div>
    ${body}
  </main>
</body>
</html>`, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getSchwabConfig() {
  return {
    clientId: requiredEnv("SCHWAB_CLIENT_ID"),
    clientSecret: requiredEnv("SCHWAB_CLIENT_SECRET"),
    redirectUri: requiredEnv("SCHWAB_REDIRECT_URI"),
    tokenUrl: requiredEnv("SCHWAB_TOKEN_URL")
  };
}

async function exchangeAuthorizationCode(code, config) {
  const credentials = `${config.clientId}:${config.clientSecret}`;
  const basic = btoa(credentials);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri
  });

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    payload = { error: "non_json_token_response" };
  }

  if (!response.ok) {
    const error = payload?.error || "token_exchange_failed";
    const description = payload?.error_description || "Schwab token endpoint returned an error.";
    throw new Error(`${error}: ${description}`);
  }

  if (!payload?.refresh_token) {
    throw new Error("Schwab token response did not include a refresh token.");
  }

  return payload;
}

async function storeTokenResponse(tokenResponse, sessionId = "") {
  const receivedAt = new Date();
  const expiresIn = Number(tokenResponse.expires_in || 0);
  const tokenRecord = {
    provider: "schwab",
    marketDataOnly: true,
    token_type: tokenResponse.token_type || "Bearer",
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_in: tokenResponse.expires_in,
    scope: tokenResponse.scope,
    received_at: receivedAt.toISOString(),
    access_token_expires_at: expiresIn > 0 ? new Date(receivedAt.getTime() + expiresIn * 1000).toISOString() : null,
    session_id: sessionId || null,
    tokenReturnedToFrontend: false,
    accountDataReturnedToFrontend: false
  };

  const store = getStore(TOKEN_STORE_NAME);
  await store.set(TOKEN_STORE_KEY, JSON.stringify(tokenRecord));

  return {
    storeName: TOKEN_STORE_NAME,
    storeKey: TOKEN_STORE_KEY,
    receivedAt: tokenRecord.received_at,
    accessTokenExpiresAt: tokenRecord.access_token_expires_at
  };
}

function safeErrorMessage(error) {
  const message = error?.message || "Unknown error.";
  return escapeHtml(message.replace(/code=[^&\s]+/gi, "code=[redacted]"));
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  }

  if (req.method !== "GET") {
    return json({ ok: false, error: "Method not allowed. Schwab OAuth callback accepts GET only." }, 405);
  }

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return json({ ok: false, error: "Invalid request URL." }, 400);
  }

  const health = url.searchParams.get("health") === "1" || url.searchParams.get("test") === "1";
  if (health) {
    return json({
      ok: true,
      endpoint: "schwab-callback",
      purpose: "Schwab OAuth redirect receiver and immediate token exchanger",
      redirectUriConfigured: Boolean(process.env.SCHWAB_REDIRECT_URI),
      tokenUrlConfigured: Boolean(process.env.SCHWAB_TOKEN_URL),
      clientIdConfigured: Boolean(process.env.SCHWAB_CLIENT_ID),
      clientSecretConfigured: Boolean(process.env.SCHWAB_CLIENT_SECRET),
      tokenStoreName: TOKEN_STORE_NAME,
      tokenStoreKey: TOKEN_STORE_KEY,
      marketDataOnly: true,
      accountAccessEnabled: false,
      tradingAccessEnabled: false,
      tokenReturnedToFrontend: false,
      accountDataReturnedToFrontend: false
    });
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const description = url.searchParams.get("error_description") || "Schwab returned an authorization error.";
    return html(
      "Schwab authorization error",
      `<h1>Schwab authorization returned an error</h1>
       <p><span class="warn">Status:</span> Authorization was not completed.</p>
       <p><strong>Error:</strong> ${escapeHtml(oauthError)}</p>
       <p><strong>Description:</strong> ${escapeHtml(description)}</p>
       <p>No Schwab token, account data, order data, or trading data was returned by this endpoint.</p>`,
      400
    );
  }

  const code = url.searchParams.get("code");
  if (code) {
    try {
      const config = getSchwabConfig();
      const tokenResponse = await exchangeAuthorizationCode(code, config);
      const storage = await storeTokenResponse(tokenResponse, url.searchParams.get("session") || "");

      return html(
        "Schwab authorization complete",
        `<h1>Schwab authorization complete</h1>
         <p><span class="ok">Status:</span> Authorization code exchanged successfully inside the backend callback window.</p>
         <p>The Schwab token response was stored server-side in the secure Netlify token store.</p>
         <p><strong>Stored At:</strong> ${escapeHtml(storage.receivedAt)}</p>
         <p><strong>Access Token Expires At:</strong> ${escapeHtml(storage.accessTokenExpiresAt || "Not provided")}</p>
         <p>For security, this page does not display or return authorization codes, access tokens, refresh tokens, account data, balances, positions, orders, or trading data.</p>
         <p>Market-data-only rule remains active: do not authorize accounts, trading, balances, positions, orders, or ACCT_ACTIVITY.</p>`,
        200
      );
    } catch (error) {
      return html(
        "Schwab token exchange failed",
        `<h1>Schwab token exchange failed</h1>
         <p><span class="warn">Status:</span> The callback was received, but the backend token exchange or token storage step failed.</p>
         <p><strong>Safe error:</strong> ${safeErrorMessage(error)}</p>
         <p>No Schwab token, account data, order data, or trading data was returned to the browser.</p>
         <p>If the error mentions an expired or invalid grant, generate a brand new Schwab authorization link and retry immediately.</p>`,
        400
      );
    }
  }

  return html(
    "Schwab callback ready",
    `<h1>Schwab callback endpoint is ready</h1>
     <p><span class="ok">Status:</span> Deployed callback route is reachable.</p>
     <p>Use this exact endpoint path as the Schwab Developer Portal Callback URL / Redirect URI:</p>
     <p><code>/.netlify/functions/schwab-callback</code></p>
     <p>This endpoint is market-data-only and does not request or expose Schwab account information.</p>`,
    200
  );
}
