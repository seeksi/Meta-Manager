"use client";
// Modules 6+9 — lead funnel + lifecycle UI. docs/PRODUCT_SPEC.md §6, §9.
import { useCallback, useEffect, useState } from "react";

const STAGES = ["new", "contacted", "qualified", "converted", "lost"] as const;
type Stage = (typeof STAGES)[number];

interface Lead { id: string; source: string | null; stage: string; score: number | null; attributes: Record<string, unknown> | null }
interface Funnel { total: number; stages: { stage: string; count: number }[]; conversionRate: number }

export function LeadsManager() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [source, setSource] = useState("meta");
  const [campaignId, setCampaignId] = useState("");

  const load = useCallback(async () => {
    try {
      const [l, f] = await Promise.all([
        fetch("/api/leads").then((r) => r.json()),
        fetch("/api/leads/funnel").then((r) => r.json()),
      ]);
      if (l.error) throw new Error(l.error);
      setLeads(l.leads ?? []);
      setFunnel(f.error ? null : f);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function addLead() {
    await fetch("/api/leads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, campaignId: campaignId || undefined, attributes: { email } }),
    });
    setEmail("");
    setCampaignId("");
    load();
  }
  async function changeStage(id: string, stage: Stage) {
    await fetch(`/api/leads/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage }),
    });
    load();
  }
  async function nurture(id: string) {
    await fetch(`/api/leads/${id}/nurture`, { method: "POST" });
    load();
  }

  const max = Math.max(1, ...(funnel?.stages.map((s) => s.count) ?? [1]));

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm">
          Database not connected ({error}).
        </div>
      )}

      {funnel && (
        <div className="space-y-2">
          <div className="text-sm text-black/60 dark:text-white/60">
            {funnel.total} leads · {(funnel.conversionRate * 100).toFixed(1)}% converted
          </div>
          {funnel.stages.map((s) => (
            <div key={s.stage} className="flex items-center gap-3 text-sm">
              <span className="w-24 capitalize text-black/60 dark:text-white/60">{s.stage}</span>
              <div className="h-5 flex-1 rounded bg-black/5 dark:bg-white/5">
                <div className="h-5 rounded bg-blue-500/70" style={{ width: `${(s.count / max) * 100}%` }} />
              </div>
              <span className="w-8 text-right tabular-nums">{s.count}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="lead@example.com"
          className="rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="source"
          className="w-28 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
        <input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="campaign id"
          className="w-36 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
        <button onClick={addLead}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">Add lead</button>
      </div>

      <div className="divide-y divide-black/5 dark:divide-white/5">
        {leads.map((l) => (
          <div key={l.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <div>
              <span className="font-medium">{(l.attributes?.email as string) ?? "(no email)"}</span>
              <span className="ml-2 text-black/50 dark:text-white/50">{l.source} · score {l.score}</span>
            </div>
            <div className="flex items-center gap-2">
              <select value={l.stage} onChange={(e) => changeStage(l.id, e.target.value as Stage)}
                className="rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-xs">
                {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button onClick={() => nurture(l.id)}
                className="rounded-md border border-black/15 dark:border-white/15 px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/5">
                Nurture
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
