import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => {
  process.env.WRITE_MODE = "all";
  return { db: null as unknown as ReturnType<typeof drizzle>, client: null as unknown as PGlite };
});

vi.mock("@/db", async () => {
  const real = await vi.importActual<typeof import("@/db/schema")>("@/db/schema");
  return { getDb: () => h.db, schema: real.schema };
});

vi.mock("@/lib/meta/client", () => ({
  fetchInsights: vi.fn(async () => []),
}));

vi.mock("@/lib/optimizer", () => ({
  runOptimization: vi.fn(async (clientId: string) => ({ clientId, proposed: 0 })),
}));

import { adActions, auditEvents, clients, metricFetches, schedulerRuns } from "@/db/schema";
import { runOptimization } from "@/lib/optimizer";
import { dueForOptimize, maybeRunOptimize, schedulerTick } from "@/lib/scheduler";

const A = "11111111-1111-1111-1111-111111111111";

beforeAll(async () => {
  h.client = new PGlite();
  h.db = drizzle(h.client);
  const dir = join(process.cwd(), "drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await h.client.exec(readFileSync(join(dir, f), "utf8"));
  }
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 5, 29, 11, 0, 0));
  vi.mocked(runOptimization).mockClear();

  await h.db.delete(auditEvents);
  await h.db.delete(adActions);
  await h.db.delete(metricFetches);
  await h.db.delete(schedulerRuns);
  await h.db.delete(clients);
  await h.db.insert(clients).values({
    id: A,
    name: "Client A",
    metaAccountId: "act_A",
    verifyState: "active",
    status: "active",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dueForOptimize", () => {
  it("is due after today's window when there is no prior success", () => {
    expect(dueForOptimize(null, new Date(2026, 5, 29, 11, 0, 0), 9)).toBe(true);
  });

  it("is not due after a successful run later than today's window", () => {
    expect(dueForOptimize(
      new Date(2026, 5, 29, 9, 5, 0),
      new Date(2026, 5, 29, 14, 0, 0),
      9,
    )).toBe(false);
  });

  it("is not due before today's window opens", () => {
    expect(dueForOptimize(
      new Date(2026, 5, 28, 9, 5, 0),
      new Date(2026, 5, 29, 7, 0, 0),
      9,
    )).toBe(false);
  });

  it("is due exactly when today's window opens if the last success was yesterday", () => {
    expect(dueForOptimize(
      new Date(2026, 5, 28, 9, 5, 0),
      new Date(2026, 5, 29, 9, 0, 0),
      9,
    )).toBe(true);
  });

  it("is not due late today when today's run already succeeded", () => {
    expect(dueForOptimize(
      new Date(2026, 5, 29, 9, 0, 0),
      new Date(2026, 5, 29, 23, 0, 0),
      9,
    )).toBe(false);
  });
});

describe("durable scheduler behavior", () => {
  it("catches up a missed optimize once, then skips another run the same day", async () => {
    await maybeRunOptimize();

    expect(runOptimization).toHaveBeenCalledTimes(1);
    const firstRows = await h.db.select().from(schedulerRuns).where(eq(schedulerRuns.job, "optimize"));
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0].ok).toBe(true);
    expect(firstRows[0].finishedAt).toBeInstanceOf(Date);

    await maybeRunOptimize();

    expect(runOptimization).toHaveBeenCalledTimes(1);
    const rows = await h.db.select().from(schedulerRuns).where(eq(schedulerRuns.job, "optimize"));
    expect(rows).toHaveLength(1);
  });

  it("runs orphaned-write recovery on scheduler ticks", async () => {
    await h.db.insert(adActions).values({
      clientId: A,
      tier: "A",
      status: "executing",
      actionType: "pause_campaign",
      entityType: "campaign",
      entityId: "c1",
      targetState: {},
      policyVersion: 1,
      idempotencyKey: "executing-A",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    await schedulerTick();

    const [row] = await h.db.select().from(adActions).where(eq(adActions.idempotencyKey, "executing-A"));
    expect(row.status).toBe("uncertain");
  });
});
