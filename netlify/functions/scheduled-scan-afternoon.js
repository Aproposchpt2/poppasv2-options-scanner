// Retired 2026-07-15 — consolidated into the 7:00/11:00/3:00 PM Pacific pull schedule.
// (Its cycle name "afternoon-supabase-cleanup-and-pull" was already in RETIRED_CYCLES
// and no-opping — this just removes the now-pointless cron trigger.)
// See scheduled-1100-pull-pdt.js / scheduled-1500-pull-pdt.js.
export default async () => new Response(null, { status: 204 });
