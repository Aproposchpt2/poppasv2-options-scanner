// POPPA'S scheduled Schwab pull wrapper — 7:00 AM Pacific during PST.
// Netlify cron runs in UTC: 15:00 UTC = 7:00 AM PST.

import { runScheduledPullTask } from "../shared/scheduled-scan-cycle.js";

export default async () => runScheduledPullTask({
  cycle: "0700-pt-schwab-pull",
  targetHour: 7,
  targetMinute: 0,
  guardMinutes: 8
});

export const config = {
  schedule: "0 15 * * *"
};
