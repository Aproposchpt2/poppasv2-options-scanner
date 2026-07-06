// POPPA'S scheduled EOD refresh wrapper — 3:30 PM Pacific during PDT.
// Netlify cron runs in UTC: 22:30 UTC = 3:30 PM PDT.

import { runScheduledCleanupAndPullTask } from "../shared/scheduled-scan-cycle.js";

export default async () => runScheduledCleanupAndPullTask({
  cycle: "1530-pt-eod-cleanup-and-schwab-pull",
  targetHour: 15,
  targetMinute: 30,
  guardMinutes: 8
});

export const config = {
  schedule: "30 22 * * *"
};
