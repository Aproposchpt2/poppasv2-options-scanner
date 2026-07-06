// POPPA'S Option Scanner v3 — scheduled CBOE EOD ingestion trigger.
// Schedule: Monday-Friday at 3:30 PM PST.
// Cron is UTC-based here: 3:30 PM PST = 23:30 UTC.
// This scheduled trigger REPLACES the prior dataset before starting a fresh Supabase-backed EOD scan.
// Upstream ingestion rule remains narrow: monthly option chain only, 15-45 DTE only.
// All ROC, probability, IV, OI, bid/ask spread, earnings, width, EM Status, and ranking filters stay in user Band Intake / scan-results-db.js.

export const config = {
  schedule: "30 23 * * 1-5"
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function sbConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return { url: url.replace(/\/$/, ""), key };
}

async function sbFetch(path, opts = {}) {
  const { url, key } = sbConfig();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(opts.headers || {})
    }
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} failed ${res.status}: ${text}`);
  return { text, headers: res.headers };
}

function baseUrl(req) {
  try {
    const u = new URL(req.url);
    return process.env.URL || process.env.DEPLOY_URL || `${u.protocol}//${u.host}`;
  } catch (_) {
    return process.env.URL || process.env.DEPLOY_URL || "";
  }
}

async function countRows(table) {
  const { headers } = await sbFetch(`${table}?select=id`, { method: "HEAD", headers: { Prefer: "count=exact" } });
  const cr = headers.get("content-range") || "";
  const m = cr.match(/\/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

async function purgePriorDataset() {
  const priorRuns = await countRows("scan_runs").catch(() => 0);
  const priorCandidates = await countRows("scan_candidates").catch(() => 0);
  await sbFetch("scan_runs?id=not.is.null", { method: "DELETE", headers: { Prefer: "return=minimal" } });
  return {
    priorRuns,
    priorCandidates,
    replacementRule: "Fresh scheduled EOD pull replaces the prior Supabase dataset."
  };
}

export default async (req) => {
  const base = baseUrl(req);
  if (!base) {
    return json({ ok: false, error: "No base URL available for scheduled EOD scan trigger." }, 500);
  }

  let purge;
  try {
    purge = await purgePriorDataset();
  } catch (err) {
    return json({ ok: false, action: "daily-eod-scan", stage: "purge-prior-dataset", error: String(err?.message || err) }, 500);
  }

  const endpoint = `${base}/.netlify/functions/scan-build-db?restart=1&source=daily-eod-schedule`;
  let trigger;
  try {
    const res = await fetch(endpoint, { method: "POST", headers: { accept: "application/json" } });
    let body;
    try { body = await res.json(); } catch (_) { body = await res.text().catch(() => null); }
    trigger = { ok: res.ok, status: res.status, body };
  } catch (err) {
    trigger = { ok: false, error: String(err?.message || err) };
  }

  return json({
    ok: !!trigger?.ok,
    action: "daily-eod-scan",
    schedule: "Mon-Fri 1:05 PM PST / 21:05 UTC",
    dataSource: "CBOE EOD delayed data",
    retentionRule: "Each scheduled EOD data pull replaces the prior day's Supabase scan data.",
    purge,
    upstreamFiltersOnly: ["Monthly option chain", "15-45 DTE"],
    userBandFilters: ["ROC", "Probability", "IV", "Open interest", "Short-leg OI", "Bid/ask spread", "Earnings", "Width", "Expected Move Status", "IV Status", "Rank By"],
    triggeredEndpoint: endpoint,
    trigger
  }, trigger?.ok ? 200 : 500);
};
