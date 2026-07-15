// POPPA'S scheduled morning Schwab pull wrapper — 8:00 AM Pacific during PDT.
// Netlify cron runs in UTC: 15:00 UTC = 8:00 AM PDT.

import { runScheduledPullTask } from "../shared/scheduled-scan-cycle.js";

export default async () => runScheduledPullTask({
  cycle: "0800-pt-morning-schwab-pull",
  targetHour: 8,
  targetMinute: 0,
  guardMinutes: 8
});

export const config = {
  schedule: "0 15 * * *"
};
