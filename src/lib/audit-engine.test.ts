import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  client: null as unknown as PGlite,
}));

vi.mock("@/db", async () => {
  const real = await vi.importActual<typeof import("@/db/schema")>("@/db/schema");
  return { getDb: () => h.db, schema: real.schema };
});

vi.mock("@/lib/meta/client", () => ({
  fetchEnabledBudgets: vi.fn(async () => ({ daily: {}, hasLifetime: false })),
  fetchCampaigns: vi.fn(async () => []),
  fetchAdsetsDetail: vi.fn(async () => []),
  fetchAdsWithCreative: vi.fn(async () => []),
  fetchAccountReach: vi.fn(async () => ({ impressions: 0, reach: 0 })),
}));

import { automationControl, clients } from "@/db/schema";
import {
  fetchAccountReach,
  fetchAdsWithCreative,
  fetchAdsetsDetail,
  fetchCampaigns,
  fetchEnabledBudgets,
} from "@/lib/meta/client";
import {
  AUDIT_ENGINE_VERSION,
  checkBudgetVsCpa,
  checkCampaignCount,
  checkCapiEnabled,
  checkCboVsAbo,
  checkCopyLength,
  checkCreativeFatigue,
  checkCreativesPerAdset,
  checkCtrLow,
  checkEmqPurchase,
  checkFormatDiversity,
  checkFrequencyHigh,
  checkLearningLimited,
  checkLeadEventFiring,
  checkPixelPresent,
  runAudit,
  scoreAudit,
  type AuditCheckResult,
} from "@/lib/audit-engine";

const CLIENT_ID = "99999999-9999-9999-9999-999999999999";

beforeAll(async () => {
  h.client = new PGlite();
  h.db = drizzle(h.client);
  const dir = join(process.cwd(), "drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await h.client.exec(readFileSync(join(dir, f), "utf8"));
  }
});

beforeEach(() => {
  vi.mocked(fetchEnabledBudgets).mockReset().mockResolvedValue({ daily: {}, hasLifetime: false });
  vi.mocked(fetchCampaigns).mockReset().mockResolvedValue([]);
  vi.mocked(fetchAdsetsDetail).mockReset().mockResolvedValue([]);
  vi.mocked(fetchAdsWithCreative).mockReset().mockResolvedValue([]);
  vi.mocked(fetchAccountReach).mockReset().mockResolvedValue({ impressions: 0, reach: 0 });
});

