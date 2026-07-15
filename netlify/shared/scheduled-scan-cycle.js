// POPPA'S Option Scanner GTM — Netlify scheduled Supabase scan-cycle helper.
// Scheduled Schwab pulls use Supabase as source of truth. Netlify Blob is not used.

const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const FALLBACK_SITE_URL = "https://poppasv2.ai4academy.net";
const RETIRED_CYCLES = new Set([
  "morning-supabase-cleanup-and-pull",
  "afternoon-supabase-cleanup-and-pull",
  "one-time-clean-supabase-kickoff",
  "clean-pull-1327",
  "second-clean-supabase-kickoff",
  "one-time-recovery-clean-supabase-pull"
]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function logPayload(level, payload) {
  const line = JSON.stringify({ project: "POPPA'S Option Scanner GTM", component: "netlify-scheduled-supabase-scan-cycle", ...payload });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function retired(cycle) {
  if (!RETIRED_CYCLES.has(cycle)) return null;
  logPayload("info", { event: "retired-validation-cycle-skipped", cycle });
  return json({ ok: true, skipped: true, retired: true, cycle, storagePath: "supabase-source-of-truth", blobUsed: false });
}

function pacificParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(now);
  const out = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour), minute: Number(out.minute), second: Number(out.second),
    dateKey: `${out.year}-${out.month}-${out.day}`,
    label: `${out.year}-${out.month}-${out.day} ${out.hour}:${out.minute}:${out.second} PT`
  };
}

function withinPacificWindow({ targetHour, targetMinute, guardMinutes }, now = new Date()) {
  if (process.env.POPPA_SCHEDULE_FORCE === "true") {
    return { ok: true, forced: true, reason: "POPPA_SCHEDULE_FORCE=true", pacific: pacificParts(now) };
  }
  const pacific = pacificParts(now);
  const diff = pacific.hour * 60 + pacific.minute - (targetHour * 60 + targetMinute);
  return {
    ok: diff >= 0 && diff <= guardMinutes,
    forced: false,
    diffMinutes: diff,
    target: `${String(targetHour).padStart(2, "0")}:${String(targetMinute).padStart(2, "0")} PT`,
    pacific
  };
}

function siteBaseUrl() {
  return String(process.env.URL || process.env.DEPLOY_URL || FALLBACK_SITE_URL).replace(/\/+$/, "");
}

async function dispatchEndpoint(path, cycle, timeoutMs = 20000) {
  const url = new URL(`${siteBaseUrl()}${path}`);
  if (cycle) url.searchParams.set("cycle", cycle);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-POPPA-Scheduled-Cycle": cycle || "scheduled" },
      body: JSON.stringify({ source: "netlify-scheduled-function", cycle, requestedAt: new Date().toISOString(), storagePath: "supabase-source-of-truth" }),
      signal: controller.signal
    });
    const rawText = await response.text();
    let parsedBody = null;
    try { parsedBody = rawText ? JSON.parse(rawText) : null; }
    catch (_) { parsedBody = rawText ? rawText.slice(0, 1000) : null; }
    return { dispatched: response.ok, status: response.status, statusText: response.statusText, target: url.pathname, responseBody: parsedBody };
  } finally {
    clearTimeout(timeout);
  }
}

async function cleanupSupabaseScanCycle(cycle) {
  const result = await dispatchEndpoint("/.netlify/functions/scan-cleanup-db", cycle);
  logPayload(result.dispatched ? "info" : "warn", { event: "supabase-scan-cycle-cleanup-dispatched", cycle, ...result });
  return result;
}

async function dispatchSupabaseSchwabScan(cycle) {
  const result = await dispatchEndpoint("/.netlify/functions/scan-build-db-background?restart=1", cycle);
  logPayload(result.dispatched ? "info" : "warn", { event: "supabase-schwab-scan-dispatched", cycle, ...result });
  return result;
}

export async function runScheduledCleanupTask(config) {
  const cycle = config.cycle || "scheduled-cleanup";
  const retiredResponse = retired(cycle);
  if (retiredResponse) return retiredResponse;
  const guard = withinPacificWindow(config);
  if (!guard.ok) return json({ ok: true, skipped: true, cycle, guard, storagePath: "supabase-source-of-truth" });
  try {
    const cleanup = await cleanupSupabaseScanCycle(cycle);
    return json({ ok: cleanup.dispatched, cycle, guard, cleanup, storagePath: "supabase-source-of-truth", blobUsed: false }, cleanup.dispatched ? 200 : 502);
  } catch (error) {
    return json({ ok: false, cycle, error: error.message || String(error), blobUsed: false }, 500);
  }
}

export async function runScheduledPullTask(config) {
  const cycle = config.cycle || "scheduled-pull";
  const retiredResponse = retired(cycle);
  if (retiredResponse) return retiredResponse;
  const guard = withinPacificWindow(config);
  if (!guard.ok) return json({ ok: true, skipped: true, cycle, guard, storagePath: "supabase-source-of-truth" });
  try {
    const dispatch = await dispatchSupabaseSchwabScan(cycle);
    return json({ ok: dispatch.dispatched, cycle, guard, dispatch, storagePath: "supabase-source-of-truth", blobUsed: false }, dispatch.dispatched ? 200 : 502);
  } catch (error) {
    return json({ ok: false, cycle, error: error.message || String(error), blobUsed: false }, 500);
  }
}

export async function runScheduledCleanupAndPullTask(config) {
  const cycle = config.cycle || "scheduled-cleanup-and-pull";
  const retiredResponse = retired(cycle);
  if (retiredResponse) return retiredResponse;
  const guard = withinPacificWindow(config);
  if (!guard.ok) return json({ ok: true, skipped: true, cycle, guard, storagePath: "supabase-source-of-truth" });
  try {
    const cleanup = await cleanupSupabaseScanCycle(cycle);
    if (!cleanup.dispatched) return json({ ok: false, cycle, guard, cleanup, storagePath: "supabase-source-of-truth", blobUsed: false }, 502);
    const dispatch = await dispatchSupabaseSchwabScan(cycle);
    return json({ ok: dispatch.dispatched, cycle, guard, cleanup, dispatch, storagePath: "supabase-source-of-truth", blobUsed: false }, dispatch.dispatched ? 200 : 502);
  } catch (error) {
    return json({ ok: false, cycle, error: error.message || String(error), blobUsed: false }, 500);
  }
}
