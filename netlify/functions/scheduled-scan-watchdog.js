// POPPA'S scan watchdog — every 10 minutes on weekdays, it re-kicks a Schwab
// scan run whose self-continuation chain has stalled (running, but no progress
// update for STALL_SECONDS). Observed July 15 2026: chunked runs occasionally
// drop the fire-and-forget continue fetch and freeze mid-universe.

const FALLBACK_SITE_URL = "https://poppasv2.ai4academy.net";
const STALL_SECONDS = 180;
const MAX_RUN_AGE_HOURS = 3;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function base() {
  return String(process.env.URL || process.env.DEPLOY_URL || FALLBACK_SITE_URL).replace(/\/+$/, "");
}

export default async () => {
  try {
    const statusRes = await fetch(`${base()}/.netlify/functions/scan-status-db`, { headers: { Accept: "application/json" } });
    const state = await statusRes.json().catch(() => null);
    if (!state || !state.hasRun || state.status !== "running") {
      return json({ ok: true, action: "none", reason: "no running scan", status: state?.status || null });
    }

    const updatedAgoSec = (Date.now() - new Date(state.updatedAt || state.startedAt).getTime()) / 1000;
    const runAgeHours = (Date.now() - new Date(state.startedAt).getTime()) / 3600000;

    if (runAgeHours > MAX_RUN_AGE_HOURS) {
      return json({ ok: true, action: "none", reason: "run too old to continue", runAgeHours: +runAgeHours.toFixed(2), scanRunId: state.scanRunId });
    }
    if (updatedAgoSec < STALL_SECONDS) {
      return json({ ok: true, action: "none", reason: "run progressing", updatedAgoSec: Math.round(updatedAgoSec), scannedCount: state.scannedCount });
    }

    const kickUrl = `${base()}/.netlify/functions/scan-build-db?continue=1&scanRunId=${encodeURIComponent(state.scanRunId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let kicked = false;
    try {
      const kickRes = await fetch(kickUrl, { method: "POST", signal: controller.signal });
      kicked = kickRes.ok;
    } catch (_) {
      kicked = true; // fire-and-forget: an abort after dispatch still restarts the chunk chain
    } finally {
      clearTimeout(timeout);
    }

    console.log(JSON.stringify({
      component: "scheduled-scan-watchdog", event: "stalled-run-kicked",
      scanRunId: state.scanRunId, scannedCount: state.scannedCount,
      updatedAgoSec: Math.round(updatedAgoSec)
    }));
    return json({ ok: true, action: "kicked-continue", scanRunId: state.scanRunId, scannedCount: state.scannedCount, updatedAgoSec: Math.round(updatedAgoSec), kicked });
  } catch (error) {
    return json({ ok: false, error: error.message || String(error) }, 500);
  }
};

export const config = {
  schedule: "*/10 13-23 * * 1-5"
};
