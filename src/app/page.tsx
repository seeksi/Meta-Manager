// Module 2 — Metrics dashboard. Reads DB rollups; never calls Meta live on load.
// Shows data freshness. docs/PRODUCT_SPEC.md §2.
import { PageHeader, KpiCard, Card } from "@/components/ui";
import { TrendChart } from "@/components/trend-chart";
import { getDashboardSummary, getTimeseries } from "@/lib/metrics";
import { BOOTSTRAP_CLIENT_ID } from "@/lib/clients";

export const dynamic = "force-dynamic";

const FALLBACK = ["Spend", "ROAS", "CPA", "CPL", "CPC", "CTR", "CPM", "Purchases"];
const usd = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default async function DashboardPage() {
  let summary: Awaited<ReturnType<typeof getDashboardSummary>> | null = null;
  let trend: Awaited<ReturnType<typeof getTimeseries>> = [];
  let dbError: string | null = null;
  try {
    // ponytail: default to the bootstrap client until a client switcher (post-M2 onboarding) lands.
    [summary, trend] = await Promise.all([
      getDashboardSummary(BOOTSTRAP_CLIENT_ID), getTimeseries(BOOTSTRAP_CLIENT_ID),
    ]);
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  const freshness = summary?.fetchedAt
    ? `synced ${new Date(summary.fetchedAt).toLocaleString()}`
    : "n/a";
  const kpis = summary?.kpis;

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Live account metrics" />

      {(!summary?.hasData || dbError) && (
        <Card className="mb-4 flex items-center justify-between bg-amber-50 dark:bg-amber-950/30 text-sm">
          <span>
            {dbError
              ? `Database not connected (${dbError}).`
              : "No data yet — connect a Meta ad account to begin ingestion."}
          </span>
          <span className="text-black/50 dark:text-white/50">Freshness: {freshness}</span>
        </Card>
      )}

      {summary?.hasData && (
        <div className="mb-4 text-sm text-black/50 dark:text-white/50">
          {summary.day} · {freshness}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(kpis ? Object.entries(kpis) : FALLBACK.map((k) => [k, "—"] as const)).map(([label, value]) => (
          <KpiCard key={label} label={label} value={value} />
        ))}
      </div>

      {trend.length >= 2 && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Card>
            <TrendChart title="Spend (14d)" values={trend.map((p) => p.spendCents)}
              labels={trend.map((p) => p.day)} format={usd} />
          </Card>
          <Card>
            <TrendChart title="ROAS (14d)" values={trend.map((p) => p.roas)}
              labels={trend.map((p) => p.day)} format={(n) => `${n.toFixed(2)}x`} />
          </Card>
        </div>
      )}
    </div>
  );
}
