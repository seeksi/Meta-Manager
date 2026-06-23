// Autonomy guardrail engine — docs/ARCHITECTURE.md §5.
// Pure, synchronous, default-deny. The ONLY consumer that may act on an `allow`
// result is the action executor (see src/lib/executor.ts). UI/AI/optimizer never write.

// Runtime list (single source of truth) so request validation can check actionType.
export const ACTION_TYPES = [
  "pause_ad", "pause_adset", "pause_campaign", "decrease_budget", // Tier A (spend-reducing)
  "set_budget",                                    // Tier A only within caps, else approval
  "create_campaign", "create_adset", "create_ad", "launch_ad",
  "expand_audience", "unpause", "increase_budget", "change_targeting", // Tier B
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const TIER_A_ACTIONS = new Set<ActionType>([
  "pause_ad", "pause_adset", "pause_campaign", "decrease_budget", "set_budget",
]);

const SPEND_REDUCING = new Set<ActionType>([
  "pause_ad", "pause_adset", "pause_campaign", "decrease_budget",
]);

// Actions allowed under stale metrics: spend-reducing ones, plus launch_ad (creates a PAUSED
// object — no immediate spend, and a brand-new account legitimately has no metrics yet).
const STALE_EXEMPT = new Set<ActionType>([...SPEND_REDUCING, "launch_ad"]);

export type Decision = "allow" | "require_approval" | "block";

export interface GuardrailResult {
  decision: Decision;
  code: string;
  message: string;
}

export interface AutomationControlState {
  writeMode: "off" | "observe" | "tier_a" | "all";
  emergencyStop: boolean; // true = kill switch engaged
  maxAccountDailySpendCents: number;
  maxActionBudgetDeltaCents: number;
  maxActionBudgetDeltaPct: number;
  activePolicyVersion: number;
}

export interface GuardrailContext {
  envWriteMode: "off" | "observe" | "tier_a" | "all"; // process.env master gate
  control: AutomationControlState;
  metricsFresh: boolean;
  unresolvedWrites: boolean; // a prior write is in-flight/uncertain (crash recovery) → fail closed
  projectedDailySpendCents: number; // account spend if this action applies
}

export interface ProposedAction {
  actionType: ActionType;
  policyVersion: number;
  dailyBudgetDeltaCents: number; // 0 for non-budget actions; positive = increase
  dailyBudgetDeltaPct: number;
}

const block = (code: string, message = code): GuardrailResult => ({ decision: "block", code, message });
const requireApproval = (code: string, message = code): GuardrailResult => ({ decision: "require_approval", code, message });
const allow = (code: string, message = code): GuardrailResult => ({ decision: "allow", code, message });

/**
 * Default-deny: any spend-increasing action is blocked unless every check passes.
 * Spend-reducing actions (pause/decrease) are still permitted under stale metrics.
 */
const MODE_RANK = { off: 0, observe: 1, tier_a: 2, all: 3 } as const;

export function evaluate(action: ProposedAction, ctx: GuardrailContext): GuardrailResult {
  if (ctx.envWriteMode === "off") return block("ENV_WRITE_DISABLED", "Writes disabled at env level");
  if (ctx.control.emergencyStop || ctx.control.writeMode === "off") return block("KILL_SWITCH", "Kill switch engaged");
  // Effective mode = the STRICTER of the env gate and the DB control. observe (or off) writes
  // nothing; tier_a permits only Tier A; all permits approved Tier B too. Previously only `off`
  // blocked, so observe/tier_a silently behaved like `all` — an approved Tier B could execute.
  // Unknown/garbled mode strings rank as 0 (off) → fail closed, never fail open.
  const rank = (m: string) => MODE_RANK[m as keyof typeof MODE_RANK] ?? 0;
  const effective = Math.min(rank(ctx.envWriteMode), rank(ctx.control.writeMode));
  if (effective <= MODE_RANK.observe) return block("OBSERVE_MODE", "Observe mode — writes disabled");
  if (action.policyVersion !== ctx.control.activePolicyVersion) return block("POLICY_CHANGED", "Policy version changed; re-propose");

  const spendReducing = SPEND_REDUCING.has(action.actionType);
  // No cascading writes while a previous write is unresolved (in-flight/uncertain). Pauses and
  // decreases stay allowed — they only ever reduce exposure. Cleared once writes reconcile.
  if (ctx.unresolvedWrites && !spendReducing) return block("UNRESOLVED_WRITES", "A prior write is unresolved; blocking until reconciled");
  if (!ctx.metricsFresh && !STALE_EXEMPT.has(action.actionType)) return block("STALE_METRICS", "Metrics stale; blocking spend-increasing write");

  // Account daily-spend cap is an absolute ceiling on SPEND-INCREASING actions, checked before
  // tier routing so an (approved) Tier B budget increase is still cap-checked. Spend-reducing
  // actions (pause/decrease) are exempt — they lower exposure and must never be blocked by it,
  // even when the account is already over cap. A 0 projection never trips.
  if (!spendReducing && ctx.projectedDailySpendCents > ctx.control.maxAccountDailySpendCents) {
    return block("ACCOUNT_CAP", "Projected spend exceeds account daily cap");
  }

  if (!TIER_A_ACTIONS.has(action.actionType)) {
    // Tier B may only ever execute under `all`. Under tier_a it's forbidden, not merely queued.
    if (effective < MODE_RANK.all) return block("TIER_B_FORBIDDEN", "Tier B writes require write mode 'all'");
    return requireApproval("TIER_B_ACTION", "Tier B action needs approval");
  }

  if (action.dailyBudgetDeltaCents > ctx.control.maxActionBudgetDeltaCents) return requireApproval("DELTA_TOO_LARGE", "Budget delta exceeds per-action cap");
  if (action.dailyBudgetDeltaPct > ctx.control.maxActionBudgetDeltaPct) return requireApproval("PCT_TOO_LARGE", "Budget delta % exceeds per-action cap");

  return allow("TIER_A_ALLOWED", "Within Tier A guardrails");
}

/** Tier classification for storage/UI. */
export function tierOf(actionType: ActionType): "A" | "B" {
  return TIER_A_ACTIONS.has(actionType) ? "A" : "B";
}
