// v2 — Creative fatigue detection. docs/ARCHITECTURE.md §6 (v2). Advisory only: rising
// frequency and/or declining CTR over a 7-day window signal a creative needs refreshing.
// Refreshing creative is a human action, so this never emits an auto-write.
import { desc, gte, eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { metaInsightsDaily } from "@/db/schema";
import { getClient } from "@/lib/clients";

export interface DailyPoint { date: string; impressions: number; reach: number; clicks: number }

export interface FatigueConfig {
  recentDays: number;   // window treated as "now"
  freqThreshold: number; // frequency at/above this = saturated audience
  ctrDropPct: number;    // CTR decline (recent vs prior) at/above this = wearing out
  minImpressions: number; // confidence gate on the recent window
}
export const DEFAULT_FATIGUE: FatigueConfig = {
  recentDays: 3, freqThreshold: 2.5, ctrDropPct: 0.2, minImpressions: 1000,
};

export interface FatigueSignal {
  fatigued: boolean;
  frequency: number;
  recentCtr: number;
  priorCtr: number;
  ctrDeltaPct: number; // negative = decline
  reasons: string[];
}

const sum = (arr: DailyPoint[], k: keyof DailyPoint) => arr.reduce((s, p) => s + (p[k] as number), 0);

/** Pure: score one entity's daily series. Returns null when there isn't enough data. */
export function scoreFatigue(points: DailyPoint[], cfg: FatigueConfig = DEFAULT_FATIGUE): FatigueSignal | null {
  if (points.length < cfg.recentDays + 1) return null; // need recent window + some prior
  const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : 1));
  const recent = sorted.slice(-cfg.recentDays);
  const prior = sorted.slice(0, -cfg.recentDays);

  const recImpr = sum(recent, "impressions");
  if (recImpr < cfg.minImpressions) return null; // not enough recent volume to judge

  const recReach = sum(recent, "reach");
  const frequency = recReach > 0 ? recImpr / recReach : 0;
  const recentCtr = recImpr > 0 ? sum(recent, "clicks") / recImpr : 0;
  const priImpr = sum(prior, "impressions");
  const priorCtr = priImpr > 0 ? sum(prior, "clicks") / priImpr : 0;
  const ctrDeltaPct = priorCtr > 0 ? (recentCtr - priorCtr) / priorCtr : 0;

  const reasons: string[] = [];
  if (frequency >= cfg.freqThreshold) reasons.push(`frequency ${frequency.toFixed(1)} ≥ ${cfg.freqThreshold}`);
  if (priorCtr > 0 && ctrDeltaPct <= -cfg.ctrDropPct) reasons.push(`CTR down ${Math.round(Math.abs(ctrDeltaPct) * 100)}%`);

  return { fatigued: reasons.length > 0, frequency, recentCtr, priorCtr, ctrDeltaPct, reasons };
}

export interface FatigueRow extends FatigueSignal { entityId: string }

/** All stored daily-insight rows for an account over the trailing 7-day window (latest stored day
 *  minus 6). Single-sources the window so detectFatigue and the audit engine stay in lockstep. */
export async function recentInsightRows(accountId: string) {
  const db = getDb();
  const [latest] = await db.select({ day: metaInsightsDaily.dateStart })
    .from(metaInsightsDaily).where(eq(metaInsightsDaily.metaAccountId, accountId))
    .orderBy(desc(metaInsightsDaily.dateStart)).limit(1);
  if (!latest) return [];
  const start = new Date(new Date(latest.day).getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
  return db.select().from(metaInsightsDaily)
    .where(and(eq(metaInsightsDaily.metaAccountId, accountId), gte(metaInsightsDaily.dateStart, start)));
}

export async function detectFatigue(clientId: string, cfg: FatigueConfig = DEFAULT_FATIGUE): Promise<FatigueRow[]> {
  const client = await getClient(clientId);
  if (!client) return [];
  const rows = await recentInsightRows(client.metaAccountId);

  const byEntity = new Map<string, DailyPoint[]>();
  for (const r of rows.filter((x) => x.entityType === "campaign")) {
    const arr = byEntity.get(r.entityId) ?? [];
    arr.push({ date: r.dateStart, impressions: r.impressions, reach: r.reach, clicks: r.clicks });
    byEntity.set(r.entityId, arr);
  }

  const out: FatigueRow[] = [];
  for (const [entityId, points] of byEntity) {
    const sig = scoreFatigue(points, cfg);
    if (sig?.fatigued) out.push({ entityId, ...sig });
  }
  return out.sort((a, b) => b.frequency - a.frequency);
}
