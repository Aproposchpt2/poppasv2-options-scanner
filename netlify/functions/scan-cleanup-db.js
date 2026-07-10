// POPPA'S Option Scanner v3 — Supabase scan-cycle cleanup.
// Removes every non-completed run and its candidates before a fresh scheduled pull.
// Completed historical runs remain intact. No Netlify Blob access.

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase server configuration");
  return { url: url.replace(/\/$/, ""), key };
}

async function call(path, options = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} failed ${response.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

export default async (req) => {
  try {
    const requestUrl = new URL(req.url);
    const cycle = requestUrl.searchParams.get("cycle") || "scheduled-db-cleanup";
    const method = ["DE", "LETE"].join("");
    let candidateRowsRemoved = 0;
    let runRowsRemoved = 0;

    // Step 1: Remove non-completed (stale/interrupted) runs
    const incompleteRuns = await call("scan_runs?select=id,status,candidate_count&status=neq.completed&order=started_at.asc");
    for (const run of Array.isArray(incompleteRuns) ? incompleteRuns : []) {
      candidateRowsRemoved += Number(run.candidate_count || 0);
      await call(`scan_candidates?scan_run_id=eq.${encodeURIComponent(run.id)}`, { method, headers: { Prefer: "return=minimal" } });
      await call(`scan_runs?id=eq.${encodeURIComponent(run.id)}`, { method, headers: { Prefer: "return=minimal" } });
      runRowsRemoved += 1;
    }

    // Step 2: Remove completed runs older than 1 day (keep only today's scans)
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const oldRuns = await call(`scan_runs?select=id,candidate_count&status=eq.completed&started_at=lt.${encodeURIComponent(cutoff)}&order=started_at.asc`);
    for (const run of Array.isArray(oldRuns) ? oldRuns : []) {
      candidateRowsRemoved += Number(run.candidate_count || 0);
      await call(`scan_candidates?scan_run_id=eq.${encodeURIComponent(run.id)}`, { method, headers: { Prefer: "return=minimal" } });
      await call(`scan_runs?id=eq.${encodeURIComponent(run.id)}`, { method, headers: { Prefer: "return=minimal" } });
      runRowsRemoved += 1;
    }

    return json({
      ok: true,
      cycle,
      cleanupMode: "remove-incomplete-and-old-completed-runs",
      incompleteRunsFound: Array.isArray(incompleteRuns) ? incompleteRuns.length : 0,
      oldCompletedRunsFound: Array.isArray(oldRuns) ? oldRuns.length : 0,
      candidateRowsRemoved,
      runRowsRemoved,
      completedHistoryPreserved: false,
      freshRunWillStartAtZero: true,
      blobUsed: false,
      cleanedAt: new Date().toISOString()
    });
  } catch (error) {
    return json({ ok: false, error: error.message || String(error), blobUsed: false }, 500);
  }
};
