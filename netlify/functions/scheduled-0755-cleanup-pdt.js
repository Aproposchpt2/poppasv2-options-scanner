// POPPA'S scheduled cleanup wrapper — 7:55 AM Pacific during PDT.
// Netlify cron runs in UTC: 14:55 UTC = 7:55 AM PDT.

import { runScheduledCleanupTask } from "../shared/scheduled-scan-cycle.js";

export default async () => runScheduledCleanupTask({
  cycle: "0755-pt-pre-market-cleanup",
  targetHour: 7,
  targetMinute: 55,
  guardMinutes: 4
});

export const config = {
  schedule: "55 14 * * *"
};
