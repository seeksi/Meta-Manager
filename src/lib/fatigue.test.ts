import { describe, it, expect } from "vitest";
import { scoreFatigue, DEFAULT_FATIGUE, type DailyPoint } from "./fatigue";

// 7-day series helper: prior 4 days + recent 3 days.
function series(prior: Partial<DailyPoint>[], recent: Partial<DailyPoint>[]): DailyPoint[] {
  const mk = (i: number, p: Partial<DailyPoint>): DailyPoint => ({
    date: `2026-06-${String(10 + i).padStart(2, "0")}`,
    impressions: p.impressions ?? 0, reach: p.reach ?? 0, clicks: p.clicks ?? 0,
  });
  return [...prior, ...recent].map((p, i) => mk(i, p));
}

describe("scoreFatigue", () => {
  it("returns null without enough days", () => {
    expect(scoreFatigue([{ date: "2026-06-10", impressions: 5000, reach: 1000, clicks: 50 }])).toBeNull();
  });

  it("returns null when recent volume is below the confidence gate", () => {
    const pts = series(
      [{ impressions: 200, reach: 150, clicks: 4 }, { impressions: 200, reach: 150, clicks: 4 }, { impressions: 200, reach: 150, clicks: 4 }, { impressions: 200, reach: 150, clicks: 4 }],
      [{ impressions: 100, reach: 90, clicks: 2 }, { impressions: 100, reach: 90, clicks: 2 }, { impressions: 100, reach: 90, clicks: 2 }],
    );
    expect(scoreFatigue(pts)).toBeNull();
  });

  it("flags high frequency", () => {
    // recent: 9000 impr / 3000 reach = freq 3.0 ≥ 2.5
    const pts = series(
      [{ impressions: 1000, reach: 900, clicks: 20 }, { impressions: 1000, reach: 900, clicks: 20 }, { impressions: 1000, reach: 900, clicks: 20 }, { impressions: 1000, reach: 900, clicks: 20 }],
      [{ impressions: 3000, reach: 1000, clicks: 60 }, { impressions: 3000, reach: 1000, clicks: 60 }, { impressions: 3000, reach: 1000, clicks: 60 }],
    );
    const s = scoreFatigue(pts)!;
    expect(s.fatigued).toBe(true);
    expect(s.frequency).toBeCloseTo(3.0, 1);
    expect(s.reasons.some((r) => r.includes("frequency"))).toBe(true);
  });

  it("flags a CTR decline ≥ threshold", () => {
    // prior CTR ~2%, recent CTR ~1% → -50% decline; frequency low (not flagged)
    const pts = series(
      [{ impressions: 2000, reach: 1800, clicks: 40 }, { impressions: 2000, reach: 1800, clicks: 40 }, { impressions: 2000, reach: 1800, clicks: 40 }, { impressions: 2000, reach: 1800, clicks: 40 }],
      [{ impressions: 2000, reach: 1900, clicks: 20 }, { impressions: 2000, reach: 1900, clicks: 20 }, { impressions: 2000, reach: 1900, clicks: 20 }],
    );
    const s = scoreFatigue(pts)!;
    expect(s.fatigued).toBe(true);
    expect(s.ctrDeltaPct).toBeLessThanOrEqual(-DEFAULT_FATIGUE.ctrDropPct);
    expect(s.reasons.some((r) => r.includes("CTR"))).toBe(true);
  });

  it("does not flag a healthy, stable creative", () => {
    const pts = series(
      [{ impressions: 2000, reach: 1800, clicks: 40 }, { impressions: 2000, reach: 1800, clicks: 40 }, { impressions: 2000, reach: 1800, clicks: 40 }, { impressions: 2000, reach: 1800, clicks: 40 }],
      [{ impressions: 2000, reach: 1800, clicks: 42 }, { impressions: 2000, reach: 1800, clicks: 41 }, { impressions: 2000, reach: 1800, clicks: 40 }],
    );
    expect(scoreFatigue(pts)!.fatigued).toBe(false);
  });
});
