// Autonomy guardrail engine — docs/ARCHITECTURE.md §5.
// Pure, synchronous, default-deny. The ONLY consumer that may act on an `allow`
// result is the action executor (see src/lib/executor.ts). UI/AI/optimizer never write.

export type ActionType =
  | "pause_ad" | "pause_adset" | "pause_campaign" | "decrease_budget" // Tier A (spend-reducing)
  | "set_budget"                                    // Tier A only within caps, else approval
  | "create_campaign" | "create_adset" | "create_ad" | "launch_ad"
  | "expand_audience" | "unpause" | "increase_budget" | "change_targeting"; // Tier B

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
export function evaluate(action: ProposedAction, ctx: GuardrailContext): GuardrailResult {
  if (ctx.envWriteMode === "off") return block("ENV_WRITE_DISABLED", "Writes disabled at env level");
  if (ctx.control.emergencyStop || ctx.control.writeMode === "off") return block("KILL_SWITCH", "Kill switch engaged");
  if (action.policyVersion !== ctx.control.activePolicyVersion) return block("POLICY_CHANGED", "Policy version changed; re-propose");

  const spendReducing = SPEND_REDUCING.has(action.actionType);
  // No cascading writes while a previous write is unresolved (in-flight/uncertain). Pauses and
  // decreases stay allowed — they only ever reduce exposure. Cleared once writes reconcile.
  if (ctx.unresolvedWrites && !spendReducing) return block("UNRESOLVED_WRITES", "A prior write is unresolved; blocking until reconciled");
  if (!ctx.metricsFresh && !STALE_EXEMPT.has(action.actionType)) return block("STALE_METRICS", "Metrics stale; blocking spend-increasing write");

  if (!TIER_A_ACTIONS.has(action.actionType)) return requireApproval("TIER_B_ACTION", "Tier B action needs approval");

  if (action.dailyBudgetDeltaCents > ctx.control.maxActionBudgetDeltaCents) return requireApproval("DELTA_TOO_LARGE", "Budget delta exceeds per-action cap");
  if (action.dailyBudgetDeltaPct > ctx.control.maxActionBudgetDeltaPct) return requireApproval("PCT_TOO_LARGE", "Budget delta % exceeds per-action cap");
  if (ctx.projectedDailySpendCents > ctx.control.maxAccountDailySpendCents) return block("ACCOUNT_CAP", "Projected spend exceeds account daily cap");

  return allow("TIER_A_ALLOWED", "Within Tier A guardrails");
}

/** Tier classification for storage/UI. */
export function tierOf(actionType: ActionType): "A" | "B" {
  return TIER_A_ACTIONS.has(actionType) ? "A" : "B";
}
