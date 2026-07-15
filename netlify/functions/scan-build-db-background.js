// POPPA'S Option Scanner v3 — durable Supabase scan orchestrator.
// Calls the existing DB batch builder directly and suppresses its legacy fire-and-forget continuation.
// Supabase remains the source of truth; Netlify Blob is not used here.

import scanBuildDb from "./scan-build-db.js";

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

function isLegacyBuilderContinuation(input) {
  try {
    const value = typeof input === "string" ? input : input?.url;
    const url = new URL(value);
    return url.pathname.endsWith("/.netlify/functions/scan-build-db") && url.searchParams.get("continue") === "1";
  } catch (_) {
    return false;
  }
}

async function invokeBuilder(base, restart) {
  const url = new URL(`${base}/.netlify/functions/scan-build-db`);
  url.searchParams.set(restart ? "restart" : "continue", "1");
  url.searchParams.set("orchestrated", "1");

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (isLegacyBuilderContinuation(input)) {
      return new Response(JSON.stringify({
        ok: true,
        suppressed: true,
        reason: "Durable background orchestrator owns continuation"
      }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    return nativeFetch(input, init);
  };

  try {
    const response = await scanBuildDb(new Request(url, {
      method: "POST",
      headers: { "Accept": "application/json", "X-POPPA-DB-Orchestrator": "true" }
    }));

    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; }
    catch (_) { body = { raw: text.slice(0, 1000) }; }

    if (!response.ok || body?.ok === false) {
      const error = new Error(body?.error || `scan-build-db failed with ${response.status}`);
      error.status = response.status || 500;
      error.details = body;
      throw error;
    }

    return body || {};
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

async function dispatchContinuation(base, cycle) {
  const url = new URL(`${base}/.netlify/functions/scan-build-db-background`);
  url.searchParams.set("restart", "0");
  if (cycle) url.searchParams.set("cycle", cycle);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Accept": "application/json", "X-POPPA-DB-Continuation": "true" }
  });

  return { dispatched: response.ok, status: response.status, target: url.pathname };
}

export default async (req) => {
  const orchestrationStartedAt = new Date();
  const startedMs = orchestrationStartedAt.getTime();
  const requestUrl = new URL(req.url);
  const base = baseUrl(req);
  const cycle = requestUrl.searchParams.get("cycle") || "manual-db-scan";
  let restart = requestUrl.searchParams.get("restart") !== "0";
  let iterations = 0;
  let last = null;
  let continuation = null;

  try {
    while (Date.now() - startedMs < MAX_ORCHESTRATOR_MS - CONTINUATION_BUFFER_MS) {
      last = await invokeBuilder(base, restart);
      restart = false;
      iterations += 1;

      const total = Number(last.total || 0);
      const pending = Number(last.pendingIndex || last.scanned || 0);
      const complete = last.status === "completed" || (total > 0 && pending >= total);
      if (complete) break;

      await sleep(LOOP_DELAY_MS);
    }

    const total = Number(last?.total || 0);
    const pending = Number(last?.pendingIndex || last?.scanned || 0);
    const complete = last?.status === "completed" || (total > 0 && pending >= total);

    if (!complete) continuation = await dispatchContinuation(base, cycle);

    const finishedAt = new Date();
    const elapsedSeconds = Math.round((finishedAt.getTime() - startedMs) / 1000);

    console.log(JSON.stringify({
      project: "POPPA'S Option Scanner",
      component: "scan-build-db-background",
      cycle,
      complete,
      iterations,
      elapsedSeconds,
      pendingIndex: pending,
      total,
      continuation
    }));

    return json({
      ok: true,
      storagePath: "supabase-source-of-truth",
      cycle,
      complete,
      iterations,
      orchestrationStartedAt: orchestrationStartedAt.toISOString(),
      orchestrationFinishedAt: finishedAt.toISOString(),
      elapsedSeconds,
      elapsedMinutes: Number((elapsedSeconds / 60).toFixed(2)),
      pendingIndex: pending,
      scanned: Number(last?.scanned || pending),
      total,
      candidateCount: Number(last?.candidateCount || 0),
      lastBuilderResult: last,
      continuation,
      legacyBuilderContinuationSuppressed: true,
      blobUsed: false
    });
  } catch (error) {
    const elapsedSeconds = Math.round((Date.now() - startedMs) / 1000);
    console.error(JSON.stringify({
      project: "POPPA'S Option Scanner",
      component: "scan-build-db-background",
      cycle,
      event: "orchestrator-failed",
      elapsedSeconds,
      message: error.message || String(error)
    }));
    return json({
      ok: false,
      storagePath: "supabase-source-of-truth",
      cycle,
      elapsedSeconds,
      error: error.message || String(error),
      details: error.details || null,
      legacyBuilderContinuationSuppressed: true,
      blobUsed: false
    }, error.status || 500);
  }
};
