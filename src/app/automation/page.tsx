// Cross-cutting — Autonomy control: write-mode, caps, kill-switch, approval queue, audit.
// docs/PRODUCT_SPEC.md (Autonomy control). Reads live DB; degrades gracefully if unset.
import { PageHeader, Card } from "@/components/ui";
import { QueueActions } from "@/components/queue-actions";
import { ResolveActions } from "@/components/resolve-actions";
import { ControlEditor } from "@/components/control-editor";
import { SchedulerPanel } from "@/components/scheduler-panel";
import { listQueue, listUnresolved, listAudit } from "@/lib/automation";

export const dynamic = "force-dynamic";

export default async function AutomationPage() {
  let queue: Awaited<ReturnType<typeof listQueue>> = [];
  let unresolved: Awaited<ReturnType<typeof listUnresolved>> = [];
  let audit: Awaited<ReturnType<typeof listAudit>> = [];
  let dbError: string | null = null;
  try {
    [queue, unresolved, audit] = await Promise.all([listQueue(), listUnresolved(), listAudit()]);
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <PageHeader title="Automation" subtitle="Guardrails, approval queue, audit log" />

      {dbError && (
        <Card className="mb-4 bg-amber-50 dark:bg-amber-950/30 text-sm">
          Database not connected ({dbError}). Set DATABASE_URL and run migrations to activate.
        </Card>
      )}

      <Card className="mb-4">
        <h2 className="mb-3 font-medium">Scheduler</h2>
        <SchedulerPanel />
      </Card>

      {unresolved.length > 0 && (
        <Card className="mb-4 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30">
          <h2 className="mb-1 font-medium">Unresolved writes · {unresolved.length}</h2>
          <p className="mb-3 text-sm text-black/60 dark:text-white/60">
            These writes are in-flight or uncertain (e.g. a crash mid-write). Spend-increasing
            automation is paused until they clear. Check the entity in Meta, then mark each.
          </p>
          <ul className="space-y-3">
            {unresolved.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-3 border-b border-black/5 dark:border-white/5 pb-3 last:border-0">
                <div className="text-sm">
                  <div className="font-medium">{a.actionType} <span className="text-amber-700 dark:text-amber-400">({a.status})</span></div>
                  <div className="text-black/60 dark:text-white/60">
                    {a.entityType} {a.entityId} → {JSON.stringify(a.targetState)}
                  </div>
                </div>
                <ResolveActions id={a.id} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-medium">Control</h2>
          <ControlEditor />
        </Card>

        <Card>
          <h2 className="mb-3 font-medium">Approval queue (Tier B) · {queue.length}</h2>
          {queue.length === 0 ? (
            <p className="text-sm text-black/60 dark:text-white/60">
              Empty. Tier B proposals appear here with a diff + projected cost.
            </p>
          ) : (
            <ul className="space-y-3">
              {queue.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-3 border-b border-black/5 dark:border-white/5 pb-3 last:border-0">
                  <div className="text-sm">
                    <div className="font-medium">{a.actionType}</div>
                    <div className="text-black/60 dark:text-white/60">
                      {a.entityType} {a.entityId} → {JSON.stringify(a.targetState)}
                    </div>
                  </div>
                  <QueueActions id={a.id} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Audit log</h2>
          <a href="/api/audit/export"
            className="rounded-md border border-black/15 dark:border-white/15 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/5">
            Download CSV
          </a>
        </div>
        {audit.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">No events yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {audit.map((e) => (
              <li key={e.id} className="flex gap-3 text-black/70 dark:text-white/70">
                <span className="tabular-nums text-black/40 dark:text-white/40">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
                <span className="font-medium">{e.eventType}</span>
                <span className="text-black/50 dark:text-white/50">{e.actor}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
