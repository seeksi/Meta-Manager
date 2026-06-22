"use client";
// Module 3 — Budget editor. Previews the guardrail decision, then applies via the
// proposeAction pipeline. Absolute target (daily_budget), never a delta. docs/PRODUCT_SPEC.md §3.
import { useState } from "react";

interface PreviewResult {
  result: { decision: "allow" | "require_approval" | "block"; code: string; message: string };
  tier: "A" | "B";
}

const DECISION_STYLE: Record<string, string> = {
  allow: "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300",
  require_approval: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  block: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
};

export function BudgetEditor() {
  const [campaignId, setCampaignId] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function buildInput() {
    const currentCents = Math.round(parseFloat(current || "0") * 100);
    const nextCents = Math.round(parseFloat(next || "0") * 100);
    const deltaCents = nextCents - currentCents;
    const deltaPct = currentCents > 0 ? (deltaCents / currentCents) * 100 : 100;
    return {
      actionType: nextCents < currentCents ? "decrease_budget" : "set_budget",
      entityType: "campaign",
      entityId: campaignId,
      targetState: { daily_budget: nextCents },
      dailyBudgetDeltaCents: deltaCents,
      dailyBudgetDeltaPct: deltaPct,
      projectedDailySpendCents: nextCents,
      actor: "operator",
    };
  }

  async function call(path: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildInput()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "request failed");
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function doPreview() {
    setOutcome(null);
    const data = await call("/api/actions/preview");
    if (data) setPreview(data as PreviewResult);
  }

  async function doApply() {
    const data = await call("/api/actions");
    if (data?.action) {
      setOutcome(data.action.status);
      setPreview(null);
    }
  }

  const canApply = !!campaignId && !!next && preview?.result.decision !== "block";

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Campaign ID" value={campaignId} onChange={setCampaignId} placeholder="120xxxxxxxxxxxxxx" />
        <Field label="Current daily ($)" value={current} onChange={setCurrent} placeholder="50.00" type="number" />
        <Field label="New daily ($)" value={next} onChange={setNext} placeholder="75.00" type="number" />
      </div>

      <div className="flex items-center gap-2">
        <button onClick={doPreview} disabled={busy || !next}
          className="rounded-md border border-black/15 dark:border-white/15 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50">
          Preview
        </button>
        <button onClick={doApply} disabled={busy || !canApply}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          Apply
        </button>
      </div>

      {preview && (
        <div className={`rounded-md px-3 py-2 text-sm ${DECISION_STYLE[preview.result.decision]}`}>
          <span className="font-semibold">Tier {preview.tier} · {preview.result.decision.replace("_", " ")}</span>
          {" — "}{preview.result.message}
          {preview.result.decision === "require_approval" && " (will queue for approval)"}
        </div>
      )}
      {outcome && (
        <div className="rounded-md bg-black/5 dark:bg-white/5 px-3 py-2 text-sm">
          Action created with status: <span className="font-semibold">{outcome}</span>
          {outcome === "pending_approval" && " — review it in Automation → Approval queue."}
        </div>
      )}
      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}

function Field(props: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-black/60 dark:text-white/60">{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 outline-none focus:border-blue-500"
      />
    </label>
  );
}
