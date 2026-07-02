"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, KpiCard } from "@/components/ui";
import type { AuditFinding, AuditCategory as Category, AuditSeverity as Severity } from "@/lib/audit-engine";

interface AuditRun {
  id: string;
  status: "running" | "complete" | "failed";
  score: number | null;
  engineVersion: number;
  summary: unknown;
  inputs: unknown;
  findings: AuditFinding[];
  startedAt: string;
  finishedAt: string | null;
}

interface AuditSummary {
  notAssessed?: string[];
  byCategory?: Partial<Record<Category, {
    score: number | null;
    assessed: number;
    counts: { pass: number; warn: number; critical: number; notAssessed: number };
  }>>;
}

const CATEGORY_LABEL: Record<Category, string> = {
  pixel_capi: "Pixel / CAPI",
  creative: "Creative",
  structure: "Structure",
  audience: "Audience",
};
const CATEGORY_ORDER: Category[] = ["pixel_capi", "creative", "structure", "audience"];
const SEVERITY_ORDER: Severity[] = ["critical", "warn", "info"];
const SEVERITY_STYLE: Record<Severity, string> = {
  critical: "text-red-700 dark:text-red-400",
  warn: "text-amber-700 dark:text-amber-400",
  info: "text-black/50 dark:text-white/50",
};

