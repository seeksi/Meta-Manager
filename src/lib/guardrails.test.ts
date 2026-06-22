import { describe, it, expect } from "vitest";
import { evaluate, tierOf, type GuardrailContext, type ProposedAction } from "./guardrails";

const baseControl: GuardrailContext["control"] = {
  writeMode: "all",
  emergencyStop: false,
  maxAccountDailySpendCents: 100_00,
  maxActionBudgetDeltaCents: 10_00,
  maxActionBudgetDeltaPct: 20,
  activePolicyVersion: 1,
};

function ctx(over: Partial<GuardrailContext> = {}): GuardrailContext {
  return {
    envWriteMode: "all",
    control: baseControl,
    metricsFresh: true,
    unresolvedWrites: false,
    projectedDailySpendCents: 50_00,
    ...over,
  };
}

function action(over: Partial<ProposedAction> = {}): ProposedAction {
  return { actionType: "set_budget", policyVersion: 1, dailyBudgetDeltaCents: 0, dailyBudgetDeltaPct: 0, ...over };
}

describe("guardrails.evaluate — default-deny safety", () => {
  it("blocks when env write mode is off", () => {
    expect(evaluate(action(), ctx({ envWriteMode: "off" })).code).toBe("ENV_WRITE_DISABLED");
  });

  it("blocks when kill switch engaged", () => {
    expect(evaluate(action(), ctx({ control: { ...baseControl, emergencyStop: true } })).decision).toBe("block");
  });

  it("blocks when write mode is off", () => {
    expect(evaluate(action(), ctx({ control: { ...baseControl, writeMode: "off" } })).code).toBe("KILL_SWITCH");
  });

  it("blocks on policy version mismatch", () => {
    expect(evaluate(action({ policyVersion: 2 }), ctx()).code).toBe("POLICY_CHANGED");
  });

  it("blocks spend-increasing action on stale metrics", () => {
    expect(evaluate(action(), ctx({ metricsFresh: false })).code).toBe("STALE_METRICS");
  });

  it("ALLOWS spend-reducing action even on stale metrics", () => {
    const r = evaluate(action({ actionType: "decrease_budget" }), ctx({ metricsFresh: false }));
    expect(r.decision).toBe("allow");
  });

  it("blocks spend-increasing action while a prior write is unresolved", () => {
    expect(evaluate(action(), ctx({ unresolvedWrites: true })).code).toBe("UNRESOLVED_WRITES");
  });

  it("ALLOWS spend-reducing action even with unresolved writes", () => {
    const r = evaluate(action({ actionType: "pause_campaign" }), ctx({ unresolvedWrites: true }));
    expect(r.decision).toBe("allow");
  });

  it("routes Tier B actions to approval", () => {
    expect(evaluate(action({ actionType: "create_campaign" }), ctx()).decision).toBe("require_approval");
  });

  it("lets launch_ad reach approval even on stale metrics (paused create, no spend)", () => {
    expect(evaluate(action({ actionType: "launch_ad" }), ctx({ metricsFresh: false })).decision).toBe("require_approval");
  });

  it("still blocks launch_ad while a prior write is unresolved", () => {
    expect(evaluate(action({ actionType: "launch_ad" }), ctx({ unresolvedWrites: true })).code).toBe("UNRESOLVED_WRITES");
  });

  it("requires approval when budget delta exceeds per-action cap", () => {
    expect(evaluate(action({ dailyBudgetDeltaCents: 20_00 }), ctx()).code).toBe("DELTA_TOO_LARGE");
  });

  it("requires approval when budget delta % exceeds cap", () => {
    expect(evaluate(action({ dailyBudgetDeltaPct: 50 }), ctx()).code).toBe("PCT_TOO_LARGE");
  });

  it("blocks when projected spend exceeds the account cap", () => {
    expect(evaluate(action(), ctx({ projectedDailySpendCents: 200_00 })).code).toBe("ACCOUNT_CAP");
  });

  it("allows a small Tier A change within all caps", () => {
    const r = evaluate(action({ dailyBudgetDeltaCents: 5_00, dailyBudgetDeltaPct: 10 }), ctx());
    expect(r.decision).toBe("allow");
  });
});

describe("tierOf", () => {
  it("classifies pause/decrease/set_budget as Tier A", () => {
    expect(tierOf("pause_campaign")).toBe("A");
    expect(tierOf("decrease_budget")).toBe("A");
    expect(tierOf("set_budget")).toBe("A");
  });
  it("classifies growth/structure actions as Tier B", () => {
    expect(tierOf("create_campaign")).toBe("B");
    expect(tierOf("increase_budget")).toBe("B");
    expect(tierOf("expand_audience")).toBe("B");
  });
});
