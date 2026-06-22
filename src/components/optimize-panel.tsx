"use client";
// Module 8 — optimizer recommendations UI. docs/PRODUCT_SPEC.md §8.
import { useCallback, useEffect, useState } from "react";
import { QueueActions } from "./queue-actions";

interface Action {
  id: string; tier: string; status: string; actionType: string; entityId: string;
  evidence: { reason?: string; ruleId?: string } | null;
}

const STATUS_STYLE: Record<string, string> = {
  approved: "text-green-700 dark:text-green-400",
  executing: "text-green-700 dark:text-green-400",
  succeeded: "text-green-700 dark:text-green-400",
  pending_approval: "text-amber-700 dark:text-amber-400",
  blocked: "text-red-700 dark:text-red-400",
  rejected: "text-black/40 dark:text-white/40",
};

export function OptimizePanel() {
  const [items, setItems] = useState<Action[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ran, setRan] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch("/api/optimize/proposals").then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setItems(d.proposals ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run() {
    setBusy(true);
    try {
      const d = await fetch("/api/optimize/run", { method: "POST" }).then((r) => r.json());
      setRan(d.error ? d.error : `Created ${d.proposals ?? 0} proposal(s)${d.note ? ` — ${d.note}` : ""}.`);
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={run} disabled={busy}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {busy ? "Running…" : "Run optimizer"}
        </button>
        {ran && <span className="text-sm text-black/60 dark:text-white/60">{ran}</span>}
      </div>
      {error && <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm">Database not connected ({error}).</div>}

      {items.length === 0 ? (
        <p className="text-sm text-black/60 dark:text-white/60">No proposals yet. Run the optimizer once metrics are ingested.</p>
      ) : (
        <ul className="divide-y divide-black/5 dark:divide-white/5">
          {items.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-3 py-3 text-sm">
              <div>
                <div className="font-medium">
                  Tier {a.tier} · {a.actionType}{" "}
                  <span className={STATUS_STYLE[a.status] ?? ""}>· {a.status.replace("_", " ")}</span>
                </div>
                <div className="text-black/60 dark:text-white/60">
                  {a.entityId} — {a.evidence?.reason ?? a.evidence?.ruleId ?? "—"}
                </div>
              </div>
              {a.status === "pending_approval" && <QueueActions id={a.id} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