describe("audit pure checks", () => {
  it("scores pixel presence", () => {
    expect(checkPixelPresent("123").status).toBe("pass");
    expect(checkPixelPresent("").status).toBe("critical");
    expect(checkPixelPresent(null).finding?.severity).toBe("critical");
  });

  it("scores CAPI questionnaire answers", () => {
    expect(checkCapiEnabled({ capiEnabled: true }).status).toBe("pass");
    expect(checkCapiEnabled({ capiEnabled: false }).status).toBe("critical");
    expect(checkCapiEnabled({}).status).toBe("not_assessed");
  });

  it("scores Purchase EMQ boundaries", () => {
    expect(checkEmqPurchase({ emqPurchase: 8 }).status).toBe("pass");
    expect(checkEmqPurchase({ emqPurchase: 7.9 }).status).toBe("warn");
    expect(checkEmqPurchase({ emqPurchase: 6 }).status).toBe("warn");
    expect(checkEmqPurchase({ emqPurchase: 5.99 }).status).toBe("critical");
    expect(checkEmqPurchase({}).status).toBe("not_assessed");
  });

  it("scores Lead event firing", () => {
    expect(checkLeadEventFiring({ leadEventFiring: true }).status).toBe("pass");
    expect(checkLeadEventFiring({ leadEventFiring: false }).status).toBe("critical");
    expect(checkLeadEventFiring({}).status).toBe("not_assessed");
  });

  it("scores CTR thresholds", () => {
    expect(checkCtrLow({ impressions: 10_000, reach: 8_000, clicks: 100, days: 7 }).status).toBe("pass");
    expect(checkCtrLow({ impressions: 10_000, reach: 8_000, clicks: 50, days: 7 }).status).toBe("warn");
    expect(checkCtrLow({ impressions: 10_000, reach: 8_000, clicks: 49, days: 7 }).status).toBe("critical");
    expect(checkCtrLow(null).status).toBe("not_assessed");
  });

  it("scores creative fatigue by percent of active campaigns and defers without insight data", () => {
    expect(checkCreativeFatigue([], false).status).toBe("not_assessed");
    expect(checkCreativeFatigue([], true, 4).status).toBe("pass"); // 0% fatigued
    expect(checkCreativeFatigue([fatigueRow("c1")], true, 4).status).toBe("warn"); // 1 of 4 = 25%
    expect(checkCreativeFatigue([fatigueRow("c1"), fatigueRow("c2")], true, 4).status).toBe("critical"); // 2 of 4 = 50% > 30%
    // without a denominator it falls back to a count ceiling: <3 warn, ≥3 critical
    expect(checkCreativeFatigue([fatigueRow("c1"), fatigueRow("c2")], true, null).status).toBe("warn");
    expect(checkCreativeFatigue([fatigueRow("c1"), fatigueRow("c2"), fatigueRow("c3")], true, null).status).toBe("critical");
  });

  it("scores app-created copy length and non-applicable empty rows", () => {
    expect(checkCopyLength([])).toBeNull();
    expect(checkCopyLength([{ id: "ad1", copy: { headline: "Short", primaryText: "Fine" } }])?.status).toBe("pass");
    expect(checkCopyLength([{ id: "ad1", copy: { headline: "x".repeat(41), primaryText: "Fine" } }])?.status).toBe("warn");
    expect(checkCopyLength([{ id: "ad1", copy: { headline: "Short", primaryText: "x".repeat(126) } }])?.status).toBe("warn");
  });

  it("scores real 7-day frequency from period reach", () => {
    // freq = impressions / reach: 2.9 pass, 3.0 warn, 5.0 warn, 5.1 critical
    expect(checkFrequencyHigh({ impressions: 2_900, reach: 1_000 }).status).toBe("pass");
    expect(checkFrequencyHigh({ impressions: 3_000, reach: 1_000 }).status).toBe("warn");
    expect(checkFrequencyHigh({ impressions: 5_000, reach: 1_000 }).status).toBe("warn");
    expect(checkFrequencyHigh({ impressions: 5_100, reach: 1_000 }).status).toBe("critical");
    expect(checkFrequencyHigh({ impressions: 100, reach: 0 }).status).toBe("not_assessed");
    expect(checkFrequencyHigh({ impressions: NaN, reach: 1_000 }).status).toBe("not_assessed"); // non-numeric → not a false pass
    expect(checkFrequencyHigh(null).status).toBe("not_assessed");
    expect(checkFrequencyHigh(null, "token").status).toBe("not_assessed");
  });

  it("scores campaign count", () => {
    expect(checkCampaignCount([]).status).toBe("not_assessed"); // no active campaigns
    expect(checkCampaignCount([campaign("a"), campaign("b"), campaign("c")]).status).toBe("pass");
    expect(checkCampaignCount([campaign("a"), campaign("b"), campaign("c"), campaign("d")]).status).toBe("warn");
    expect(checkCampaignCount(null, "token").status).toBe("not_assessed");
  });

  it("scores CBO vs ABO consistency", () => {
    expect(checkCboVsAbo([campaign("a", { dailyCents: 1_000 }), campaign("b", { dailyCents: 2_000 })]).status).toBe("pass");
    expect(checkCboVsAbo([campaign("a"), campaign("b")]).status).toBe("pass"); // all ABO
    expect(checkCboVsAbo([campaign("a", { dailyCents: 1_000 }), campaign("b")]).status).toBe("warn"); // mixed
    expect(checkCboVsAbo([]).status).toBe("not_assessed");
    expect(checkCboVsAbo(null, "token").status).toBe("not_assessed");
  });

  it("scores learning-limited share", () => {
    const active = (stage?: string) => ({ id: stage ?? "x", effectiveStatus: "ACTIVE", learningStage: stage });
    expect(checkLearningLimited([active(), active(), active(), active(), active("LEARNING_LIMITED")]).status).toBe("pass"); // 20%
    expect(checkLearningLimited([active(), active(), active("LEARNING_LIMITED")]).status).toBe("warn"); // 33%
    expect(checkLearningLimited([active("LEARNING_LIMITED"), active("LEARNING_LIMITED"), active()]).status).toBe("critical"); // 67%
    expect(checkLearningLimited([]).status).toBe("not_assessed");
    expect(checkLearningLimited(null, "token").status).toBe("not_assessed");
  });

  it("scores creative format diversity per active adset", () => {
    const ad = (adsetId: string, format: string, i: number) => ({ id: `${adsetId}-${i}`, adsetId, effectiveStatus: "ACTIVE", format });
    const diverse = [ad("s1", "VIDEO", 1), ad("s1", "PHOTO", 2), ad("s1", "SHARE", 3)];
    expect(checkFormatDiversity(diverse).status).toBe("pass");
    expect(checkFormatDiversity([ad("s1", "VIDEO", 1), ad("s1", "PHOTO", 2)]).status).toBe("warn"); // 2 formats
    expect(checkFormatDiversity([]).status).toBe("not_assessed");
    expect(checkFormatDiversity(null, "token").status).toBe("not_assessed");
    // paused ads are ignored
    expect(checkFormatDiversity([{ id: "p", adsetId: "s1", effectiveStatus: "PAUSED", format: "VIDEO" }]).status).toBe("not_assessed");
  });

  it("scores creatives per active adset", () => {
    const ad = (adsetId: string, i: number) => ({ id: `${adsetId}-${i}`, adsetId, effectiveStatus: "ACTIVE", format: "VIDEO" });
    const five = [1, 2, 3, 4, 5].map((i) => ad("s1", i));
    expect(checkCreativesPerAdset(five).status).toBe("pass");
    expect(checkCreativesPerAdset([ad("s1", 1), ad("s1", 2)]).status).toBe("warn"); // 2 ads
    expect(checkCreativesPerAdset([]).status).toBe("not_assessed");
    expect(checkCreativesPerAdset(null, "token").status).toBe("not_assessed");
  });

  it("scores budget versus CPA boundaries and skips unsafe live-read states", () => {
    expect(checkBudgetVsCpa({ daily: { a: 1_999 }, hasLifetime: false, targetCpaCents: 1_000 }).status).toBe("critical");
    expect(checkBudgetVsCpa({ daily: { a: 2_000 }, hasLifetime: false, targetCpaCents: 1_000 }).status).toBe("warn");
    expect(checkBudgetVsCpa({ daily: { a: 5_000 }, hasLifetime: false, targetCpaCents: 1_000 }).status).toBe("pass");
    expect(checkBudgetVsCpa({ daily: { a: 10_000 }, hasLifetime: true, targetCpaCents: 1_000 }).status).toBe("not_assessed");
    expect(checkBudgetVsCpa({ daily: {}, hasLifetime: false, targetCpaCents: 1_000, metaError: "token" }).status).toBe("not_assessed");
  });
});

