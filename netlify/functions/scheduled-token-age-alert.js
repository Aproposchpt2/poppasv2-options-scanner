import { getStore } from "@netlify/blobs";

// POPPA'S Option Scanner v3 — proactive Schwab token-age alert.
// Schwab refresh tokens require a full manual reauthorization roughly every
// 7 days (they don't silently renew indefinitely like a typical access
// token). A lapsed token doesn't throw an error anywhere -- scan-build-db.js
// treats every failed Schwab call as "no data for this symbol" and just
// moves on, so a scheduled scan can complete looking perfectly healthy
// (no error, full universe scanned) while producing zero candidates. This
// runs once a day and emails a warning once the stored token is 6+ days
// old, so reauthorization happens before the hard cutoff instead of after
// a customer reports empty results.

export const config = { schedule: "0 14 * * *" }; // ~7 AM Pacific daily

const TOKEN_STORE_NAME = process.env.SCHWAB_TOKEN_STORE_NAME || "schwab-oauth";
const TOKEN_STORE_KEY = process.env.SCHWAB_TOKEN_STORE_KEY || "latest-token";
const ALERT_THRESHOLD_DAYS = 6;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
const RESEND_TO_EMAIL = process.env.RESEND_TO_EMAIL;

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
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: RESEND_TO_EMAIL,
      subject,
      text: message
    })
  });
  const text = await res.text().catch(() => "");
  return { sent: res.ok, status: res.status, body: text.slice(0, 300) };
}

export default async () => {
  const record = await readStoredTokenRecord();
  const authorizeUrl = `${baseUrl()}/.netlify/functions/schwab-token?action=authorize`;

  if (!record || !record.received_at) {
    const alert = await sendAlert({
      subject: "POPPA'S Scanner: no Schwab token on file",
      message: `No Schwab OAuth token is currently stored. The scanner cannot pull data until this is authorized.\n\nGet the authorization URL from: ${authorizeUrl}\n\nOpen that URL's "authorizationUrl" value in a browser, log in with Schwab, authorize Market Data only, and uncheck any brokerage accounts before submitting.`
    });
    return json({ ok: true, tokenFound: false, alert });
  }

  const receivedAt = new Date(record.received_at);
  const ageDays = (Date.now() - receivedAt.getTime()) / 86400000;

  if (ageDays < ALERT_THRESHOLD_DAYS) {
    return json({ ok: true, tokenFound: true, ageDays: Number(ageDays.toFixed(2)), thresholdDays: ALERT_THRESHOLD_DAYS, alertSent: false });
  }

  const alert = await sendAlert({
    subject: `POPPA'S Scanner: Schwab reauthorization needed (token is ${ageDays.toFixed(1)} days old)`,
    message: `The stored Schwab token was last refreshed ${ageDays.toFixed(1)} days ago (received_at: ${record.received_at}). Schwab requires a full manual reauthorization roughly every 7 days, and a lapsed token fails silently -- scans complete with no error but zero candidates.\n\nReauthorize before this breaks: get the authorization URL from ${authorizeUrl}, open the returned "authorizationUrl" in a browser, log in with Schwab, authorize Market Data only, and uncheck any brokerage accounts before submitting.`
  });

  return json({ ok: true, tokenFound: true, ageDays: Number(ageDays.toFixed(2)), thresholdDays: ALERT_THRESHOLD_DAYS, alertSent: alert.sent, alert });
};
