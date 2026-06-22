import { describe, it, expect } from "vitest";
import { rollupDaily } from "./metrics";

describe("rollupDaily", () => {
  it("aggregates campaign rows per day and computes ROAS", () => {
    const out = rollupDaily([
      { dateStart: "2026-06-02", entityType: "campaign", spendCents: 1000, revenueCents: 3000 },
      { dateStart: "2026-06-01", entityType: "campaign", spendCents: 2000, revenueCents: 2000 },
      { dateStart: "2026-06-02", entityType: "campaign", spendCents: 1000, revenueCents: 1000 },
    ]);
    expect(out.map((p) => p.day)).toEqual(["2026-06-01", "2026-06-02"]); // sorted
    expect(out[1]).toMatchObject({ day: "2026-06-02", spendCents: 2000 });
    expect(out[1].roas).toBeCloseTo(2.0, 5); // (3000+1000)/(1000+1000)
  });

  it("ignores non-campaign levels to avoid double counting", () => {
    const out = rollupDaily([
      { dateStart: "2026-06-01", entityType: "campaign", spendCents: 1000, revenueCents: 2000 },
      { dateStart: "2026-06-01", entityType: "account", spendCents: 9999, revenueCents: 9999 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].spendCents).toBe(1000);
  });

  it("returns ROAS 0 for zero-spend days", () => {
    const out = rollupDaily([{ dateStart: "2026-06-01", entityType: "campaign", spendCents: 0, revenueCents: 0 }]);
    expect(out[0].roas).toBe(0);
  });
});
