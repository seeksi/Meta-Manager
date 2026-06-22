"use client";
// Editable autonomy control: write-mode, kill-switch release, caps, freshness, optimizer
// targets. PATCHes /api/automation/control. docs/ARCHITECTURE.md §5.
import { useEffect, useState } from "react";

interface Control {
  writeMode: string; emergencyStop: boolean;
  maxAccountDailySpendCents: number; maxActionBudgetDeltaCents: number;
  maxActionBudgetDeltaPct: string | number; minMetricFreshnessMinutes: number;
  targetCpaCents: number; targetRoas: string | number; activePolicyVersion: number;
}

const dollars = (cents: number) => (cents / 100).toString();

export function ControlEditor() {
  const [c, setC] = useState<Control | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/automation/control").then((r) => r.json())
      .then((d) => { if (d.error) throw new Error(d.error); setC(d.control); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <p className="text-sm text-amber-700 dark:text-amber-400">Database not connected ({error}).</p>;
  if (!c) return <p className="text-sm text-black/50 dark:text-white/50">Loading control…</p>;

  async function save(patch: Record<string, unknown>) {
    setSaved(false);
    const res = await fetch("/api/automation/control", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
    });
    const d = await res.json();
    if (d.control) { setC(d.control); setSaved(true); }
  }

  return (
    <div className="space-y-3 text-sm">
      <Field label="Write mode">
        <select value={c.writeMode} onChange={(e) => save({ writeMode: e.target.value })}
          className="rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1">
          {["off", "observe", "tier_a", "all"].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>

      <Field label="Kill switch">
        {c.emergencyStop ? (
          <button onClick={() => save({ emergencyStop: false })}
            className="rounded-md bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700">
            Release (engaged)
          </button>
        ) : (
          <button onClick={() => save({ emergencyStop: true, writeMode: "off" })}
            className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700">
            Engage (released)
          </button>
        )}
      </Field>

      <NumberField label="Max account daily spend ($)" value={dollars(c.maxAccountDailySpendCents)}
        onSave={(v) => save({ maxAccountDailySpendCents: Math.round(parseFloat(v) * 100) })} />
      <NumberField label="Max per-action budget delta ($)" value={dollars(c.maxActionBudgetDeltaCents)}
        onSave={(v) => save({ maxActionBudgetDeltaCents: Math.round(parseFloat(v) * 100) })} />
      <NumberField label="Max per-action delta (%)" value={String(c.maxActionBudgetDeltaPct)}
        onSave={(v) => save({ maxActionBudgetDeltaPct: parseFloat(v) })} />
      <NumberField label="Min metric freshness (min)" value={String(c.minMetricFreshnessMinutes)}
        onSave={(v) => save({ minMetricFreshnessMinutes: parseInt(v, 10) })} />
      <NumberField label="Target CPA ($)" value={dollars(c.targetCpaCents)}
        onSave={(v) => save({ targetCpaCents: Math.round(parseFloat(v) * 100) })} />
      <NumberField label="Target ROAS (x)" value={String(c.targetRoas)}
        onSave={(v) => save({ targetRoas: parseFloat(v) })} />

      <div className="text-xs text-black/40 dark:text-white/40">
        Policy v{c.activePolicyVersion}. {saved && <span className="text-green-700 dark:text-green-400">Saved.</span>}
        {" "}Native Meta account spend cap remains the external backstop.
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-black/60 dark:text-white/60">{label}</span>
      {children}
    </div>
  );
}

function NumberField({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <Field label={label}>
      <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)}
        className="w-28 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-right tabular-nums outline-none focus:border-blue-500" />
    </Field>
  );
}
