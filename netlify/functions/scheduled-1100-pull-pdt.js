// POPPA'S scheduled Schwab pull wrapper — 11:00 AM Pacific during PDT.
// Netlify cron runs in UTC: 18:00 UTC = 11:00 AM PDT.

import { runScheduledPullTask } from "../shared/scheduled-scan-cycle.js";

export default async () => runScheduledPullTask({
  cycle: "1100-pt-schwab-pull",
  targetHour: 11,
  targetMinute: 0,
  guardMinutes: 8
});

export const config = {
  schedule: "0 18 * * *"
};
