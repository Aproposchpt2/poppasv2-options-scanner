// POPPA'S Option Scanner v3 — Scanner data control / recovery endpoint.
// Purpose: inspect Netlify Blob scan-board state and trigger/continue a CBOE EOD scan.

import { getStore } from "@netlify/blobs";

const STORE = "poppas-scan";
const LATEST_KEY = "latest";
const BUILD_KEY = "build";
const RUNNING_WINDOW_MS = 4 * 60 * 1000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function ageMs(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Date.now() - t : null;
}

function baseUrl(req) {
  try {
    const u = new URL(req.url);
    return process.env.URL || process.env.DEPLOY_URL || `${u.protocol}//${u.host}`;
  } catch (_) {
    return process.env.URL || process.env.DEPLOY_URL || "";
  }
}

async function readState() {
  const store = getStore(STORE);
  const latest = await store.get(LATEST_KEY, { type: "json" }).catch(() => null);
  const build = await store.get(BUILD_KEY, { type: "json" }).catch(() => null);
  const latestResults = Array.isArray(latest?.results) ? latest.results.length : 0;
  const buildRows = Array.isArray(build?.rows) ? build.rows.length : 0;
  const buildAge = ageMs(build?.updatedAt || build?.startedAt);
  const isBuildRunning = !!(build && build.status === "running" && buildAge !== null && buildAge < RUNNING_WINDOW_MS);

  let recommendation = "Unknown.";
  if (latestResults > 0 && !latest?.building) recommendation = "READY: latest board has rows and is not marked building.";
  else if (isBuildRunning) recommendation = "BUILDING: wait and poll this endpoint again.";
  else if (latest?.building || build?.status === "running") recommendation = "STALE BUILD: trigger continue or restart scan.";
  else recommendation = "EMPTY: trigger a fresh CBOE scan.";

  return {
    ok: true,
    action: "status",
    store: STORE,
    latestExists: !!latest,
    latestResults,
    latestGeneratedAt: latest?.generatedAt || null,
    latestBuilding: !!latest?.building,
    latestScanMode: latest?.scanMode || null,
    filterMode: latest?.filterMode || null,
    serverFiltersRemoved: latest?.serverFiltersRemoved || null,
    universeCount: latest?.universeCount ?? null,
    scanned: latest?.scanned ?? null,
    withCondor: latest?.withCondor ?? latestResults,
    passCount: latest?.passCount ?? null,
    buildExists: !!build,
    buildStatus: build?.status || null,
    buildStartedAt: build?.startedAt || null,
    buildUpdatedAt: build?.updatedAt || null,
    buildAgeSeconds: buildAge === null ? null : Math.round(buildAge / 1000),
    buildRunningFresh: isBuildRunning,
    buildScanned: build?.scanned ?? null,
    buildTotal: build?.total ?? null,
    buildPendingIdx: build?.pendingIdx ?? null,
    buildRows,
    progress: latest?.progress || build ? {
      scanned: build?.scanned ?? latest?.progress?.scanned ?? latest?.scanned ?? null,
      total: build?.total ?? latest?.progress?.total ?? latest?.universeCount ?? null,
      rows: buildRows || latestResults
    } : null,
    recommendation,
    endpoints: {
      status: "/.netlify/functions/force-eod-pull?status=1",
      scanResults: "/.netlify/functions/scan-results",
      triggerScan: "/.netlify/functions/force-eod-pull",
      scanBuilder: "/.netlify/functions/scan-build-background"
    }
  };
}

export default async (req) => {
  const method = req.method || "GET";
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || (method === "POST" ? "start" : "status");
  const base = baseUrl(req);

  if (method === "GET" || action === "status") {
    return json(await readState());
  }

  if (!base) {
    return json({ ok: false, error: "No base URL available to trigger scan-build-background." }, 500);
  }

  const continueParam = action === "continue" ? "?continue=1" : "";
  const endpoint = `${base}/.netlify/functions/scan-build-background${continueParam}`;

  let trigger = null;
  try {
    const res = await fetch(endpoint, { method: "POST" });
    let body = null;
    try { body = await res.json(); } catch (_) { body = await res.text().catch(() => null); }
    trigger = { ok: res.ok, status: res.status, body };
  } catch (err) {
    trigger = { ok: false, error: String(err?.message || err) };
  }

  const state = await readState();
  return json({
    ok: !!trigger?.ok,
    action,
    triggeredEndpoint: endpoint,
    trigger,
    state
  }, trigger?.ok ? 200 : 500);
};
