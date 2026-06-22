// v2 — A/B experiments. docs/ARCHITECTURE.md §6. Compares two variants on conversion rate
// with a two-proportion z-test. Results pull aggregated metrics from meta_insights_daily.
import { eq, desc, and, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { experiments, metaInsightsDaily } from "@/db/schema";

// ── Statistics (pure, tested) ───────────────────────────────────────────────────
// Abramowitz & Stegun 7.1.26 error-function approximation.
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const normalCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

export interface ABResult {
  rateA: number; rateB: number;
  z: number; pValue: number;
  significant: boolean; // p < 0.05
  winner: "A" | "B" | null;
  nA: number; nB: number; xA: number; xB: number;
}

/** Two-proportion z-test. x = conversions, n = trials (clicks). */
export function twoProportionTest(xA: number, nA: number, xB: number, nB: number): ABResult | null {
  if (nA <= 0 || nB <= 0) return null;
  const rateA = xA / nA;
  const rateB = xB / nB;
  const pPool = (xA + xB) / (nA + nB);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / nA + 1 / nB));
  if (se === 0) return { rateA, rateB, z: 0, pValue: 1, significant: false, winner: null, nA, nB, xA, xB };
  const z = (rateB - rateA) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  const significant = pValue < 0.05;
  return { rateA, rateB, z, pValue, significant, winner: significant ? (rateB > rateA ? "B" : "A") : null, nA, nB, xA, xB };
}

// ── CRUD + results ──────────────────────────────────────────────────────────────
export interface ExperimentInput {
  name: string; hypothesis?: string; metric?: string;
  variantAId: string; variantBId: string; startedAt?: string;
}

export async function createExperiment(input: ExperimentInput) {
  const [row] = await getDb().insert(experiments).values({
    name: input.name, hypothesis: input.hypothesis ?? null, metric: input.metric ?? "cvr",
    variantAId: input.variantAId, variantBId: input.variantBId,
    startedAt: input.startedAt ?? new Date().toISOString().slice(0, 10),
  }).returning();
  return row;
}

export async function listExperiments() {
  return getDb().select().from(experiments).orderBy(desc(experiments.createdAt));
}

async function variantTotals(entityIds: string[], since: string | null) {
  const db = getDb();
  const where = since
    ? and(inArray(metaInsightsDaily.entityId, entityIds), gte(metaInsightsDaily.dateStart, since))
    : inArray(metaInsightsDaily.entityId, entityIds);
  const rows = await db.select().from(metaInsightsDaily).where(where);
  const totals = new Map<string, { clicks: number; purchases: number }>();
  for (const id of entityIds) totals.set(id, { clicks: 0, purchases: 0 });
  for (const r of rows) {
    const t = totals.get(r.entityId);
    if (t) { t.clicks += r.clicks; t.purchases += r.purchases; }
  }
  return totals;
}

export async function getExperimentResult(id: string) {
  const [exp] = await getDb().select().from(experiments).where(eq(experiments.id, id)).limit(1);
  if (!exp) return null;
  const totals = await variantTotals([exp.variantAId, exp.variantBId], exp.startedAt);
  const a = totals.get(exp.variantAId)!;
  const b = totals.get(exp.variantBId)!;
  // metric "cvr": conversions = purchases, trials = clicks.
  const result = twoProportionTest(a.purchases, a.clicks, b.purchases, b.clicks);
  return { experiment: exp, result };
}
