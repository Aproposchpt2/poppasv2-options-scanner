// POPPA'S EOD Schwab pull task helper.
// Manual/scheduler target: deletes morning records, then triggers the EOD scan-build-db pull.

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

function baseUrl(req) {
  const u = new URL(req.url);
  return process.env.URL || process.env.DEPLOY_URL || `${u.protocol}//${u.host}`;
}

export default async (req) => {
  const base = baseUrl(req);
  const res = await fetch(`${base}/.netlify/functions/scan-clean-start-db?source=eod-pull`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  return json({ ok: res.ok && body.ok, task: "eod-pull", result: body }, res.ok ? 200 : 500);
};
