// POPPA'S scheduled Schwab pull wrapper — 3:00 PM Pacific during PDT.
// Netlify cron runs in UTC: 22:00 UTC = 3:00 PM PDT.

import { runScheduledPullTask } from "../shared/scheduled-scan-cycle.js";

export default async () => runScheduledPullTask({
  cycle: "1500-pt-schwab-pull",
  targetHour: 15,
  targetMinute: 0,
  guardMinutes: 8
});

export const config = {
  schedule: "0 22 * * *"
};
