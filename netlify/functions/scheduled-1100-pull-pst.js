// POPPA'S scheduled Schwab pull wrapper — 11:00 AM Pacific during PST.
// Netlify cron runs in UTC: 19:00 UTC = 11:00 AM PST.

import { runScheduledPullTask } from "../shared/scheduled-scan-cycle.js";

export default async () => runScheduledPullTask({
  cycle: "1100-pt-schwab-pull",
  targetHour: 11,
  targetMinute: 0,
  guardMinutes: 8
});

export const config = {
  schedule: "0 19 * * *"
};
