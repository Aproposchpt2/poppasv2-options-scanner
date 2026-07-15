// POPPA'S premarket cleanup task helper.
// Manual/scheduler target: deletes prior scanner records before the morning Schwab pull.

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

function baseUrl(req) {
  const u = new URL(req.url);
  return process.env.URL || process.env.DEPLOY_URL || `${u.protocol}//${u.host}`;
}

export default async (req) => {
  const base = baseUrl(req);
  const res = await fetch(`${base}/.netlify/functions/scan-clean-db?source=premarket-clean`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  return json({ ok: res.ok && body.ok, task: "premarket-clean", result: body }, res.ok ? 200 : 500);
};
