// POPPA'S Option Scanner v3 — Supabase scan timing/status endpoint.
// Provides elapsed time, progress, and remaining-symbol measurements.

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase server environment configuration");
  return { url: url.replace(/\/$/, ""), key };
}

async function latestRun() {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/scan_runs?select=*&order=started_at.desc&limit=1`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase scan status failed ${response.status}: ${text}`);
  const rows = text ? JSON.parse(text) : [];
  return Array.isArray(rows) ? rows[0] || null : null;
}

export default async () => {
  try {
    const run = await latestRun();
    if (!run) {
      return json({
        ok: true,
        hasRun: false,
        status: "empty",
        elapsedSeconds: 0,
        elapsedMinutes: 0,
        progressPercent: 0,
        remainingSymbols: 0,
        storagePath: "supabase-source-of-truth",
        blobUsed: false
      });
    }

    const startedMs = new Date(run.started_at).getTime();
    const endedMs = run.completed_at ? new Date(run.completed_at).getTime() : Date.now();
    const elapsedSeconds = Number.isFinite(startedMs) && Number.isFinite(endedMs)
      ? Math.max(0, Math.round((endedMs - startedMs) / 1000))
      : 0;
    const total = Number(run.universe_count || 0);
    const scanned = Number(run.scanned_count || 0);
    const pendingIndex = Number(run.pending_index || 0);
    const progressPercent = total > 0 ? Number(((scanned / total) * 100).toFixed(2)) : 0;

    return json({
      ok: true,
      hasRun: true,
      scanRunId: run.id,
      status: run.status,
      startedAt: run.started_at,
      updatedAt: run.updated_at,
      completedAt: run.completed_at,
      elapsedSeconds,
      elapsedMinutes: Number((elapsedSeconds / 60).toFixed(2)),
      universeCount: total,
      scannedCount: scanned,
      pendingIndex,
      remainingSymbols: Math.max(0, total - scanned),
      progressPercent,
      candidateCount: Number(run.candidate_count || 0),
      passCount: Number(run.pass_count || 0),
      error: run.error || null,
      complete: run.status === "completed" || (total > 0 && scanned >= total && pendingIndex >= total),
      storagePath: "supabase-source-of-truth",
      blobUsed: false
    });
  } catch (error) {
    return json({ ok: false, error: error.message || String(error), blobUsed: false }, 500);
  }
};
