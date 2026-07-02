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
}));

import { automationControl, clients } from "@/db/schema";
import { fetchEnabledBudgets } from "@/lib/meta/client";
import {
  AUDIT_ENGINE_VERSION,
  checkBudgetVsCpa,
  checkCapiEnabled,
  checkCopyLength,
  checkCreativeFatigue,
  checkCtrLow,
  checkEmqPurchase,
  checkFrequencyHigh,
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
  vi.mocked(fetchEnabledBudgets).mockReset();
  vi.mocked(fetchEnabledBudgets).mockResolvedValue({ daily: {}, hasLifetime: false });
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

  it("scores creative fatigue boundaries", () => {
    expect(checkCreativeFatigue([]).status).toBe("pass");
    expect(checkCreativeFatigue([fatigueRow("c1")]).status).toBe("warn");
    expect(checkCreativeFatigue([fatigueRow("c1"), fatigueRow("c2"), fatigueRow("c3")]).status).toBe("critical");
  });

  it("scores app-created copy length and non-applicable empty rows", () => {
    expect(checkCopyLength([])).toBeNull();
    expect(checkCopyLength([{ id: "ad1", copy: { headline: "Short", primaryText: "Fine" } }])?.status).toBe("pass");
    expect(checkCopyLength([{ id: "ad1", copy: { headline: "x".repeat(41), primaryText: "Fine" } }])?.status).toBe("warn");
    expect(checkCopyLength([{ id: "ad1", copy: { headline: "Short", primaryText: "x".repeat(126) } }])?.status).toBe("warn");
  });

  it("scores frequency thresholds", () => {
    expect(checkFrequencyHigh({ impressions: 299, reach: 100, clicks: 20, days: 7 }).status).toBe("pass");
    expect(checkFrequencyHigh({ impressions: 300, reach: 100, clicks: 20, days: 7 }).status).toBe("warn");
    expect(checkFrequencyHigh({ impressions: 500, reach: 100, clicks: 20, days: 7 }).status).toBe("warn");
    expect(checkFrequencyHigh({ impressions: 501, reach: 100, clicks: 20, days: 7 }).status).toBe("critical");
    expect(checkFrequencyHigh(null).status).toBe("not_assessed");
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
      checkCreativeFatigue([]),
      checkFrequencyHigh({ impressions: 300, reach: 100, clicks: 20, days: 7 }),
      checkBudgetVsCpa({ daily: {}, hasLifetime: true, targetCpaCents: 1_000 }),
    ]);

    expect(report.version).toBe(AUDIT_ENGINE_VERSION);
    expect(report.score).toBe(88);
    expect(report.assessed).toEqual(["pixel-present", "ctr-low", "creative-fatigue", "frequency-high"]);
    expect(report.notAssessed).toEqual(["capi-enabled", "emq-purchase", "lead-event-firing", "budget-vs-cpa"]);
    expect(summary(report).byCategory.structure.assessed).toBe(0);
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

    expect(report.version).toBe(AUDIT_ENGINE_VERSION);
    expect(report.notAssessed).toContain("ctr-low");
    expect(report.notAssessed).toContain("frequency-high");
    expect(report.findings.some((f) => f.code === "ctr-low" && f.severity === "info")).toBe(true);
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

function summary(report: { summary: unknown }) {
  return report.summary as {
    byCategory: Record<string, { score: number | null; assessed: number }>;
  };
}

void (undefined as unknown as AuditCheckResult);
