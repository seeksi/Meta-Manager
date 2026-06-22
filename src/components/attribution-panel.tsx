"use client";
// v2 — CPL by campaign (7-day window). docs/ARCHITECTURE.md §6.
import { useEffect, useState } from "react";

interface Row { campaignId: string; spendCents: number; leads: number; cplCents: number | null }

export function AttributionPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/leads/attribution")
      .then((r) => r.json())
      .then((d) => { if (d.error) throw new Error(d.error); setRows(d.rows ?? []); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoaded(true));
  }, []);

  const usd = (c: number) => `$${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  if (!loaded) return <p className="text-sm text-black/50 dark:text-white/50">Loading attribution…</p>;
  if (error) return <p className="text-sm text-amber-700 dark:text-amber-400">Database not connected ({error}).</p>;
  if (rows.length === 0) return <p className="text-sm text-black/60 dark:text-white/60">No attributed spend/leads in the last 7 days.</p>;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-black/50 dark:text-white/50">
          <th className="py-1 font-medium">Campaign</th>
          <th className="py-1 text-right font-medium">Spend</th>
          <th className="py-1 text-right font-medium">Leads</th>
          <th className="py-1 text-right font-medium">CPL</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.campaignId} className="border-t border-black/5 dark:border-white/5">
            <td className="py-1.5">{r.campaignId}</td>
            <td className="py-1.5 text-right tabular-nums">{usd(r.spendCents)}</td>
            <td className="py-1.5 text-right tabular-nums">{r.leads}</td>
            <td className="py-1.5 text-right tabular-nums">{r.cplCents != null ? usd(r.cplCents) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
