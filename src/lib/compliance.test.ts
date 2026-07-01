// M5 compliance gate. Two layers:
//  1. Hermetic unit tests of the pure ruleset (guardrails.test.ts style — no DB).
//  2. A pglite integration test (client-isolation.test.ts harness) proving a non-compliant
//     proposal persists status='blocked' / compliance_status='block', audits the ruleset version,
//     is NEVER dispatched, and never touches another client's rows.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { evaluateCompliance, COMPLIANCE_VERSION, type Reviewable } from "./compliance";

const R = (over: Partial<Reviewable> = {}): Reviewable => ({ copy: "", targeting: {}, ...over });

describe("evaluateCompliance — med-spa ruleset (pure)", () => {
  it("BLOCKs a personal 'your body' before-after creative", () => {
    const r = evaluateCompliance(R({ copy: "See your body before & after our treatment!" }));
    expect(r.status).toBe("block");
    expect(r.findings.some((f) => f.ruleId === "creative.personal_before_after")).toBe(true);
  });

  it("PASSes a general-benefit reworded creative", () => {
    const r = evaluateCompliance(R({ copy: "Feel refreshed and confident — book a consultation today." }));
    expect(r.status).toBe("pass");
    expect(r.findings).toHaveLength(0);
  });

  it("BLOCKs personal-health-attribute targeting", () => {
    const r = evaluateCompliance(R({ targeting: { interests: ["weight loss", "skincare"] } }));
    expect(r.status).toBe("block");
    expect(r.findings.some((f) => f.ruleId === "targeting.personal_health_attribute")).toBe(true);
  });

  it("FLAGs (does not block) an unsubstantiated results claim", () => {
    const r = evaluateCompliance(R({ copy: "Guaranteed to melt away fat — lose 20 lbs fast!" }));
    expect(r.status).toBe("flag");
    expect(r.findings.every((f) => f.severity === "flag")).toBe(true);
  });

  it("does NOT flag a results claim carrying the FTC disclaimer", () => {
    const r = evaluateCompliance(R({ copy: "Patients can lose 20 lbs. Results not typical; individual results vary." }));
    expect(r.status).toBe("pass");
  });

  it("FLAGs a TCPA contact promise without consent language", () => {
    const r = evaluateCompliance(R({ copy: "We'll call you within 5 minutes and send a reminder text." }));
    expect(r.status).toBe("flag");
    expect(r.findings.some((f) => f.category === "tcpa")).toBe(true);
  });

  it("BLOCK outranks FLAG (strongest severity wins)", () => {
    const r = evaluateCompliance(R({ copy: "Guaranteed! See your body before and after." }));
    expect(r.status).toBe("block");
  });

  it("honors the per-client extraBlockTerms exclusion seam", () => {
    const clean = evaluateCompliance(R({ copy: "Ozempic-free weight guidance" }));
    // 'weight' alone is fine in copy; add a client self-ban term to force a block.
    const banned = evaluateCompliance(R({ copy: "Try our microneedling special" }), ["microneedling"]);
    expect(clean.status).toBe("pass");
    expect(banned.status).toBe("block");
    expect(banned.findings.some((f) => f.ruleId === "client.excluded_term")).toBe(true);
  });

  it("stamps the ruleset version on every result", () => {
    for (const r of [R(), R({ copy: "See your body before & after" })]) {
      expect(evaluateCompliance(r).version).toBe(COMPLIANCE_VERSION);
    }
  });
});

// ── Integration (pglite, real automation paths) ──────────────────────────────────────
const h = vi.hoisted(() => {
  process.env.WRITE_MODE = "all";
  return { db: null as unknown as ReturnType<typeof drizzle>, client: null as unknown as PGlite };
});

vi.mock("@/db", async () => {
  const real = await vi.importActual<typeof import("@/db/schema")>("@/db/schema");
  return { getDb: () => h.db, schema: real.schema };
});

