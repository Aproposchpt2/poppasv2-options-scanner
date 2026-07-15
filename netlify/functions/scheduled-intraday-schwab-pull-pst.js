// POPPA'S scheduled intraday Schwab pull — hourly at :30 during market hours, PST.
// Netlify cron runs in UTC: 14:30–20:30 UTC = 6:30 AM–12:30 PM PST, weekdays.
// The Pacific-range guard makes this a no-op during PDT (its twin covers PDT hours).

import { runScheduledIntradayPullTask } from "../shared/scheduled-scan-cycle.js";

export default async () => runScheduledIntradayPullTask({
  cycle: "intraday-hourly-schwab-pull",
  startHour: 6,
  startMinute: 25,
  endHour: 12,
  endMinute: 35
});

export const config = {
  schedule: "30 14-20 * * 1-5"
};
