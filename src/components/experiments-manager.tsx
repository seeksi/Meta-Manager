"use client";
// v2 — A/B experiments UI. docs/ARCHITECTURE.md §6.
import { useCallback, useEffect, useState } from "react";

interface Experiment { id: string; name: string; variantAId: string; variantBId: string; status: string }
interface ABResult {
  rateA: number; rateB: number; pValue: number; significant: boolean;
  winner: "A" | "B" | null; nA: number; nB: number; xA: number; xB: number;
}

export function ExperimentsManager() {
  const [items, setItems] = useState<Experiment[]>([]);
  const [results, setResults] = useState<Record<string, ABResult | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", variantAId: "", variantBId: "" });

  const load = useCallback(async () => {
    try {
      const d = await fetch("/api/experiments").then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setItems(d.experiments ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    await fetch("/api/experiments", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
    });
    setForm({ name: "", variantAId: "", variantBId: "" });
    load();
  }
  async function check(id: string) {
    const d = await fetch(`/api/experiments/${id}`).then((r) => r.json());
    setResults((prev) => ({ ...prev, [id]: d.result ?? null }));
  }

  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

  return (
    <div className="space-y-5">
      {error && <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm">Database not connected ({error}).</div>}

      <div className="flex flex-wrap items-end gap-2">
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Experiment name"
          className="rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
        <input value={form.variantAId} onChange={(e) => setForm({ ...form, variantAId: e.target.value })} placeholder="Variant A id"
          className="rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
        <input value={form.variantBId} onChange={(e) => setForm({ ...form, variantBId: e.target.value })} placeholder="Variant B id"
          className="rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
        <button onClick={create} disabled={!form.name || !form.variantAId || !form.variantBId}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Create</button>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-black/60 dark:text-white/60">No experiments yet.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((e) => {
            const r = results[e.id];
            return (
              <li key={e.id} className="rounded-lg border border-black/10 dark:border-white/10 p-3 text-sm space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{e.name}</span>
                  <button onClick={() => check(e.id)} className="text-xs text-blue-600 hover:underline">Check significance</button>
                </div>
                <div className="text-black/60 dark:text-white/60">A: {e.variantAId} · B: {e.variantBId}</div>
                {r && (
                  <div className="rounded-md bg-black/5 dark:bg-white/5 px-3 py-2">
                    <div>A CVR {pct(r.rateA)} ({r.xA}/{r.nA}) · B CVR {pct(r.rateB)} ({r.xB}/{r.nB})</div>
                    <div className={r.significant ? "text-green-700 dark:text-green-400" : "text-black/60 dark:text-white/60"}>
                      p = {r.pValue.toFixed(3)} · {r.significant ? `significant — winner ${r.winner}` : "not yet significant"}
                    </div>
                  </div>
                )}
                {r === null && <div className="text-xs text-black/50 dark:text-white/50">No data for these variants yet.</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
