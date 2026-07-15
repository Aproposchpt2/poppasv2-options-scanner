// POPPA'S Option Scanner v3 — scanner record cleanup endpoint.
// Purpose: remove old scanner records before a fresh Schwab pull.
// Scope: data cleanup only. Does not request Schwab data and does not transform values.

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
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json") && text) return { data: JSON.parse(text), headers: res.headers };
  return { data: text, headers: res.headers };
}

async function sbCount(table) {
  const { headers } = await sbFetch(`${table}?select=id`, {
    method: "HEAD",
    headers: { Prefer: "count=exact" }
  });
  const cr = headers.get("content-range") || "";
  const m = cr.match(/\/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

async function deleteRows(table, filter) {
  const before = await sbCount(table).catch(() => null);
  await sbFetch(`${table}?${filter}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" }
  });
  const after = await sbCount(table).catch(() => null);
  return { table, before, after, deleted: Number.isFinite(before) && Number.isFinite(after) ? before - after : null };
}

export default async (req) => {
  const url = new URL(req.url);
  const source = url.searchParams.get("source") || "manual-clean";
  const startedAt = new Date().toISOString();

  try {
    const results = [];

    // Child/detail records first.
    results.push(await deleteRows("scan_candidates", "id=gte.0"));
    results.push(await deleteRows("scan_option_chain", "id=not.is.null"));

    // Parent scan run records last.
    results.push(await deleteRows("scan_runs", "id=not.is.null"));

    return json({
      ok: true,
      source,
      action: "scanner_records_cleaned",
      cleanupPolicy: "fresh pull replaces old scanner dataset",
      startedAt,
      completedAt: new Date().toISOString(),
      results
    });
  } catch (err) {
    return json({
      ok: false,
      source,
      action: "scanner_records_clean_failed",
      error: String(err?.message || err),
      startedAt,
      failedAt: new Date().toISOString()
    }, 500);
  }
};
