// POPPA'S Option Scanner v3 — Schwab pull endpoint with explicit cleanup control.

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function baseUrl(req) {
  try {
    const u = new URL(req.url);
    return process.env.URL || process.env.DEPLOY_URL || `${u.protocol}//${u.host}`;
  } catch (_) {
    return process.env.URL || process.env.DEPLOY_URL || "";
  }
}

async function readJson(res) {
  return await res.json().catch(async () => ({ raw: await res.text().catch(() => "") }));
}

export default async (req) => {
  const base = baseUrl(req);
  const url = new URL(req.url);
  const source = url.searchParams.get("source") || "manual-start";
  const cleanRequested = url.searchParams.get("clean") === "1";
  if (!base) return json({ ok: false, source, error: "No base URL available." }, 500);

  const cleanUrl = `${base}/.netlify/functions/scan-clean-db?source=${encodeURIComponent(source)}`;
  const scanUrl = `${base}/.netlify/functions/scan-build-db?restart=1&source=${encodeURIComponent(source)}`;

  try {
    let cleanup = { skipped: true, explicitCleanRequired: true };

    if (cleanRequested) {
      const cleanRes = await fetch(cleanUrl, { method: "POST", headers: { accept: "application/json" } });
      const cleanBody = await readJson(cleanRes);
      cleanup = { skipped: false, status: cleanRes.status, result: cleanBody };
      if (!cleanRes.ok || !cleanBody?.ok) {
        return json({ ok: false, source, phase: "cleanup", cleanup }, 500);
      }
    }

    const scanRes = await fetch(scanUrl, { method: "POST", headers: { accept: "application/json" } });
    const scanBody = await readJson(scanRes);

    return json({
      ok: scanRes.ok && !!scanBody?.ok,
      source,
      action: cleanRequested ? "explicit_clean_start" : "preserved_record_start",
      cleanup,
      scanStatus: scanRes.status,
      scan: scanBody
    }, scanRes.ok ? 200 : 502);
  } catch (err) {
    return json({ ok: false, source, error: String(err?.message || err) }, 500);
  }
};