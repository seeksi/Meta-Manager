"use client";
// v2 — creative fatigue signals (advisory). docs/ARCHITECTURE.md §6.
import { useEffect, useState } from "react";

interface Signal {
  entityId: string; frequency: number; recentCtr: number; ctrDeltaPct: number; reasons: string[];
}

export function FatiguePanel() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/insights/fatigue")
      .then((r) => r.json())
      .then((d) => { if (d.error) throw new Error(d.error); setSignals(d.signals ?? []); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return <p className="text-sm text-black/50 dark:text-white/50">Checking fatigue…</p>;
  if (error) return <p className="text-sm text-amber-700 dark:text-amber-400">Database not connected ({error}).</p>;
  if (signals.length === 0) return <p className="text-sm text-black/60 dark:text-white/60">No fatigue detected. Refresh creative when frequency climbs or CTR slides.</p>;

  return (
    <ul className="space-y-2 text-sm">
      {signals.map((s) => (
        <li key={s.entityId} className="flex items-center justify-between gap-3 border-b border-black/5 dark:border-white/5 pb-2 last:border-0">
          <div>
            <span className="font-medium">{s.entityId}</span>
            <span className="ml-2 text-black/60 dark:text-white/60">{s.reasons.join(" · ")}</span>
          </div>
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            refresh creative
          </span>
        </li>
      ))}
    </ul>
  );
}
