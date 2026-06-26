// POPPAS PRO — daily cron. Triggers the full S&P 500 background scan once a day so the
// stored board (read by scan-results.js) stays fresh on the latest delayed/end-of-day chains.
export const config = { schedule: "@daily" };

export default async function handler() {
  const base = process.env.URL || process.env.DEPLOY_URL || "";
  try { if (base) await fetch(`${base}/.netlify/functions/scan-build-background`, { method: "POST" }); } catch (_) {}
  return new Response("scan triggered", { status: 200 });
}