export function AuditPanel({ clientId }: { clientId: string }) {
  const [run, setRun] = useState<AuditRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [capiEnabled, setCapiEnabled] = useState("");
  const [leadEventFiring, setLeadEventFiring] = useState("");
  const [emqPurchase, setEmqPurchase] = useState("");

  const clientQuery = `clientId=${encodeURIComponent(clientId)}`;
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/account-audit/runs?${clientQuery}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Could not load audit runs");
      const latest = data.runs?.[0] ?? null;
      setRun(latest);
      setError(runFailureMessage(latest));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [clientQuery]);

  useEffect(() => { load(); }, [load]);

  async function runAudit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account-audit/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, inputs: questionnaireInputs(capiEnabled, leadEventFiring, emqPurchase) }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Audit failed");
      // The route returns 200 with status:"failed" on an engine error so the run is recorded;
      // surface that instead of rendering it as a clean, empty audit.
      setRun(data.run);
      setError(runFailureMessage(data.run));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const summary = readSummary(run?.summary);
  const severityCounts = countSeverities(run?.findings ?? []);
  const notAssessed = summary.notAssessed ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <h2 className="mb-3 text-sm font-medium">Pixel / CAPI questionnaire</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-sm">
                <span className="mb-1 block text-xs text-black/50 dark:text-white/50">CAPI on</span>
                <select value={capiEnabled} onChange={(e) => setCapiEnabled(e.target.value)}
                  className="w-full rounded-md border border-black/10 bg-transparent px-2 py-1.5 dark:border-white/10">
                  <option value="">Unknown</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-black/50 dark:text-white/50">Purchase EMQ</span>
                <input value={emqPurchase} onChange={(e) => setEmqPurchase(e.target.value)}
                  inputMode="decimal" placeholder="0-10"
                  className="w-full rounded-md border border-black/10 bg-transparent px-2 py-1.5 dark:border-white/10" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-black/50 dark:text-white/50">Lead event firing</span>
                <select value={leadEventFiring} onChange={(e) => setLeadEventFiring(e.target.value)}
                  className="w-full rounded-md border border-black/10 bg-transparent px-2 py-1.5 dark:border-white/10">
                  <option value="">Unknown</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </label>
            </div>
          </div>
          <button onClick={runAudit} disabled={busy}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? "Running..." : "Run audit"}
          </button>
        </div>
      </Card>

      {error && <div className="rounded-md bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950/30">{error}</div>}

      <div className="grid gap-3 md:grid-cols-4">
        <KpiCard label="Score" value={run?.score === null || !run ? "—" : `${run.score}/100`} hint={run ? `v${run.engineVersion} · ${run.status}` : "No run yet"} />
        <KpiCard label="Critical" value={String(severityCounts.critical)} />
        <KpiCard label="Warnings" value={String(severityCounts.warn)} />
        <KpiCard label="Not assessed" value={String(notAssessed.length)} />
      </div>

      {notAssessed.length > 0 && (
        <div className="rounded-md border border-black/10 px-3 py-2 text-sm dark:border-white/10">
          <span className="font-medium">Not assessed:</span>{" "}
          <span className="text-black/60 dark:text-white/60">{notAssessed.join(", ")}</span>
        </div>
      )}

      <Card>
        <h2 className="mb-3 text-sm font-medium">Category scores</h2>
        <div className="grid gap-2 md:grid-cols-4">
          {CATEGORY_ORDER.map((category) => {
            const row = summary.byCategory?.[category];
            return (
              <div key={category} className="rounded-md border border-black/10 p-3 text-sm dark:border-white/10">
                <div className="font-medium">{CATEGORY_LABEL[category]}</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">{row?.score === null || row?.score === undefined ? "—" : row.score}</div>
                <div className="text-xs text-black/50 dark:text-white/50">
                  {row?.assessed ?? 0} assessed · {row?.counts.notAssessed ?? 0} skipped
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-medium">Findings</h2>
        {!run ? (
          <p className="text-sm text-black/60 dark:text-white/60">No audit run yet.</p>
        ) : run.findings.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">No findings on the latest run.</p>
        ) : (
          <div className="space-y-5">
            {CATEGORY_ORDER.map((category) => {
              const categoryFindings = run.findings.filter((finding) => finding.category === category);
              if (categoryFindings.length === 0) return null;
              return (
                <section key={category}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
                    {CATEGORY_LABEL[category]}
                  </h3>
                  <ul className="divide-y divide-black/5 dark:divide-white/5">
                    {sortFindings(categoryFindings).map((finding) => (
                      <li key={finding.code} className="py-3 text-sm">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <div className="font-medium">
                              <span className={SEVERITY_STYLE[finding.severity]}>{finding.severity}</span>
                              {" · "}{finding.title}
                            </div>
                            <div className="mt-1 text-black/60 dark:text-white/60">{finding.detail}</div>
                          </div>
                          {finding.autoFixable && (
                            <button disabled className="rounded-md border border-black/10 px-2 py-1 text-xs opacity-50 dark:border-white/10">
                              Fix (M-A2)
                            </button>
                          )}
                        </div>
                        <div className="mt-2 text-black/70 dark:text-white/70">{finding.recommendation}</div>
                        {finding.evidence !== undefined && (
                          <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-black/[0.03] p-2 text-xs dark:bg-white/[0.05]">
                            {JSON.stringify(finding.evidence, null, 2)}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function questionnaireInputs(capiEnabled: string, leadEventFiring: string, emqPurchase: string) {
  const inputs: { capiEnabled?: boolean; leadEventFiring?: boolean; emqPurchase?: number } = {};
  if (capiEnabled) inputs.capiEnabled = capiEnabled === "true";
  if (leadEventFiring) inputs.leadEventFiring = leadEventFiring === "true";
  const emq = Number(emqPurchase);
  // EMQ is 0-10; drop an out-of-range value (treat as "unknown") rather than let it 400 the
  // whole audit — one mistyped optional field shouldn't block the read-only run.
  if (emqPurchase.trim() !== "" && Number.isFinite(emq) && emq >= 0 && emq <= 10) inputs.emqPurchase = emq;
  return inputs;
}

function runFailureMessage(run: AuditRun | null): string | null {
  if (!run || run.status !== "failed") return null;
  const summary = run.summary;
  const detail = summary && typeof summary === "object" && "error" in summary
    ? String((summary as { error: unknown }).error)
    : null;
  return detail ? `Audit failed: ${detail}` : "Audit failed.";
}

function readSummary(summary: unknown): AuditSummary {
  return summary && typeof summary === "object" ? summary as AuditSummary : {};
}

function countSeverities(findings: AuditFinding[]) {
  return findings.reduce<Record<Severity, number>>((counts, finding) => {
    counts[finding.severity] += 1;
    return counts;
  }, { critical: 0, warn: 0, info: 0 });
}

function sortFindings(findings: AuditFinding[]) {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}
