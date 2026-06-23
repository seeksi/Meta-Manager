// Module 8 — Optimization engine. docs/PRODUCT_SPEC.md §8. Reads a 7-day metric window,
// emits proposed actions into the guardrail/approval pipeline. Rules informed by the Claude
// Council consult (see docs/ARCHITECTURE.md note). Stance: auto-pause obvious losers,
// auto-cut cautiously, NEVER auto-scale (growth is Tier B). The executor still does all writes.
import { desc, gte, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { metaInsightsDaily, adActions } from "@/db/schema";
import { proposeAction, ensureControl } from "./automation";
import { getDailyBudgetCents } from "@/lib/meta/client";

/** Recent optimizer-originated proposals for the recommendations UI. */
export async function listProposals(limit = 50) {
  return getDb().select().from(adActions)
    .where(eq(adActions.entityType, "campaign"))
    .orderBy(desc(adActions.createdAt)).limit(limit);
}

export const OPTIMIZER_VERSION = "0.1";

export interface OptimizerConfig {
  targetCpaCents: number;
  targetRoas: number;
  killCpaMultiple: number;   // pause if CPA >= target × this
  minSpendCents: number;     // confidence gate: don't judge below this spend
  minImpressions: number;    // confidence gate
  minClicks: number;         // confidence gate
  minConversions: number;    // need this many purchases to trust CPA/ROAS
  windowDays: number;        // primary lookback
  cooldownHours: number;     // anti-thrash window per entity
  maxProposalsPerRun: number; // blast-radius cap
  // Scaling (Tier B increase) — strict gates so we only scale clear winners.
  scaleMinConversions: number; // need this many purchases before scaling
  scaleRoasMultiple: number;   // ROAS >= target × this
  scaleCpaMultiple: number;    // AND CPA <= target × this
  increasePct: number;         // step up by this fraction
  maxBudgetCents: number;      // never auto-propose above this daily budget
}

export const DEFAULT_CONFIG: OptimizerConfig = {
  targetCpaCents: 5000,      // $50
  targetRoas: 2.0,
  killCpaMultiple: 3,
  minSpendCents: 5000,       // $50
  minImpressions: 1000,
  minClicks: 20,
  minConversions: 3,
  windowDays: 7,
  cooldownHours: 24,
  maxProposalsPerRun: 10,
  scaleMinConversions: 25,
  scaleRoasMultiple: 1.15,
  scaleCpaMultiple: 0.85,
  increasePct: 0.15,
  maxBudgetCents: 100_000,   // $1000/day
};

interface Agg {
  entityType: string; entityId: string;
  spendCents: number; purchases: number; revenueCents: number; impressions: number; clicks: number;
}

interface Proposal {
  agg: Agg;
  actionType: "pause_campaign" | "decrease_budget" | "increase_budget";
  ruleId: string;
  reason: string;
  passed: string[];
}

/** Pure rule pass over one entity's aggregated window metrics → at most one proposal. */
export function evaluateEntity(a: Agg, cfg: OptimizerConfig): Proposal | null {
  // Confidence gate — below this, treat as noise / learning and do nothing.
  if (a.spendCents < cfg.minSpendCents) return null;
  if (a.impressions < cfg.minImpressions && a.clicks < cfg.minClicks) return null;

  const cpaCents = a.purchases > 0 ? Math.round(a.spendCents / a.purchases) : Infinity;
  const roas = a.spendCents > 0 ? a.revenueCents / a.spendCents : 0;

  // Hard-loss: spend past kill threshold with zero conversions → pause.
  if (a.purchases === 0 && a.spendCents >= cfg.killCpaMultiple * cfg.targetCpaCents) {
    return { agg: a, actionType: "pause_campaign", ruleId: "no_conversion_kill",
      reason: `No conversions after $${(a.spendCents / 100).toFixed(2)} (≥ ${cfg.killCpaMultiple}× target CPA).`,
      passed: ["min_spend", "no_conversion", "kill_threshold"] };
  }
  // CPA blown out beyond kill multiple (with enough conversions to trust) → pause.
  if (a.purchases >= cfg.minConversions && cpaCents >= cfg.killCpaMultiple * cfg.targetCpaCents) {
    return { agg: a, actionType: "pause_campaign", ruleId: "cpa_kill",
      reason: `CPA $${(cpaCents / 100).toFixed(2)} ≥ ${cfg.killCpaMultiple}× target $${(cfg.targetCpaCents / 100).toFixed(2)}.`,
      passed: ["min_spend", "min_conversions", "cpa_kill"] };
  }
  // Bad-but-not-dead: converting but ROAS well below target → cautious budget decrease.
  if (a.purchases >= cfg.minConversions && roas <= 0.5 * cfg.targetRoas) {
    return { agg: a, actionType: "decrease_budget", ruleId: "low_roas_decrease",
      reason: `ROAS ${roas.toFixed(2)} ≤ 50% of target ${cfg.targetRoas}.`,
      passed: ["min_spend", "min_conversions", "low_roas"] };
  }
  // Clear winner: strong, high-confidence economics → propose a budget increase (Tier B).
  if (a.purchases >= cfg.scaleMinConversions
      && roas >= cfg.scaleRoasMultiple * cfg.targetRoas
      && cpaCents <= cfg.scaleCpaMultiple * cfg.targetCpaCents) {
    return { agg: a, actionType: "increase_budget", ruleId: "scale_winner",
      reason: `ROAS ${roas.toFixed(2)} ≥ ${cfg.scaleRoasMultiple}× target and CPA within ${cfg.scaleCpaMultiple}× target (${a.purchases} purchases).`,
      passed: ["min_spend", "scale_min_conversions", "high_roas", "low_cpa"] };
  }
  return null; // healthy-but-not-exceptional or insufficient confidence → leave alone (hysteresis)
}

function buildEvidence(p: Proposal, cfg: OptimizerConfig, windowStart: string, windowEnd: string) {
  const a = p.agg;
  const cpaCents = a.purchases > 0 ? Math.round(a.spendCents / a.purchases) : null;
  const roas = a.spendCents > 0 ? a.revenueCents / a.spendCents : 0;
  return {
    ruleId: p.ruleId,
    optimizerVersion: OPTIMIZER_VERSION,
    reason: p.reason,
    window: { primaryDays: cfg.windowDays, start: windowStart, end: windowEnd },
    targets: { targetCpaCents: cfg.targetCpaCents, targetRoas: cfg.targetRoas },
    metrics: {
      spendCents: a.spendCents, purchases: a.purchases, revenueCents: a.revenueCents,
      cpaCents, roas: Number(roas.toFixed(2)),
      impressions: a.impressions, clicks: a.clicks,
      ctr: a.impressions > 0 ? Number((a.clicks / a.impressions).toFixed(4)) : 0,
    },
    decision: { passed: p.passed, confidence: a.purchases >= cfg.minConversions ? "min_conversions" : "hard_spend_gate" },
    // TODO(meta-api-integrator): add ageHours, learningStatus, frequency, current budget for full diff.
  };
}

export async function runOptimization(override: Partial<OptimizerConfig> = {}) {
  const db = getDb();
  // Targets come from the editable automation_control row; rest from defaults.
  const control = await ensureControl();
  const cfg: OptimizerConfig = {
    ...DEFAULT_CONFIG,
    targetCpaCents: control.targetCpaCents,
    targetRoas: Number(control.targetRoas),
    ...override,
  };
  const [latest] = await db.select({ day: metaInsightsDaily.dateStart })
    .from(metaInsightsDaily).orderBy(desc(metaInsightsDaily.dateStart)).limit(1);
  if (!latest) return { ran: true, proposals: 0, note: "no metrics yet" };

  const start = new Date(new Date(latest.day).getTime() - (cfg.windowDays - 1) * 86_400_000)
    .toISOString().slice(0, 10);

  // Aggregate the window per campaign.
  const rows = (await db.select().from(metaInsightsDaily).where(gte(metaInsightsDaily.dateStart, start)))
    .filter((r) => r.entityType === "campaign");
  const byEntity = new Map<string, Agg>();
  for (const r of rows) {
    const cur = byEntity.get(r.entityId) ?? {
      entityType: "campaign", entityId: r.entityId,
      spendCents: 0, purchases: 0, revenueCents: 0, impressions: 0, clicks: 0,
    };
    cur.spendCents += r.spendCents; cur.purchases += r.purchases; cur.revenueCents += r.revenueCents;
    cur.impressions += r.impressions; cur.clicks += r.clicks;
    byEntity.set(r.entityId, cur);
  }

  // Anti-thrash cooldown.
  const since = new Date(Date.now() - cfg.cooldownHours * 3600_000);
  const acted = new Set(
    (await db.select({ entityId: adActions.entityId }).from(adActions).where(gte(adActions.createdAt, since)))
      .map((r) => r.entityId),
  );

  // Worst-first, capped per run (blast radius).
  const proposals = [...byEntity.values()]
    .map((a) => evaluateEntity(a, cfg))
    .filter((p): p is Proposal => p !== null && !acted.has(p.agg.entityId))
    .sort((x, y) => y.agg.spendCents - x.agg.spendCents)
    .slice(0, cfg.maxProposalsPerRun);

  // Account's most-recent-day actual spend = baseline for projecting post-change account spend,
  // which the account-daily-spend-cap guardrail checks. (Spend ≈ budget for a campaign that
  // spends to budget; +delta is a sound conservative projection.)
  const day = String(latest.day).slice(0, 10);
  const accountDailySpendCents = rows
    .filter((r) => String(r.dateStart).slice(0, 10) === day)
    .reduce((s, r) => s + r.spendCents, 0);

  const minViableBudgetCents = Math.max(20_00, 2 * cfg.targetCpaCents); // don't starve to nothing
  let created = 0;
  for (const p of proposals) {
    let targetState: Record<string, unknown>;
    let deltaCents = 0; // signed: +increase / -decrease; 0 for pause (status change)
    let deltaPct = 0;   // relative to current daily budget
    if (p.actionType === "pause_campaign") {
      targetState = { status: "PAUSED" };
    } else {
      // Budget change → absolute target from current budget. Needs Meta read.
      let current: number | null = null;
      try { current = await getDailyBudgetCents(p.agg.entityId); } catch { current = null; }
      if (current == null) continue; // can't change budget safely without the current value
      let next: number;
      if (p.actionType === "decrease_budget") {
        next = Math.max(minViableBudgetCents, Math.round(current * 0.8)); // -20%, floored
        if (next >= current) continue; // already at/below floor
      } else {
        next = Math.min(cfg.maxBudgetCents, Math.round(current * (1 + cfg.increasePct))); // +15%, capped
        if (next <= current) continue; // already at cap
      }
      targetState = { daily_budget: next };
      deltaCents = next - current;
      deltaPct = current > 0 ? (deltaCents / current) * 100 : 0;
    }
    await proposeAction({
      actionType: p.actionType,
      entityType: p.agg.entityType,
      entityId: p.agg.entityId,
      targetState,
      // Deltas drive the per-action + account-cap guardrails (incl. the executor's re-check).
      dailyBudgetDeltaCents: deltaCents,
      dailyBudgetDeltaPct: deltaPct,
      projectedDailySpendCents: accountDailySpendCents + deltaCents,
      evidence: buildEvidence(p, cfg, start, latest.day),
      actor: "optimizer",
      // Deterministic key: dedupes repeat proposals for the same entity+action+rule.
      idempotencyKey: `opt:${p.agg.entityId}:${p.actionType}:${p.ruleId}`,
    });
    created++;
  }
  return { ran: true, proposals: created, day: latest.day, windowStart: start };
}
