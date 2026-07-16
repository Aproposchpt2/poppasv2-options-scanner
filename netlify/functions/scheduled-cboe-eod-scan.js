// Retired 2026-07-15 — consolidated into the 7:00/11:00/3:00 PM Pacific pull schedule.
// (This function also called scan-build-background, not scan-build-db — a different,
// unaudited pipeline. Superseded either way.)
// See scheduled-1500-pull-pdt.js / scheduled-1500-pull-pst.js.
export default async () => new Response(null, { status: 204 });
