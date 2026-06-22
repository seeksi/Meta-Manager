import { describe, it, expect } from "vitest";
import { evaluateEntity, DEFAULT_CONFIG } from "./optimizer";

const cfg = DEFAULT_CONFIG; // targetCpa $50, killMultiple 3, minSpend $50, minConv 3, targetRoas 2

function agg(over: Partial<Parameters<typeof evaluateEntity>[0]> = {}) {
  return {
    entityType: "campaign", entityId: "c1",
    spendCents: 20_000, purchases: 5, revenueCents: 60_000, impressions: 5000, clicks: 100,
    ...over,
  };
}

describe("optimizer.evaluateEntity — confidence gates", () => {
  it("does nothing below the min-spend gate", () => {
    expect(evaluateEntity(agg({ spendCents: 1_000 }), cfg)).toBeNull();
  });

  it("does nothing below the impression+click confidence gate", () => {
    expect(evaluateEntity(agg({ impressions: 100, clicks: 2 }), cfg)).toBeNull();
  });
});

describe("optimizer.evaluateEntity — kill rules (Tier A pause)", () => {
  it("pauses on spend past kill threshold with zero conversions", () => {
    const p = evaluateEntity(agg({ purchases: 0, revenueCents: 0, spendCents: 16_000 }), cfg);
    expect(p?.actionType).toBe("pause_campaign");
    expect(p?.ruleId).toBe("no_conversion_kill");
  });

  it("pauses on CPA blown out beyond the kill multiple", () => {
    // 4 purchases, $200 spend → CPA $50? no: 20000/4=5000=$50. Make CPA high:
    const p = evaluateEntity(agg({ purchases: 4, spendCents: 80_000, revenueCents: 10_000 }), cfg);
    // CPA = 80000/4 = 20000 = $200 = 4x target → kill
    expect(p?.actionType).toBe("pause_campaign");
    expect(p?.ruleId).toBe("cpa_kill");
  });
});

describe("optimizer.evaluateEntity — decrease & healthy", () => {
  it("proposes a budget decrease when ROAS is far below target", () => {
    // roas = rev/spend = 10000/20000 = 0.5 <= 0.5*targetRoas(2)=1.0; purchases>=3; cpa not kill
    const p = evaluateEntity(agg({ purchases: 5, spendCents: 20_000, revenueCents: 10_000 }), cfg);
    expect(p?.actionType).toBe("decrease_budget");
    expect(p?.ruleId).toBe("low_roas_decrease");
  });

  it("leaves a healthy but low-volume entity alone (below scale confidence)", () => {
    // roas 3.0, cpa $40, but only 5 purchases < scaleMinConversions(25) → null
    expect(evaluateEntity(agg(), cfg)).toBeNull();
  });

  it("proposes a Tier B budget increase for a clear, high-confidence winner", () => {
    // 30 purchases, $1000 spend, $3000 rev → roas 3.0 (≥2.3), cpa $33.33 (≤$42.50)
    const p = evaluateEntity(agg({ purchases: 30, spendCents: 100_000, revenueCents: 300_000 }), cfg);
    expect(p?.actionType).toBe("increase_budget");
    expect(p?.ruleId).toBe("scale_winner");
  });
});
