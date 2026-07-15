import { runScheduledCleanupAndPullTask } from "../shared/scheduled-scan-cycle.js";

export default async () => {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  if (dateKey !== "2026-07-03") return new Response(null, { status: 204 });

  return runScheduledCleanupAndPullTask({
    cycle: "one-time-clean-supabase-kickoff",
    targetHour: 13,
    targetMinute: 20,
    guardMinutes: 5
  });
};

export const config = {
  schedule: "20 20 3 7 *"
};
