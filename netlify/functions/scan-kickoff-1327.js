import { runScheduledCleanupAndPullTask } from "../shared/scheduled-scan-cycle.js";
export default async () => runScheduledCleanupAndPullTask({ cycle: "clean-pull-1327", targetHour: 13, targetMinute: 27, guardMinutes: 5 });
export const config = { schedule: "27 20 3 7 *" };
