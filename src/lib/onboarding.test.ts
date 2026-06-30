import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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

vi.mock("@/lib/meta/client", () => {
  class MetaApiError extends Error {
    constructor(public code: number, public subcode: number | undefined, message: string) {
      super(message);
      this.name = "MetaApiError";
    }
  }
  return {
    MetaApiError,
    verifyAccess: vi.fn(),
    verifyNode: vi.fn(async () => ({ id: "node_1" })),
    applyAbsolutePatch: vi.fn(async () => ({ ok: true, metaResponse: {} })),
    getDailyBudgetCents: vi.fn(async () => 10_000),
    fetchEnabledBudgets: vi.fn(async () => ({ daily: {}, hasLifetime: false })),
    getBudgetInfo: vi.fn(async () => ({ isBudgetNode: false, dailyCents: null, lifetimeCents: null })),
    fetchChildAdsetBudgets: vi.fn(async () => ({ dailyCents: 0, hasLifetime: false })),
    findByLaunchToken: vi.fn(async () => []),
    createAdCreative: vi.fn(async () => "cr_1"),
    createAdObject: vi.fn(async () => "ad_1"),
  };
});

import { auditEvents, clients } from "@/db/schema";
import { getControl } from "@/lib/automation";
import { activeClientContext, ClientNotVerifiedError, getClient, listActiveClients } from "@/lib/clients";
import { MetaApiError, verifyAccess, verifyNode } from "@/lib/meta/client";
import { createClient, verifyClient } from "@/lib/onboarding";

beforeAll(async () => {
  h.client = new PGlite();
  h.db = drizzle(h.client);
  const dir = join(process.cwd(), "drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await h.client.exec(readFileSync(join(dir, f), "utf8"));
  }
});

beforeEach(() => {
  vi.mocked(verifyAccess).mockReset();
  vi.mocked(verifyNode).mockReset();
  vi.mocked(verifyNode).mockResolvedValue({ id: "node_1" });
});

describe("G2 client onboarding verify gate", () => {
  it("success activates", async () => {
    vi.mocked(verifyAccess).mockResolvedValue({ id: "act_X", name: "Acme" });

    const client = await createClient({ name: "Acme", metaAccountId: "act_X" });
    expect(client.verifyState).toBe("draft");
    expect((await listActiveClients()).some((c) => c.id === client.id)).toBe(false);

    const result = await verifyClient(client.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.client.verifyState).toBe("active");
      expect(result.account.name).toBe("Acme");
    }
    expect((await listActiveClients()).some((c) => c.id === client.id)).toBe(true);

    const rows = await h.db.select().from(auditEvents).where(eq(auditEvents.clientId, client.id));
    expect(rows.some((r) => r.eventType === "client.verified")).toBe(true);
  });

  it("failure does NOT activate", async () => {
    vi.mocked(verifyAccess).mockRejectedValue(new MetaApiError(190, undefined, "Invalid OAuth access token"));

    const client = await createClient({ name: "Bad Token", metaAccountId: "act_bad" });
    const result = await verifyClient(client.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Invalid OAuth access token");
    expect((await getClient(client.id))!.verifyState).toBe("failed");
    expect((await listActiveClients()).some((c) => c.id === client.id)).toBe(false);
  });

  it("lands in observe + kill", async () => {
    const client = await createClient({ name: "Controlled", metaAccountId: "act_controlled" });
    const control = await getControl(client.id);

    expect(control!.writeMode).toBe("observe");
    expect(control!.emergencyStop).toBe(true);
  });

  it("activeClientContext enforces verified-active clients", async () => {
    const agencyTokenEnv = ["META", "SYSTEM", "USER", "TOKEN"].join("_");
    const previous = process.env[agencyTokenEnv];
    process.env[agencyTokenEnv] = "test-token";

    try {
      const draft = await createClient({ name: "Draft", metaAccountId: "act_draft" });
      await expect(activeClientContext(draft.id)).rejects.toThrow(ClientNotVerifiedError);

      vi.mocked(verifyAccess).mockRejectedValueOnce(new MetaApiError(190, undefined, "Invalid OAuth access token"));
      const failed = await createClient({ name: "Failed", metaAccountId: "act_failed" });
      await expect(verifyClient(failed.id)).resolves.toMatchObject({ ok: false });
      await expect(activeClientContext(failed.id)).rejects.toThrow(ClientNotVerifiedError);

      vi.mocked(verifyAccess).mockResolvedValueOnce({ id: "act_verified", name: "Verified" });
      const verified = await createClient({ name: "Verified", metaAccountId: "act_verified" });
      await expect(verifyClient(verified.id)).resolves.toMatchObject({ ok: true });
      await expect(activeClientContext(verified.id)).resolves.toMatchObject({
        clientId: verified.id,
        accountId: "act_verified",
        token: "test-token",
      });
    } finally {
      if (previous === undefined) delete process.env[agencyTokenEnv];
      else process.env[agencyTokenEnv] = previous;
    }
  });

  it("redacts the agency token from client roster responses and audit rows", async () => {
    const agencyTokenEnv = ["META", "SYSTEM", "USER", "TOKEN"].join("_");
    const sentinel = "SENTINEL_AGENCY_TOKEN";
    const previous = process.env[agencyTokenEnv];
    process.env[agencyTokenEnv] = sentinel;

    try {
      vi.mocked(verifyAccess).mockImplementation(async (ctx) => {
        expect(ctx.token).toBe(sentinel);
        return { id: "act_secret", name: "Secret Hygiene", currency: "USD" };
      });

      const client = await createClient({ name: "Secret Hygiene", metaAccountId: "act_secret" });
      const result = await verifyClient(client.id);
      expect(result.ok).toBe(true);

      const { GET } = await import("@/app/api/clients/route");
      const res = await GET();
      const text = await res.text();
      expect(text).not.toContain(sentinel);

      const payload = JSON.parse(text) as { clients: Array<Record<string, unknown>> };
      expect(payload.clients.length).toBeGreaterThan(0);
      for (const row of payload.clients) {
        expect(Object.prototype.hasOwnProperty.call(row, "token")).toBe(false);
      }

      const rows = await h.db.select().from(auditEvents).where(eq(auditEvents.clientId, client.id));
      expect(rows.some((r) => r.eventType === "client.verified")).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(sentinel);
    } finally {
      if (previous === undefined) delete process.env[agencyTokenEnv];
      else process.env[agencyTokenEnv] = previous;
    }
  });

  it("rejects crafted Meta IDs at POST /api/clients without creating clients", async () => {
    const { POST } = await import("@/app/api/clients/route");
    const before = (await h.db.select({ id: clients.id }).from(clients)).length;
    const base = {
      name: "Boundary Test",
      metaAccountId: "act_12345",
      pageId: "12345",
      pixelId: "12345",
    };

    const badAccount = await POST(new Request("http://localhost/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, metaAccountId: "123/insights?x=1" }),
    }));
    expect(badAccount.status).toBe(400);

    const badPixel = await POST(new Request("http://localhost/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, pixelId: "../foo" }),
    }));
    expect(badPixel.status).toBe(400);

    expect((await h.db.select({ id: clients.id }).from(clients)).length).toBe(before);
  });
});
