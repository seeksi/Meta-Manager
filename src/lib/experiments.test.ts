import { describe, it, expect } from "vitest";
import { twoProportionTest } from "./experiments";

describe("twoProportionTest", () => {
  it("returns null with zero trials", () => {
    expect(twoProportionTest(0, 0, 5, 100)).toBeNull();
  });

  it("finds no significance for near-identical rates", () => {
    const r = twoProportionTest(50, 1000, 52, 1000)!;
    expect(r.significant).toBe(false);
    expect(r.winner).toBeNull();
    expect(r.pValue).toBeGreaterThan(0.05);
  });

  it("detects a significant winner with a large, clear difference", () => {
    // A: 2% CVR, B: 6% CVR, big samples → highly significant, B wins
    const r = twoProportionTest(40, 2000, 120, 2000)!;
    expect(r.significant).toBe(true);
    expect(r.winner).toBe("B");
    expect(r.pValue).toBeLessThan(0.01);
  });

  it("computes correct rates", () => {
    const r = twoProportionTest(25, 100, 50, 100)!;
    expect(r.rateA).toBeCloseTo(0.25, 5);
    expect(r.rateB).toBeCloseTo(0.5, 5);
  });

  it("handles identical zero-conversion variants without dividing by zero", () => {
    const r = twoProportionTest(0, 500, 0, 500)!;
    expect(r.significant).toBe(false);
    expect(r.pValue).toBe(1);
  });
});