vi.mock("@/lib/meta/client", () => ({
  applyAbsolutePatch: vi.fn(async () => ({ ok: true, metaResponse: {} })),
  getDailyBudgetCents: vi.fn(async () => 10_000),
  fetchEnabledBudgets: vi.fn(async () => ({ daily: {}, hasLifetime: false })),
  getBudgetInfo: vi.fn(async () => ({ isBudgetNode: false, dailyCents: null, lifetimeCents: null })),
  fetchChildAdsetBudgets: vi.fn(async () => ({ dailyCents: 0, hasLifetime: false })),
  findByLaunchToken: vi.fn(async () => []),
  createAdCreative: vi.fn(async () => "cr_1"),
  createAdObject: vi.fn(async () => "ad_1"),
}));

import { clients, metricFetches, adActions } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { ensureControl, setControl, ensureAgencyControl, proposeAction, listAudit } from "@/lib/automation";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

beforeAll(async () => {
  h.client = new PGlite();
  h.db = drizzle(h.client);
  const dir = join(process.cwd(), "drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await h.client.exec(readFileSync(join(dir, f), "utf8"));
  }
  await h.db.insert(clients).values([
    { id: A, name: "Spa A", metaAccountId: "act_A", verifyState: "active" },
    { id: B, name: "Spa B", metaAccountId: "act_B", verifyState: "active" },
  ]);
  await ensureControl(A);
  await ensureControl(B);
  await ensureAgencyControl();
  await setControl(A, { writeMode: "all", emergencyStop: false });
  await setControl(B, { writeMode: "all", emergencyStop: false });
  await h.db.insert(metricFetches).values([
    { source: "test", request: { accountId: "act_A" } },
    { source: "test", request: { accountId: "act_B" } },
  ]);
});

// change_targeting is Tier B → pending_approval when compliant (no dispatch), so the ONLY thing
// that can flip it to 'blocked' here is the compliance gate.
const targeting = (clientId: string, entityId: string, targetState: Record<string, unknown>, evidence?: unknown) => ({
  clientId, actionType: "change_targeting" as const, entityType: "campaign", entityId,
  targetState, evidence, idempotencyKey: `ct-${clientId}-${entityId}`,
});

describe("compliance gate wired into proposeAction (pglite)", () => {
  it("BLOCKs a non-compliant targeting proposal, audits the version, never dispatches", async () => {
    const row = await proposeAction(targeting(A, "bad-targeting", { interests: ["weight loss"] }));
    expect(row!.status).toBe("blocked");
    expect(row!.complianceStatus).toBe("block");
    expect(Array.isArray(row!.complianceFindings)).toBe(true);

    const audits = await listAudit(A);
    const ev = audits.find((e) => e.eventType === "action.compliance_evaluated" && e.subjectId === row!.id);
    expect(ev).toBeTruthy();
    expect((ev!.after as { version: number }).version).toBe(COMPLIANCE_VERSION);

    // Never dispatched: a dispatch would have driven it through executing → succeeded/uncertain.
    const [after] = await h.db.select().from(adActions).where(eq(adActions.id, row!.id));
    expect(after.status).toBe("blocked");
  });

  it("BLOCKs a personal before-after creative surfaced via evidence rationale", async () => {
    const row = await proposeAction(
      targeting(A, "bad-creative", {}, { rationale: "Show your body before & after our program." }),
    );
    expect(row!.status).toBe("blocked");
    expect(row!.complianceStatus).toBe("block");
  });

  it("a compliant proposal behaves exactly as pre-M5 (pending_approval, compliance pass)", async () => {
    const row = await proposeAction(targeting(A, "ok", { interests: ["skincare", "beauty"] }));
    expect(row!.status).toBe("pending_approval");
    expect(row!.complianceStatus).toBe("pass");
  });

  it("a BLOCK for client A never creates or affects client B rows", async () => {
    await proposeAction(targeting(A, "iso", { interests: ["diabetes"] }));
    const bRows = await h.db.select().from(adActions).where(eq(adActions.clientId, B));
    expect(bRows).toHaveLength(0);
    const bBlocked = await h.db.select().from(adActions)
      .where(and(eq(adActions.clientId, B), eq(adActions.complianceStatus, "block")));
    expect(bBlocked).toHaveLength(0);
  });
});
