import { getStore } from "@netlify/blobs";

// POPPA'S Option Scanner v3 — proactive Schwab authorization-age alert.
// Schwab requires a full manual reauthorization roughly every 7 days. The
// access token can refresh many times inside that window, so access-token
// refresh timestamps must never reset the full-authorization age clock.

export const config = { schedule: "0 14 * * *" }; // ~7 AM Pacific daily

const TOKEN_STORE_NAME = process.env.SCHWAB_TOKEN_STORE_NAME || "schwab-oauth";
const TOKEN_STORE_KEY = process.env.SCHWAB_TOKEN_STORE_KEY || "latest-token";
const ALERT_THRESHOLD_DAYS = 6;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
const RESEND_TO_EMAIL = process.env.RESEND_TO_EMAIL;
const RESEND_CC_EMAIL = process.env.RESEND_CC_EMAIL;

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
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

function baseUrl() {
  return process.env.URL || process.env.DEPLOY_URL || "";
}

async function sendAlert({ subject, message }) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL || !RESEND_TO_EMAIL) {
    return { sent: false, reason: "RESEND_API_KEY / RESEND_FROM_EMAIL / RESEND_TO_EMAIL not configured" };
  }
  const payload = {
    from: RESEND_FROM_EMAIL,
    to: RESEND_TO_EMAIL,
    subject,
    text: message
  };
  if (RESEND_CC_EMAIL) {
    payload.cc = RESEND_CC_EMAIL;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await res.text().catch(() => "");
  return { sent: res.ok, status: res.status, body: text.slice(0, 300) };
}

async function resolveAuthorizeUrl() {
  const statusEndpoint = `${baseUrl()}/.netlify/functions/schwab-token?action=authorize`;
  try {
    const res = await fetch(statusEndpoint);
    const payload = await res.json();
    if (res.ok && payload?.authorizationUrl) {
      return payload.authorizationUrl;
    }
  } catch (_) {
    // fall through to the safe helper endpoint below
  }
  return statusEndpoint;
}

async function sendReauthorizationAlert(message) {
  const authorizationUrl = await resolveAuthorizeUrl();
  return sendAlert({
    subject: "POPPA'S Scanner: Schwab reauthorization needed",
    message: `${message}\n\nClick this link, log in with Schwab, and authorize Market Data only (uncheck any brokerage accounts shown before submitting):\n\n${authorizationUrl}\n\nThat's it -- no code or confirmation needs to be sent back after you submit.`
  });
}

export default async () => {
  const record = await readStoredTokenRecord();

  if (!record) {
    const alert = await sendReauthorizationAlert("The scanner cannot pull data until Schwab is reauthorized.");
    return json({ ok: true, tokenFound: false, ageBasis: "authorization_received_at", alertSent: alert.sent, alert });
  }

  const authorizationReceivedAt = record.authorization_received_at;
  const authorizationTime = authorizationReceivedAt ? new Date(authorizationReceivedAt).getTime() : NaN;

  if (!authorizationReceivedAt || !Number.isFinite(authorizationTime)) {
    const alert = await sendReauthorizationAlert(
      "The stored Schwab token does not contain a reliable full-authorization timestamp. Reauthorization is required now so the 7-day renewal clock can be tracked correctly."
    );
    return json({
      ok: true,
      tokenFound: true,
      authorizationTimestampFound: false,
      ageBasis: "authorization_received_at",
      alertSent: alert.sent,
      alert
    });
  }

  const ageDays = (Date.now() - authorizationTime) / 86400000;

  if (ageDays < ALERT_THRESHOLD_DAYS) {
    return json({
      ok: true,
      tokenFound: true,
      authorizationTimestampFound: true,
      ageBasis: "authorization_received_at",
      ageDays: Number(ageDays.toFixed(2)),
      thresholdDays: ALERT_THRESHOLD_DAYS,
      alertSent: false
    });
  }

  const alert = await sendReauthorizationAlert(
    `Schwab access for the scanner needs to be renewed (the last full Schwab authorization was ${ageDays.toFixed(1)} days ago, and Schwab requires renewal about every 7 days).`
  );

  return json({
    ok: true,
    tokenFound: true,
    authorizationTimestampFound: true,
    ageBasis: "authorization_received_at",
    ageDays: Number(ageDays.toFixed(2)),
    thresholdDays: ALERT_THRESHOLD_DAYS,
    alertSent: alert.sent,
    alert
  });
};
