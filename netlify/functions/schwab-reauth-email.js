import { getStore } from "@netlify/blobs";

// POPPA'S manual Schwab reauthorization-email recovery trigger.
// This endpoint never returns OAuth tokens or the generated Schwab URL. It
// can only email the server-configured recipient(s), and repeated sends are
// cooldown-limited to reduce abuse if temporarily enabled for browser use.

const TOKEN_STORE_NAME = process.env.SCHWAB_TOKEN_STORE_NAME || "schwab-oauth";
const MANUAL_ALERT_KEY = "manual-reauth-alert-last-sent";
const COOLDOWN_MS = 30 * 60 * 1000;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
const RESEND_TO_EMAIL = process.env.RESEND_TO_EMAIL;
const RESEND_CC_EMAIL = process.env.RESEND_CC_EMAIL;

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function baseUrl(req) {
  const url = new URL(req.url);
  return process.env.URL || process.env.DEPLOY_URL || `${url.protocol}//${url.host}`;
}

function temporaryBrowserAccessAllowed(url) {
  return process.env.SCHWAB_REAUTH_MANUAL_PUBLIC_ENABLED === "true" && url.searchParams.get("send") === "1";
}

function setupSecretAccessAllowed(req) {
  const expected = process.env.SCHWAB_SETUP_SECRET || "";
  if (!expected) return false;
  const authorization = req.headers.get("authorization") || "";
  return authorization === `Bearer ${expected}`;
}

async function resolveAuthorizeUrl(req) {
  const endpoint = `${baseUrl(req)}/.netlify/functions/schwab-token?action=authorize`;
  const res = await fetch(endpoint, { headers: { Accept: "application/json" } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload?.authorizationUrl) {
    throw new Error(`Unable to generate Schwab authorization URL (${res.status}).`);
  }
  const authorizationUrl = String(payload.authorizationUrl);
  if (!authorizationUrl.startsWith("https://api.schwabapi.com/v1/oauth/authorize")) {
    throw new Error("Generated Schwab authorization URL failed provider validation.");
  }
  return authorizationUrl;
}

async function sendAlert(authorizationUrl) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL || !RESEND_TO_EMAIL) {
    throw new Error("RESEND_API_KEY / RESEND_FROM_EMAIL / RESEND_TO_EMAIL not configured");
  }
  const payload = {
    from: RESEND_FROM_EMAIL,
    to: RESEND_TO_EMAIL,
    subject: "POPPA'S Scanner: Schwab reauthorization needed",
    text: `Schwab access for the scanner needs to be renewed.\n\nClick this link, log in with Schwab, and authorize Market Data only (uncheck any brokerage accounts shown before submitting):\n\n${authorizationUrl}\n\nThat's it -- no code or confirmation needs to be sent back after you submit.`
  };
  if (RESEND_CC_EMAIL) payload.cc = RESEND_CC_EMAIL;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const responseText = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Resend rejected the reauthorization email (${res.status}): ${responseText.slice(0, 180)}`);
  }
  return { status: res.status };
}

async function readLastSentAt() {
  try {
    const store = getStore(TOKEN_STORE_NAME);
    const value = await store.get(MANUAL_ALERT_KEY);
    return value ? new Date(value).getTime() : NaN;
  } catch (_) {
    return NaN;
  }
}

async function writeLastSentAt() {
  const store = getStore(TOKEN_STORE_NAME);
  await store.set(MANUAL_ALERT_KEY, new Date().toISOString());
}

export default async function handler(req) {
  if (!["GET", "POST"].includes(req.method)) {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return json({ ok: false, error: "Invalid request URL." }, 400);
  }

  const accessMode = setupSecretAccessAllowed(req)
    ? "operator-secret"
    : temporaryBrowserAccessAllowed(url)
      ? "temporary-browser"
      : null;

  if (!accessMode) {
    return json({
      ok: false,
      error: "Manual Schwab reauthorization trigger is not enabled for this request.",
      authorizationUrlReturned: false
    }, 403);
  }

  const lastSentAt = await readLastSentAt();
  const elapsed = Number.isFinite(lastSentAt) ? Date.now() - lastSentAt : Infinity;
  if (elapsed < COOLDOWN_MS) {
    return json({
      ok: true,
      alertSent: false,
      reason: "cooldown",
      retryAfterMinutes: Math.ceil((COOLDOWN_MS - elapsed) / 60000),
      authorizationUrlReturned: false
    });
  }

  try {
    const authorizationUrl = await resolveAuthorizeUrl(req);
    const email = await sendAlert(authorizationUrl);
    await writeLastSentAt();
    return json({
      ok: true,
      alertSent: true,
      emailStatus: email.status,
      accessMode,
      authorizationUrlReturned: false,
      recipientLockedToServerConfiguration: true
    });
  } catch (error) {
    return json({
      ok: false,
      alertSent: false,
      error: error.message || "Manual Schwab reauthorization email failed.",
      authorizationUrlReturned: false
    }, 500);
  }
}
