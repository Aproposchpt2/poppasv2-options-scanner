// POPPA'S scheduled cleanup wrapper — 6:55 AM Pacific during PST.
// Netlify cron runs in UTC: 14:55 UTC = 6:55 AM PST.
// Runs 5 minutes before the 7:00 AM pull so cleanup never races an active run.

import { runScheduledCleanupTask } from "../shared/scheduled-scan-cycle.js";

export default async () => runScheduledCleanupTask({
  cycle: "0655-pt-pre-market-cleanup",
  targetHour: 6,
  targetMinute: 55,
  guardMinutes: 4
});

export const config = {
  schedule: "55 14 * * *"
};