describe("audit scoring", () => {
  it("uses assessed-only checks and renormalizes categories with zero assessed checks", () => {
    const report = scoreAudit([
      checkPixelPresent("px_1"),
      checkCapiEnabled({}),
      checkEmqPurchase({}),
      checkLeadEventFiring({}),
      checkCtrLow({ impressions: 10_000, reach: 8_000, clicks: 100, days: 7 }),
      checkCreativeFatigue([], true),
      checkFrequencyHigh(null),
      checkBudgetVsCpa({ daily: {}, hasLifetime: true, targetCpaCents: 1_000 }),
    ]);

    expect(report.version).toBe(AUDIT_ENGINE_VERSION);
    expect(report.score).toBe(100);
    expect(report.assessed).toEqual(["pixel-present", "ctr-low", "creative-fatigue"]);
    expect(report.notAssessed).toEqual(["capi-enabled", "emq-purchase", "lead-event-firing", "frequency-high", "budget-vs-cpa"]);
    expect(summary(report).byCategory.structure.assessed).toBe(0);
    expect(summary(report).byCategory.audience.assessed).toBe(0);
    // not_assessed checks must not leak into the findings list
    expect(report.findings.every((f) => f.severity !== "info")).toBe(true);
  });
});

describe("runAudit", () => {
  it("does not throw for a new client with empty stored data", async () => {
    await h.db.insert(clients).values({
      id: CLIENT_ID,
      name: "Empty Audit Client",
      metaAccountId: "act_empty_audit",
    }).onConflictDoNothing();
    await h.db.insert(automationControl).values({
      clientId: CLIENT_ID,
      targetCpaCents: 5_000,
    }).onConflictDoNothing();

    const report = await runAudit(CLIENT_ID, {});

    expect(AUDIT_ENGINE_VERSION).toBe(2);
    expect(report.version).toBe(2);
    expect(report.notAssessed).toContain("ctr-low");
    expect(report.notAssessed).toContain("frequency-high");
    expect(report.notAssessed).toContain("creative-fatigue");
    // not_assessed checks stay out of findings; only real warn/critical findings appear there
    expect(report.findings.every((f) => f.severity !== "info")).toBe(true);
  });

  it("degrades every live read to not_assessed when Meta calls reject (no throw)", async () => {
    await h.db.insert(clients).values({
      id: CLIENT_ID,
      name: "Empty Audit Client",
      metaAccountId: "act_empty_audit",
    }).onConflictDoNothing();
    const boom = () => Promise.reject(new Error("meta down"));
    vi.mocked(fetchEnabledBudgets).mockImplementation(boom);
    vi.mocked(fetchCampaigns).mockImplementation(boom);
    vi.mocked(fetchAdsetsDetail).mockImplementation(boom);
    vi.mocked(fetchAdsWithCreative).mockImplementation(boom);
    vi.mocked(fetchAccountReach).mockImplementation(boom);

    const report = await runAudit(CLIENT_ID, {});

    for (const code of [
      "budget-vs-cpa", "campaign-count", "cbo-vs-abo", "learning-limited",
      "format-diversity", "creatives-per-adset", "frequency-high",
    ]) {
      expect(report.notAssessed).toContain(code);
    }
    expect(report.findings.every((f) => f.severity !== "info")).toBe(true);
  });
});

describe("read-only import guard", () => {
  it("does not import Meta write/executor paths", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/audit-engine.ts"), "utf8");
    expect(source).not.toMatch(/applyAbsolutePatch|executor/i);
  });
});

function fatigueRow(entityId: string) {
  return {
    entityId,
    fatigued: true,
    frequency: 3,
    recentCtr: 0.01,
    priorCtr: 0.02,
    ctrDeltaPct: -0.5,
    reasons: ["CTR down 50%"],
  };
}

function campaign(id: string, opts: { dailyCents?: number | null; lifetimeCents?: number | null } = {}) {
  return {
    id,
    name: id,
    effectiveStatus: "ACTIVE",
    dailyCents: opts.dailyCents ?? null,
    lifetimeCents: opts.lifetimeCents ?? null,
  };
}

function summary(report: { summary: unknown }) {
  return report.summary as {
    byCategory: Record<string, { score: number | null; assessed: number }>;
  };
}

void (undefined as unknown as AuditCheckResult);
