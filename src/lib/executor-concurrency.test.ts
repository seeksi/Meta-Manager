import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";

const h = vi.hoisted(() => {
  process.env.WRITE_MODE = "all";
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.META_SYSTEM_USER_TOKEN = "test";
  return { testUrl: process.env.TEST_DATABASE_URL, actor: `g3-${Date.now()}-${Math.random().toString(36).slice(2)}` };
});

vi.mock("@/lib/meta/client", () => ({
  applyAbsolutePatch: vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { ok: true, metaResponse: {} };
  }),
  getDailyBudgetCents: vi.fn(async () => 10_000),
  fetchEnabledBudgets: vi.fn(async () => ({ daily: {}, hasLifetime: false })),
  getBudgetInfo: vi.fn(async () => ({ isBudgetNode: false, dailyCents: null, lifetimeCents: null })),
  fetchChildAdsetBudgets: vi.fn(async () => ({ dailyCents: 0, hasLifetime: false })),
  findByLaunchToken: vi.fn(async () => []),
  createAdCreative: vi.fn(async () => "cr_1"),
  createAdObject: vi.fn(async () => "ad_1"),
}));

import { getDb } from "@/db";
import { actionAttempts, adActions, agencyControl, automationControl, auditEvents, clients } from "@/db/schema";
import { ensureAgencyControl, ensureControl, executeAdAction, getAgencyControl, setAgencyControl, setControl } from "@/lib/automation";
import { applyAbsolutePatch } from "@/lib/meta/client";

const describeWithPg = describe.skipIf(!h.testUrl);
const clientId = randomUUID();

let agencySnapshot: typeof agencyControl.$inferSelect | null = null;
let agencyExisted = false;

function poolFor(url: string) {
  const needsSsl = /sslmode=require|neon\.tech/.test(url);
  return new Pool({ connectionString: url, ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}) });
}

async function cleanupClientRows() {
  const db = getDb();
  await db.execute(sql`delete from ${actionAttempts} where ${actionAttempts.actionId} in (select id from ${adActions} where ${adActions.clientId} = ${clientId})`);
  await db.execute(sql`delete from ${auditEvents} where ${auditEvents.clientId} = ${clientId} or ${auditEvents.actor} = ${h.actor} or ${auditEvents.actionId} in (select id from ${adActions} where ${adActions.clientId} = ${clientId})`);
  await db.delete(adActions).where(eq(adActions.clientId, clientId));
  await db.delete(automationControl).where(eq(automationControl.clientId, clientId));
  await db.delete(clients).where(eq(clients.id, clientId));
}

describeWithPg("G3 executor concurrency with real Postgres advisory locks", () => {
  beforeEach(async () => {
    vi.mocked(applyAbsolutePatch).mockClear();
    agencySnapshot = await getAgencyControl();
    agencyExisted = agencySnapshot !== null;
    await cleanupClientRows();
  });

  afterEach(async () => {
    await cleanupClientRows();
    if (agencyExisted && agencySnapshot) {
      await getDb()
        .update(agencyControl)
        .set({ emergencyStop: agencySnapshot.emergencyStop, updatedAt: agencySnapshot.updatedAt })
        .where(eq(agencyControl.id, true));
    } else {
      await getDb().delete(agencyControl).where(eq(agencyControl.id, true));
    }
  });

  afterAll(async () => {
    const pool = (getDb() as unknown as { $client?: Pool }).$client;
    await pool?.end();
  });

  it("executes one Meta write when executeAdAction is called concurrently for one action", async () => {
    const db = getDb();
    await db.insert(clients).values({
      id: clientId,
      name: "G3 Client",
      status: "active",
      verifyState: "active",
      metaAccountId: "act_g3",
    });
    await ensureAgencyControl();
    await setAgencyControl({ emergencyStop: false }, h.actor);
    await ensureControl(clientId);
    const control = await setControl(clientId, { writeMode: "all", emergencyStop: false }, h.actor);

    const [action] = await db.insert(adActions).values({
      clientId,
      tier: "A",
      status: "approved",
      actionType: "pause_campaign",
      entityType: "campaign",
      entityId: "camp_g3",
      targetState: { status: "PAUSED" },
      policyVersion: control.activePolicyVersion,
      idempotencyKey: `g3-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    }).returning({ id: adActions.id });

    await Promise.all([executeAdAction(action.id), executeAdAction(action.id)]);

    expect(applyAbsolutePatch).toHaveBeenCalledTimes(1);
    const [finalAction] = await db.select().from(adActions).where(eq(adActions.id, action.id)).limit(1);
    expect(finalAction.status).toBe("succeeded");
  });

  it("proves two independent connections cannot hold the same client write lock", async () => {
    const poolA = poolFor(h.testUrl!);
    const poolB = poolFor(h.testUrl!);
    const connA = await poolA.connect();
    const connB = await poolB.connect();
    const key = `adwrite:${clientId}`;
    let bLocked = false;

    try {
      await connA.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
      const blocked = await connB.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) as locked", [key]);
      expect(blocked.rows[0].locked).toBe(false);

      await connA.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      const acquired = await connB.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) as locked", [key]);
      bLocked = acquired.rows[0].locked;
      expect(bLocked).toBe(true);
    } finally {
      if (bLocked) await connB.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      connA.release();
      connB.release();
      await poolA.end();
      await poolB.end();
    }
  });
});
