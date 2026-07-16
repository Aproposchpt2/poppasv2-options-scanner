// POPPA'S scheduled Directional Bias refresh wrapper — 6:30 AM Pacific during PDT.
// Netlify cron runs in UTC: 13:30 UTC = 6:30 AM PDT.
// Runs before the 6:55 AM cleanup and 7:00 AM pull so bias data is fresh before market open.

import { runScheduledBiasRefreshTask } from "../shared/scheduled-scan-cycle.js";

export default async () => runScheduledBiasRefreshTask({
  cycle: "0630-pt-bias-refresh",
  targetHour: 6,
  targetMinute: 30,
  guardMinutes: 8
});

export const config = {
  schedule: "30 13 * * *"
};
