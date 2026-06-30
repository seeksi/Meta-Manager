// Local background scheduler. Runs in-process in the hosted/desktop Node server; the run ledger
// makes daily optimize catch-up restart-safe for this single instance.
// The native Meta account spend cap remains the external 24/7 backstop.
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { schedulerRuns } from "@/db/schema";
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

type SchedulerJob = "optimize" | "poll" | (string & {});

export async function recordRunStart(job: SchedulerJob, clientId: string | null): Promise<string> {
  const [row] = await getDb()
    .insert(schedulerRuns)
    .values({ job, clientId, startedAt: new Date() })
    .returning({ id: schedulerRuns.id });
  return row.id;
}

export async function recordRunFinish(runId: string, ok: boolean, result: unknown): Promise<void> {
  await getDb()
    .update(schedulerRuns)
    .set({ finishedAt: new Date(), ok, result })
    .where(eq(schedulerRuns.id, runId));
}

export async function lastSuccessfulRunAt(job: SchedulerJob): Promise<Date | null> {
  const [row] = await getDb()
    .select({ startedAt: schedulerRuns.startedAt })
    .from(schedulerRuns)
    .where(and(eq(schedulerRuns.job, job), eq(schedulerRuns.ok, true)))
    .orderBy(desc(schedulerRuns.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

export function dueForOptimize(lastSuccessAt: Date | null, now: Date, optimizeHour: number): boolean {
  const target = new Date(now);
  target.setHours(optimizeHour, 0, 0, 0);
  if (now < target) return false;
  return lastSuccessAt === null || lastSuccessAt < target;
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
  // ponytail: poll run ledger needs a prune policy first; optimize is the only durable G2 job.
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
  const runId = await recordRunStart("optimize", null);
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
    const result = { clients: clients.length, perClient };
    status.lastOptimizeAt = new Date().toISOString();
    await recordRunFinish(runId, true, result);
    return result;
  } catch (e) {
    await recordRunFinish(runId, false, { error: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    status.busy = null;
  }
}

export async function maybeRunOptimize() {
  const last = await lastSuccessfulRunAt("optimize");
  if (!dueForOptimize(last, new Date(), OPTIMIZE_HOUR)) {
    console.log("[scheduler] optimize skipped — already ran for today's window");
    return { skipped: "not due", lastSuccessAt: last?.toISOString() ?? null };
  }
  return runOptimize();
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

export async function schedulerTick() {
  await safe("poll-insights", runPoll);
  await safe("recover-orphans", recoverOrphanedWrites);
}

/** Idempotent: starts insights polling + the daily optimizer. Called once from instrumentation. */
export function startScheduler() {
  if (status.started) return;
  status.started = true;
  console.log(`[scheduler] started — insights every ${POLL_MS / 60_000}m, optimizer daily at ${OPTIMIZE_HOUR}:00`);

  // ponytail: a real durable queue (QStash/Inngest) is only needed at Option-2/multi-instance scale.
  void lastSuccessfulRunAt("optimize").then((last) => {
    if (last) status.lastOptimizeAt = last.toISOString();
  }).catch((e) => console.error("[scheduler] hydrate optimize status failed:", e instanceof Error ? e.message : e));
  void safe("recover-orphans", recoverOrphanedWrites); // resolve writes left in-flight by a crash
  void safe("poll-insights", runPoll); // fresh data on launch
  void safe("optimize-catch-up", maybeRunOptimize); // re-fire if today's 09:00 was missed
  setInterval(() => void schedulerTick(), POLL_MS);

  const armOptimize = () => {
    const ms = msUntilHour(OPTIMIZE_HOUR);
    status.nextOptimizeAt = new Date(Date.now() + ms).toISOString();
    setTimeout(() => {
      void safe("optimize", maybeRunOptimize);
      armOptimize(); // re-arm for the next day
    }, ms);
  };
  armOptimize();
}
