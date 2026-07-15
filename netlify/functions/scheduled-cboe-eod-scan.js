// POPPA'S Scheduled CBOE EOD Option Chain Scan
// Fires automatically Monday-Friday one hour after the regular U.S. market close.
// Netlify scheduled functions use UTC cron.
// 22:00 UTC = 2:00 PM Pacific Standard Time.
// Note: during Pacific Daylight Time, a fixed 22:00 UTC schedule fires at 3:00 PM PDT.

export const config = {
  schedule: "0 22 * * 1-5"
};

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_URL;
  if (!base) {
    return json({ ok: false, error: "Missing Netlify base URL. Set URL or DEPLOY_URL environment variable." }, 500);
  }

  const scanUrl = `${base}/.netlify/functions/scan-build-background`;
  try {
    const res = await fetch(scanUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "POPPAS-Scheduled-EOD-Scan/1.0"
      },
      body: JSON.stringify({
        trigger: "scheduled-cboe-eod-scan",
        source: "Netlify Scheduled Function",
        scheduleUtc: "0 22 * * 1-5",
        localIntent: "2:00 PM Pacific Standard Time / one hour after regular market close",
        framework: "v3 raw monthly-chain first"
      })
    });

    let payload = null;
    try { payload = await res.json(); } catch (_) { payload = { text: await res.text().catch(() => "") }; }

    return json({
      ok: res.ok,
      fired: true,
      scheduleUtc: "0 22 * * 1-5",
      localIntent: "2:00 PM Pacific Standard Time / one hour after regular market close",
      scanEndpoint: scanUrl,
      status: res.status,
      result: payload
    }, res.ok ? 200 : 502);
  } catch (e) {
    return json({
      ok: false,
      fired: false,
      error: String(e && e.message ? e.message : e)
    }, 500);
  }
};
