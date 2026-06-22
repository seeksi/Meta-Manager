// Minimal UI primitives. ponytail: hand-rolled. Upgrade path: shadcn/ui.
import type { ReactNode } from "react";

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-black/60 dark:text-white/60">{subtitle}</p>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-black/10 dark:border-white/10 p-4 ${className}`}>
      {children}
    </div>
  );
}

export function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <div className="text-xs uppercase tracking-wide text-black/50 dark:text-white/50">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-black/50 dark:text-white/50">{hint}</div>}
    </Card>
  );
}

export function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <Card className="text-sm text-black/60 dark:text-white/60">{note}</Card>
    </div>
  );
}
