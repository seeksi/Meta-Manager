// Local background scheduler — the desktop replacement for Inngest. Runs in-process while
// the app is open (single instance), so there is no durable cloud cron. docs/ARCHITECTURE.md §3.
// The native Meta account spend cap remains the external 24/7 backstop.
import { fetchInsights } from "@/lib/meta/client";
import { ingestInsights } from "@/lib/metrics";
import { runOptimization } from "@/lib/optimizer";
import { recoverOrphanedWrites } from "@/lib/automation";

const POLL_MS = 15 * 60_000; // insights poll cadence (matches the old */15 cron)
const OPTIMIZE_HOUR = 9;     // daily optimizer, local time (matches the old 0 9 * * *)

// Module-level status — shared with API routes since they run in the same server process.
export interface SchedulerStatus {
  started: boolean;
  busy: "poll" | "optimize" | null;
  lastPollAt: string | null;
  lastPollResult: unknown;
  lastOptimizeAt: string | null;
  nextOptimizeAt: string | null;
}
const status: SchedulerStatus = {
  started: false, busy: null,
  lastPollAt: null, lastPollResult: null, lastOptimizeAt: null, nextOptimizeAt: null,
};
export function getSchedulerStatus(): SchedulerStatus {
  return { ...status };
}

/** Poll campaign insights for today and ingest. Raw — see runPoll for the status-tracked wrapper. */
async function pollInsightsOnce() {
  const accountId = process.env.META_AD_ACCOUNT_ID;
  if (!accountId) return { skipped: "no META_AD_ACCOUNT_ID" };
  const rows = await fetchInsights({ level: "campaign", accountId, since: "today", until: "today" });
  return { fetched: rows.length, ...(await ingestInsights(accountId, rows)) };
}

/** Status-tracked insights poll. Exported for the "Poll now" button. Throws on error. */
export async function runPoll() {
  status.busy = "poll";
  try {
    const result = await pollInsightsOnce();
    status.lastPollAt = new Date().toISOString();
    status.lastPollResult = result;
    return result;
  } finally {
    status.busy = null;
  }
}

/** Status-tracked optimizer run. Exported for the "Run optimizer now" button. Throws on error. */
export async function runOptimize() {
  status.busy = "optimize";
  try {
    const result = await runOptimization();
    status.lastOptimizeAt = new Date().toISOString();
    return result;
  } finally {
    status.busy = null;
  }
}

async function safe(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error(`[scheduler] ${label} failed:`, e instanceof Error ? e.message : e);
  }
}

function msUntilHour(hour: number) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** Idempotent: starts insights polling + the daily optimizer. Called once from instrumentation. */
export function startScheduler() {
  if (status.started) return;
  status.started = true;
  console.log(`[scheduler] started — insights every ${POLL_MS / 60_000}m, optimizer daily at ${OPTIMIZE_HOUR}:00`);

  void safe("recover-orphans", recoverOrphanedWrites); // resolve writes left in-flight by a crash
  void safe("poll-insights", runPoll); // fresh data on launch
  setInterval(() => void safe("poll-insights", runPoll), POLL_MS);

  const armOptimize = () => {
    const ms = msUntilHour(OPTIMIZE_HOUR);
    status.nextOptimizeAt = new Date(Date.now() + ms).toISOString();
    setTimeout(() => {
      void safe("optimize", runOptimize);
      armOptimize(); // re-arm for the next day
    }, ms);
  };
  armOptimize();
}
