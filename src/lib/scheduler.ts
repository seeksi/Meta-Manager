// Local background scheduler — the desktop replacement for Inngest. Runs in-process while
// the app is open (single instance), so there is no durable cloud cron. docs/ARCHITECTURE.md §3.
// The native Meta account spend cap remains the external 24/7 backstop.
import { fetchInsights } from "@/lib/meta/client";
import { ingestInsights } from "@/lib/metrics";
import { runOptimization } from "@/lib/optimizer";
import { recoverOrphanedWrites } from "@/lib/automation";
import { listActiveClients, clientContext } from "@/lib/clients";

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

/** Poll campaign insights for today and ingest, PER active client. Raw — see runPoll for the
 *  status-tracked wrapper. One client's failure must not abort the others. */
async function pollInsightsOnce() {
  const clients = await listActiveClients();
  if (clients.length === 0) return { skipped: "no active clients" };
  const perClient: Record<string, unknown> = {};
  for (const c of clients) {
    try {
      const ctx = await clientContext(c.id);
      const rows = await fetchInsights(ctx, { level: "campaign", since: "today", until: "today" });
      perClient[c.id] = { fetched: rows.length, ...(await ingestInsights(c.id, c.metaAccountId, rows)) };
    } catch (e) {
      perClient[c.id] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { clients: clients.length, perClient };
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

/** Status-tracked optimizer run across ALL active clients. Exported for the "Run optimizer now"
 *  button. One client's failure must not abort the others. */
export async function runOptimize() {
  status.busy = "optimize";
  try {
    const clients = await listActiveClients();
    const perClient: Record<string, unknown> = {};
    for (const c of clients) {
      try {
        perClient[c.id] = await runOptimization(c.id);
      } catch (e) {
        perClient[c.id] = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    status.lastOptimizeAt = new Date().toISOString();
    return { clients: clients.length, perClient };
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
