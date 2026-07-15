// POPPA'S scheduled cleanup wrapper — 7:55 AM Pacific during PST.
// Netlify cron runs in UTC: 15:55 UTC = 7:55 AM PST.

import { runScheduledCleanupTask } from "../shared/scheduled-scan-cycle.js";

export default async () => runScheduledCleanupTask({
  cycle: "0755-pt-pre-market-cleanup",
  targetHour: 7,
  targetMinute: 55,
  guardMinutes: 4
});

export const config = {
  schedule: "55 15 * * *"
};
