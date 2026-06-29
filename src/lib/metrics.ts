// Module 2 — Metric ingestion + dashboard read. docs/ARCHITECTURE.md §4, PRODUCT_SPEC.md §2.
// Upserts insights into meta_insights_daily, refreshes metric_rollups_daily, records a
// fetch for freshness. Dashboard reads rollups/insights — never calls Meta on page load.
import { eq, desc, sql, gte, and } from "drizzle-orm";
import { getDb } from "@/db";
import { metaInsightsDaily, metricRollupsDaily, metricFetches, leads } from "@/db/schema";
import { getClient } from "@/lib/clients";
import type { InsightRow } from "@/lib/meta/client";

export async function ingestInsights(clientId: string, accountId: string, rows: InsightRow[]) {
  const db = getDb();
  for (const r of rows) {
    await db.insert(metaInsightsDaily).values({
      metaAccountId: accountId,
      entityType: r.entityType,
      entityId: r.entityId,
      dateStart: r.dateStart,
      dateStop: r.dateStop,
      impressions: r.impressions,
      reach: r.reach,
      spendCents: r.spendCents,
      clicks: r.clicks,
      purchases: r.purchases,
      revenueCents: r.revenueCents,
    }).onConflictDoUpdate({
      target: [
        metaInsightsDaily.metaAccountId, metaInsightsDaily.entityType, metaInsightsDaily.entityId,
        metaInsightsDaily.dateStart, metaInsightsDaily.dateStop, metaInsightsDaily.breakdownHash,
      ],
      set: {
        impressions: r.impressions, reach: r.reach, spendCents: r.spendCents, clicks: r.clicks,
        purchases: r.purchases, revenueCents: r.revenueCents, fetchedAt: new Date(),
      },
    });

    const roas = r.spendCents > 0 ? r.revenueCents / r.spendCents : 0;
    const cpaCents = r.purchases > 0 ? Math.round(r.spendCents / r.purchases) : null;
    const ctr = r.impressions > 0 ? r.clicks / r.impressions : 0;
    await db.insert(metricRollupsDaily).values({
      clientId, day: r.dateStart, entityType: r.entityType, entityId: r.entityId,
      spendCents: r.spendCents, roas: String(roas), cpaCents, ctr: String(ctr),
    }).onConflictDoUpdate({
      target: [metricRollupsDaily.clientId, metricRollupsDaily.day, metricRollupsDaily.entityType, metricRollupsDaily.entityId],
      set: { spendCents: r.spendCents, roas: String(roas), cpaCents, ctr: String(ctr), updatedAt: new Date() },
    });
  }

  await db.insert(metricFetches).values({
    source: "meta:insights",
    request: { accountId },
    response: { count: rows.length },
  });
  return { ingested: rows.length };
}

// ── Time series (dashboard trends) ────────────────────────────────────────────
export interface TrendPoint { day: string; spendCents: number; roas: number }

/** Pure: aggregate campaign-level daily rows into account-level per-day points, sorted. */
export function rollupDaily(
  rows: { dateStart: string; entityType: string; spendCents: number; revenueCents: number }[],
): TrendPoint[] {
  const byDay = new Map<string, { spend: number; rev: number }>();
  for (const r of rows) {
    if (r.entityType !== "campaign") continue;
    const d = byDay.get(r.dateStart) ?? { spend: 0, rev: 0 };
    d.spend += r.spendCents; d.rev += r.revenueCents;
    byDay.set(r.dateStart, d);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, v]) => ({ day, spendCents: v.spend, roas: v.spend > 0 ? v.rev / v.spend : 0 }));
}

export async function getTimeseries(clientId: string, days = 14): Promise<TrendPoint[]> {
  const db = getDb();
  const client = await getClient(clientId);
  if (!client) return [];
  const start = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.select().from(metaInsightsDaily)
    .where(and(eq(metaInsightsDaily.metaAccountId, client.metaAccountId), gte(metaInsightsDaily.dateStart, start)));
  return rollupDaily(rows);
}

export interface DashboardSummary {
  hasData: boolean;
  fetchedAt: Date | null;
  day: string | null;
  kpis: Record<string, string> | null;
}

const usd = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

export async function getDashboardSummary(clientId: string): Promise<DashboardSummary> {
  const db = getDb();
  const client = await getClient(clientId);
  if (!client) return { hasData: false, fetchedAt: null, day: null, kpis: null };
  const accountId = client.metaAccountId;

  const [fresh] = await db.select({ fetchedAt: metricFetches.fetchedAt })
    .from(metricFetches).where(sql`${metricFetches.request}->>'accountId' = ${accountId}`)
    .orderBy(desc(metricFetches.fetchedAt)).limit(1);
  const [latest] = await db.select({ day: metricRollupsDaily.day })
    .from(metricRollupsDaily).where(eq(metricRollupsDaily.clientId, clientId))
    .orderBy(desc(metricRollupsDaily.day)).limit(1);

  if (!latest) return { hasData: false, fetchedAt: fresh?.fetchedAt ?? null, day: null, kpis: null };

  // Sum campaign-level rows for the latest day = account total (avoids double-counting levels).
  const rows = (await db.select().from(metaInsightsDaily)
    .where(and(eq(metaInsightsDaily.metaAccountId, accountId), eq(metaInsightsDaily.dateStart, latest.day))))
    .filter((r) => r.entityType === "campaign");

  const t = rows.reduce(
    (a, r) => ({
      spend: a.spend + r.spendCents, impr: a.impr + r.impressions,
      clicks: a.clicks + r.clicks, purch: a.purch + r.purchases, rev: a.rev + r.revenueCents,
    }),
    { spend: 0, impr: 0, clicks: 0, purch: 0, rev: 0 },
  );

  // Leads captured on the same day → CPL attribution KPI.
  const [{ count: leadCount } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` }).from(leads)
    .where(and(eq(leads.clientId, clientId), sql`date(${leads.capturedAt}) = ${latest.day}`));

  return {
    hasData: true,
    fetchedAt: fresh?.fetchedAt ?? null,
    day: latest.day,
    kpis: {
      Spend: usd(t.spend),
      ROAS: t.spend > 0 ? (t.rev / t.spend).toFixed(2) + "x" : "—",
      CPA: t.purch > 0 ? usd(t.spend / t.purch) : "—",
      CPL: leadCount > 0 ? usd(t.spend / leadCount) : "—",
      CPC: t.clicks > 0 ? usd(t.spend / t.clicks) : "—",
      CTR: t.impr > 0 ? pct(t.clicks / t.impr) : "—",
      CPM: t.impr > 0 ? usd((t.spend / t.impr) * 1000) : "—",
      Purchases: String(t.purch),
    },
  };
}
