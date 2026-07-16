// POPPA'S Option Scanner v3 — durable Directional Bias orchestrator.
// Calls bias-build-db.js directly and awaits it in-process, looping until the day's universe
// is fully scored or the orchestrator's own time budget runs out. Unlike scan-build-db.js's
// legacy self-continuation (the un-awaited fire-and-forget fetch that caused the stall fixed
// earlier this session), bias-build-db.js has no internal continuation call to suppress — it
// simply reports how much of the universe it covered and returns. This orchestrator is the
// only thing that loops it, built safe from day one.

import biasBuildDb from "./bias-build-db.js";

const MAX_ORCHESTRATOR_MS = 13 * 60 * 1000;
const CONTINUATION_BUFFER_MS = 45 * 1000;
const LOOP_DELAY_MS = 350;
const FALLBACK_SITE_URL = "https://poppasv2.ai4academy.net";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function baseUrl(req) {
  try {
    const url = new URL(req.url);
    return String(process.env.URL || process.env.DEPLOY_URL || `${url.protocol}//${url.host}` || FALLBACK_SITE_URL).replace(/\/+$/, "");
  } catch (_) {
    return String(process.env.URL || process.env.DEPLOY_URL || FALLBACK_SITE_URL).replace(/\/+$/, "");
  }
}

async function invokeBuilder(base) {
  const url = new URL(`${base}/.netlify/functions/bias-build-db`);
  const response = await biasBuildDb(new Request(url, {
    method: "POST",
    headers: { "Accept": "application/json", "X-POPPA-Bias-Orchestrator": "true" }
  }));

  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch (_) { body = { raw: text.slice(0, 1000) }; }

  if (!response.ok || body?.ok === false) {
    const error = new Error(body?.error || `bias-build-db failed with ${response.status}`);
    error.status = response.status || 500;
    error.details = body;
    throw error;
  }

  return body || {};
}

async function dispatchContinuation(base, cycle) {
  const url = new URL(`${base}/.netlify/functions/bias-build-db-background`);
  if (cycle) url.searchParams.set("cycle", cycle);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Accept": "application/json", "X-POPPA-Bias-Continuation": "true" }
  });

  return { dispatched: response.ok, status: response.status, target: url.pathname };
}

export default async (req) => {
  const orchestrationStartedAt = new Date();
  const startedMs = orchestrationStartedAt.getTime();
  const requestUrl = new URL(req.url);
  const base = baseUrl(req);
  const cycle = requestUrl.searchParams.get("cycle") || "manual-bias-refresh";
  let iterations = 0;
  let last = null;
  let continuation = null;

  try {
    while (Date.now() - startedMs < MAX_ORCHESTRATOR_MS - CONTINUATION_BUFFER_MS) {
      last = await invokeBuilder(base);
      iterations += 1;

      if (last.complete) break;
      if (!last.remaining) break; // nothing pending and not flagged complete — avoid an infinite loop on an unexpected shape
      await sleep(LOOP_DELAY_MS);
    }

    const complete = Boolean(last?.complete);
    if (!complete) continuation = await dispatchContinuation(base, cycle);

    const finishedAt = new Date();
    const elapsedSeconds = Math.round((finishedAt.getTime() - startedMs) / 1000);

    console.log(JSON.stringify({
      project: "POPPA'S Option Scanner",
      component: "bias-build-db-background",
      cycle,
      complete,
      iterations,
      elapsedSeconds,
      remaining: last?.remaining,
      total: last?.total,
      continuation
    }));

    return json({
      ok: true,
      cycle,
      complete,
      iterations,
      orchestrationStartedAt: orchestrationStartedAt.toISOString(),
      orchestrationFinishedAt: finishedAt.toISOString(),
      elapsedSeconds,
      elapsedMinutes: Number((elapsedSeconds / 60).toFixed(2)),
      lastBuilderResult: last,
      continuation
    });
  } catch (error) {
    const elapsedSeconds = Math.round((Date.now() - startedMs) / 1000);
    console.error(JSON.stringify({
      project: "POPPA'S Option Scanner",
      component: "bias-build-db-background",
      cycle,
      event: "orchestrator-failed",
      elapsedSeconds,
      message: error.message || String(error)
    }));
    return json({
      ok: false,
      cycle,
      elapsedSeconds,
      error: error.message || String(error),
      details: error.details || null
    }, error.status || 500);
  }
};
