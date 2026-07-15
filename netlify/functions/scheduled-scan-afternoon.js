import { runScheduledCleanupAndPullTask } from "../shared/scheduled-scan-cycle.js";

export default async () => runScheduledCleanupAndPullTask({
  cycle: "afternoon-supabase-cleanup-and-pull",
  targetHour: 13,
  targetMinute: 5,
  guardMinutes: 10
});

export const config = {
  schedule: "5 20,21 * * 1-5"
};
