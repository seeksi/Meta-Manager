import { describe, it, expect } from "vitest";
import { joinCpl } from "./leads";

describe("joinCpl", () => {
  it("computes CPL per campaign and sorts by spend desc", () => {
    const spend = new Map([["c1", 10_000], ["c2", 30_000]]);
    const leads = new Map([["c1", 5], ["c2", 10]]);
    const rows = joinCpl(spend, leads);
    expect(rows[0].campaignId).toBe("c2"); // higher spend first
    expect(rows[0].cplCents).toBe(3000);   // 30000 / 10
    expect(rows[1].cplCents).toBe(2000);   // 10000 / 5
  });

  it("returns null CPL for spend with zero leads", () => {
    const rows = joinCpl(new Map([["c1", 5000]]), new Map());
    expect(rows[0].cplCents).toBeNull();
  });

  it("includes campaigns that have leads but no recorded spend", () => {
    const rows = joinCpl(new Map(), new Map([["c9", 3]]));
    expect(rows[0]).toMatchObject({ campaignId: "c9", spendCents: 0, leads: 3, cplCents: 0 });
  });
});
