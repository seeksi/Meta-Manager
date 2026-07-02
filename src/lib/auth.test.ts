import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

import { clients, operators } from "@/db/schema";
import { checkCredentials, sessionCookieOptions, signSession, verifySession } from "@/lib/auth";
import { clientOwnedBy } from "@/lib/clients";

const originalEnv = {
  OPERATOR_USERNAME: process.env.OPERATOR_USERNAME,
  OPERATOR_PASSWORD: process.env.OPERATOR_PASSWORD,
  SESSION_SECRET: process.env.SESSION_SECRET,
};

function setAuthEnv(secret = "test-session-secret-long") {
  process.env.OPERATOR_USERNAME = "operator";
  process.env.OPERATOR_PASSWORD = "correct-password";
  process.env.SESSION_SECRET = secret;
}

afterEach(() => {
  if (originalEnv.OPERATOR_USERNAME === undefined) delete process.env.OPERATOR_USERNAME;
  else process.env.OPERATOR_USERNAME = originalEnv.OPERATOR_USERNAME;
  if (originalEnv.OPERATOR_PASSWORD === undefined) delete process.env.OPERATOR_PASSWORD;
  else process.env.OPERATOR_PASSWORD = originalEnv.OPERATOR_PASSWORD;
  if (originalEnv.SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalEnv.SESSION_SECRET;
});

beforeAll(async () => {
  h.client = new PGlite();
  h.db = drizzle(h.client);
  const dir = join(process.cwd(), "drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await h.client.exec(readFileSync(join(dir, f), "utf8"));
  }
});

describe("operator auth sessions", () => {
  it("round-trips a signed session", async () => {
    setAuthEnv();
    const token = await signSession("op_1");
    await expect(verifySession(token)).resolves.toBe("op_1");
  });

  it("rejects tampered sessions", async () => {
    setAuthEnv();
    const token = await signSession("op_1");
    await expect(verifySession(token.replace("op_1", "op_2"))).resolves.toBeNull();
  });

  it("rejects expired sessions", async () => {
    setAuthEnv();
    const token = await signSession("op_1", -10);
    await expect(verifySession(token)).resolves.toBeNull();
  });

  it("rejects sessions after the secret changes", async () => {
    setAuthEnv("secret-a");
    const token = await signSession("op_1");
    process.env.SESSION_SECRET = "secret-b";
    await expect(verifySession(token)).resolves.toBeNull();
  });

  it("fails closed when the secret is missing", async () => {
    setAuthEnv();
    const token = await signSession("op_1");
    delete process.env.SESSION_SECRET;
    await expect(verifySession(token)).resolves.toBeNull();
  });
});

describe("operator credential checks", () => {
  it("accepts correct credentials", async () => {
    setAuthEnv();
    await expect(checkCredentials("operator", "correct-password")).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    setAuthEnv();
    await expect(checkCredentials("operator", "wrong")).resolves.toBe(false);
  });

  it("fails closed when auth env is missing", async () => {
    delete process.env.OPERATOR_USERNAME;
    delete process.env.OPERATOR_PASSWORD;
    delete process.env.SESSION_SECRET;
    await expect(checkCredentials("operator", "correct-password")).resolves.toBe(false);
  });
});

describe("sessionCookieOptions secure flag (fail-secure)", () => {
  const COOKIE_KEYS = ["HOSTED", "NODE_ENV", "DESKTOP"] as const;
  const savedCookieEnv = Object.fromEntries(COOKIE_KEYS.map((k) => [k, process.env[k]]));
  function setCookieEnv(env: Partial<Record<(typeof COOKIE_KEYS)[number], string | undefined>>) {
    for (const k of COOKIE_KEYS) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  }
  afterEach(() => setCookieEnv(savedCookieEnv));

  it("sets Secure on the hosted HTTPS deploy", () => {
    setCookieEnv({ HOSTED: "1", NODE_ENV: "production", DESKTOP: undefined });
    expect(sessionCookieOptions().secure).toBe(true);
  });

  it("sets Secure on a production HTTPS host even without HOSTED (the regression)", () => {
    setCookieEnv({ HOSTED: undefined, NODE_ENV: "production", DESKTOP: undefined });
    expect(sessionCookieOptions().secure).toBe(true);
  });

  it("does NOT set Secure for the desktop build over http://127.0.0.1", () => {
    setCookieEnv({ HOSTED: undefined, NODE_ENV: "production", DESKTOP: "1" });
    expect(sessionCookieOptions().secure).toBe(false);
  });

  it("does NOT set Secure in local dev over http", () => {
    setCookieEnv({ HOSTED: undefined, NODE_ENV: "development", DESKTOP: undefined });
    expect(sessionCookieOptions().secure).toBe(false);
  });
});

describe("client ownership seam", () => {
  it("detects whether a client belongs to an operator", async () => {
    const owner = "11111111-1111-1111-1111-111111111111";
    const other = "22222222-2222-2222-2222-222222222222";
    const clientId = "33333333-3333-3333-3333-333333333333";
    await h.db.insert(operators).values([
      { id: owner, username: "owner" },
      { id: other, username: "other" },
    ]).onConflictDoNothing();
    await h.db.insert(clients).values({
      id: clientId,
      ownerId: owner,
      name: "Owned Client",
      metaAccountId: "act_owned",
    }).onConflictDoNothing();

    await expect(clientOwnedBy(owner, clientId)).resolves.toBe(true);
    await expect(clientOwnedBy(other, clientId)).resolves.toBe(false);
  });
});
