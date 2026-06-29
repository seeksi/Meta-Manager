// M1/G4 — 2-client isolation, against REAL automation/control code paths backed by an in-memory
// Postgres (pglite). Proves client B's kill / spend-cap / proposals never bleed into client A.
// ponytail: in-memory pglite (devDependency) over the drizzle pglite driver; if multi-instance
// behavior ever needs testing, point TEST_DATABASE_URL at a real Postgres instead.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Hoisted so the env gate + db holder exist before the modules-under-test are imported.
const h = vi.hoisted(() => {
  process.env.WRITE_MODE = "all"; // agency env master gate open → per-client control governs
  return { db: null as unknown as ReturnType<typeof drizzle>, client: null as unknown as PGlite };
});

// getDb() returns the in-memory drizzle instance; schema comes from the real module.
vi.mock("@/db", async () => {
  const real = await vi.importActual<typeof import("@/db/schema")>("@/db/schema");
  return { getDb: () => h.db, schema: real.schema };
});

// Stub the external Meta client so nothing hits the network (the executor stays inert; these
// tests assert guardrail decisions + list scoping, not Meta writes).
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
import {
  ensureControl, setControl, getControl, engageKill, engageAgencyKill,
  ensureAgencyControl, setAgencyControl,
  previewAction, proposeAction, listQueue, listUnresolved, listAudit,
} from "@/lib/automation";
import { listProposals } from "@/lib/optimizer";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

beforeAll(async () => {
  h.client = new PGlite();
  h.db = drizzle(h.client);
  // Build the schema by running the real migrations (incl. 0007 client scoping) in order.
  const dir = join(process.cwd(), "drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await h.client.exec(readFileSync(join(dir, f), "utf8"));
  }
  await h.db.insert(clients).values([
    { id: A, name: "Client A", metaAccountId: "act_A" },
    { id: B, name: "Client B", metaAccountId: "act_B" },
  ]);
  await ensureControl(A);
  await ensureControl(B);
  expect((await ensureAgencyControl()).emergencyStop).toBe(false);
  // Fresh metrics for both accounts (so spend-increasing actions aren't STALE_METRICS-blocked).
  await h.db.insert(metricFetches).values([
    { source: "test", request: { accountId: "act_A" } },
    { source: "test", request: { accountId: "act_B" } },
  ]);
});

const pause = (clientId: string) => ({
  clientId, actionType: "pause_campaign" as const, entityType: "campaign",
  entityId: "c1", targetState: { status: "PAUSED" },
});

describe("M1 client isolation (2 clients, real DB-backed paths)", () => {
  it("kill isolation: B's kill doesn't block A; agency master kill blocks both and can disarm", async () => {
    await setControl(A, { writeMode: "tier_a", emergencyStop: false });
    await setControl(B, { writeMode: "tier_a", emergencyStop: false });
    await engageKill(B); // per-client kill on B ONLY

    expect((await previewAction(pause(A))).result.decision).toBe("allow");
    const b = await previewAction(pause(B));
    expect(b.result.decision).toBe("block");
    expect(b.result.code).toBe("KILL_SWITCH");

    // Agency master kill → BOTH blocked (effective = agency OR client).
    await engageAgencyKill();
    expect((await previewAction(pause(A))).result.code).toBe("KILL_SWITCH");
    expect((await previewAction(pause(B))).result.code).toBe("KILL_SWITCH");

    await setAgencyControl({ emergencyStop: false });
    expect((await previewAction(pause(A))).result.decision).toBe("allow");
    expect((await previewAction(pause(B))).result.code).toBe("KILL_SWITCH");
  });

  it("spend-cap isolation: B's low account cap blocks B while A (higher cap) is allowed", async () => {
    await setControl(A, { writeMode: "all", emergencyStop: false,
      maxAccountDailySpendCents: 100_000_00, maxActionBudgetDeltaCents: 100_000_00, maxActionBudgetDeltaPct: 1000 });
    await setControl(B, { writeMode: "all", emergencyStop: false,
      maxAccountDailySpendCents: 1000, maxActionBudgetDeltaCents: 100_000_00, maxActionBudgetDeltaPct: 1000 });

    const setBudget = (clientId: string) => ({
      clientId, actionType: "set_budget" as const, entityType: "campaign", entityId: "c1",
      targetState: { daily_budget: 5000 },
      dailyBudgetDeltaCents: 4000, dailyBudgetDeltaPct: 50, projectedDailySpendCents: 50_000,
    });
    expect((await previewAction(setBudget(A))).result.decision).toBe("allow");
    const b = await previewAction(setBudget(B));
    expect(b.result.decision).toBe("block");
    expect(b.result.code).toBe("ACCOUNT_CAP");
  });

  it("control isolation: setControl(A) never mutates B's control row", async () => {
    await setControl(B, { writeMode: "observe" });
    await setControl(A, { writeMode: "all" });
    expect((await getControl(A))!.writeMode).toBe("all");
    expect((await getControl(B))!.writeMode).toBe("observe");
  });

  it("proposal / queue / unresolved / audit lists are client-scoped", async () => {
    await setControl(A, { writeMode: "all", emergencyStop: false });
    await setControl(B, { writeMode: "all", emergencyStop: false });

    // Tier B → pending_approval (persisted, no dispatch/Meta write).
    const tb = (clientId: string, entityId: string) => ({
      clientId, actionType: "change_targeting" as const, entityType: "campaign", entityId,
      targetState: {}, projectedDailySpendCents: 0, idempotencyKey: `tb-${clientId}-${entityId}`,
    });
    const pa = await proposeAction(tb(A, "ca"));
    const pb = await proposeAction(tb(B, "cb"));
    expect(pa!.status).toBe("pending_approval");
    expect(pb!.status).toBe("pending_approval");

    const qA = await listQueue(A);
    expect(qA.every((r) => r.clientId === A)).toBe(true);
    expect(qA.some((r) => r.id === pa!.id)).toBe(true);
    expect(qA.some((r) => r.id === pb!.id)).toBe(false);

    expect((await listProposals(A)).every((r) => r.clientId === A)).toBe(true);

    // Unresolved isolation: inject an uncertain write for B only.
    await h.db.insert(adActions).values({
      clientId: B, tier: "A", status: "uncertain", actionType: "pause_campaign",
      entityType: "campaign", entityId: "cu", targetState: {}, policyVersion: 1,
      idempotencyKey: "unc-B", expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(await listUnresolved(A)).toHaveLength(0);
    const unB = await listUnresolved(B);
    expect(unB.length).toBeGreaterThan(0);
    expect(unB.every((r) => r.clientId === B)).toBe(true);

    // Audit isolation: per-client filtered; agency-wide (no clientId) sees both.
    expect((await listAudit(A)).every((r) => r.clientId === A)).toBe(true);
    const all = await listAudit();
    expect(all.some((r) => r.clientId === A) && all.some((r) => r.clientId === B)).toBe(true);
  });
});
