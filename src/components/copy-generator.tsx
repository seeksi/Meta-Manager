"use client";
// Module 5 — inline AI copy generator. Generates variants, flags Meta char-limit
// violations, lets the operator copy a field. docs/PRODUCT_SPEC.md §5.
import { useState } from "react";

const LIMITS = { headline: 40, primaryText: 125, description: 30 } as const;

interface Variant {
  headline: string;
  primaryText: string;
  description: string;
  violations: string[];
}

export function CopyGenerator() {
  const [product, setProduct] = useState("");
  const [audience, setAudience] = useState("");
  const [voice, setVoice] = useState("");
  const [variants, setVariants] = useState<Variant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/copy/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ product, audience, brandVoice: voice, count: 3 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "request failed");
      setVariants(data.variants as Variant[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Product / offer" value={product} onChange={setProduct} placeholder="14-day free trial of …" />
        <Field label="Audience (optional)" value={audience} onChange={setAudience} placeholder="busy founders" />
        <Field label="Brand voice (optional)" value={voice} onChange={setVoice} placeholder="bold, plain-spoken" />
      </div>
      <button onClick={generate} disabled={busy || !product.trim()}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
        {busy ? "Generating…" : "Generate copy"}
      </button>
      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}

      <div className="grid gap-3 md:grid-cols-3">
        {variants.map((v, i) => (
          <div key={i} className="rounded-lg border border-black/10 dark:border-white/10 p-3 text-sm space-y-2">
            <CopyField label="Headline" value={v.headline} limit={LIMITS.headline} />
            <CopyField label="Primary text" value={v.primaryText} limit={LIMITS.primaryText} />
            <CopyField label="Description" value={v.description} limit={LIMITS.description} />
            {v.violations.length > 0 && (
              <div className="text-xs text-amber-700 dark:text-amber-400">⚠ over limit: {v.violations.join(", ")}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CopyField({ label, value, limit }: { label: string; value: string; limit: number }) {
  const over = value.length > limit;
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-black/50 dark:text-white/50">{label}</span>
        <button
          onClick={() => navigator.clipboard?.writeText(value)}
          className={`tabular-nums text-xs ${over ? "text-amber-600 dark:text-amber-400" : "text-black/40 dark:text-white/40"} hover:underline`}
          title="Copy to clipboard"
        >
          {value.length}/{limit} ⧉
        </button>
      </div>
      <p className="mt-0.5">{value}</p>
    </div>
  );
}

function Field(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-black/60 dark:text-white/60">{props.label}</span>
      <input
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 outline-none focus:border-blue-500"
      />
    </label>
  );
}
