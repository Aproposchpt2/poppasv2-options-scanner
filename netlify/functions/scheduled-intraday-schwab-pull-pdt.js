// POPPA'S scheduled intraday Schwab pull — hourly at :30 during market hours, PDT.
// Netlify cron runs in UTC: 13:30–19:30 UTC = 6:30 AM–12:30 PM PDT, weekdays.
// The Pacific-range guard makes this a no-op during PST (its twin covers PST hours).

import { runScheduledIntradayPullTask } from "../shared/scheduled-scan-cycle.js";

export default async () => runScheduledIntradayPullTask({
  cycle: "intraday-hourly-schwab-pull",
  startHour: 6,
  startMinute: 25,
  endHour: 12,
  endMinute: 35
});

export const config = {
  schedule: "30 13-19 * * 1-5"
};
