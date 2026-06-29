// Client registry + per-call credential context. After M1 this is the ONLY place env Meta
// credentials are read; per-client lib/route threading lands in G2/G3.
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { clients } from "@/db/schema";

export { clients };
export type Client = typeof clients.$inferSelect;

// Fixed id for the account that existed before M1; migration 0007 backfills every existing
// operational row to this client. SQL can't read env, so 0007 seeds placeholder creds and
// ensureBootstrapClient() upserts the real META_* values from env at app boot.
export const BOOTSTRAP_CLIENT_ID = "00000000-0000-0000-0000-000000000001";

// Pinned Marketing API version. Sourced here because clients.ts is the sole env boundary after
// M1 (so meta/client.ts reads no process.env.META_*). meta/client.ts re-exports this.
export const META_API_VERSION = process.env.META_API_VERSION ?? "v23.0";

// Credential context passed down to the Meta client (G2). token is agency-wide for now.
export type ClientContext = {
  clientId: string;
  accountId: string;
  pageId: string | null;
  pixelId: string | null;
  token: string;
};

// Idempotent: writes the real env account/page/pixel onto the bootstrap client row created by
// migration 0007. Call once at app boot. ponytail: invoked from boot wiring in G2/G3.
export async function ensureBootstrapClient(): Promise<void> {
  const accountId = process.env.META_AD_ACCOUNT_ID;
  if (!accountId) return; // nothing to seed yet
  await getDb()
    .update(clients)
    .set({
      metaAccountId: accountId,
      pageId: process.env.META_PAGE_ID ?? null,
      pixelId: process.env.META_PIXEL_ID ?? null,
    })
    .where(eq(clients.id, BOOTSTRAP_CLIENT_ID));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidClientIdError extends Error {
  constructor() {
    super("invalid clientId");
    this.name = "InvalidClientIdError";
  }
}

export function isInvalidClientIdError(e: unknown): e is InvalidClientIdError {
  return e instanceof InvalidClientIdError;
}

export function validateClientId(clientId: string): string {
  if (!UUID_RE.test(clientId)) throw new InvalidClientIdError();
  return clientId;
}

export function optionalClientIdFromSearchParams(searchParams: URLSearchParams): string | undefined {
  const raw = searchParams.get("clientId");
  return raw === null ? undefined : validateClientId(raw);
}

/** Active client for a request: `?clientId=` (or `x-client-id` header), validated as a uuid,
 *  defaulting to the bootstrap client for back-compat with the single existing account.
 *  ponytail: single-operator default; per-operator client ownership/auth is WS-3. */
export function resolveClientId(req: Request): string {
  const fromQuery = new URL(req.url).searchParams.get("clientId");
  if (fromQuery !== null) return validateClientId(fromQuery);
  const fromHeader = req.headers.get("x-client-id");
  if (fromHeader !== null) return validateClientId(fromHeader);
  return BOOTSTRAP_CLIENT_ID;
}

export async function getClient(id: string): Promise<Client | undefined> {
  const rows = await getDb().select().from(clients).where(eq(clients.id, id)).limit(1);
  return rows[0];
}

export async function listActiveClients(): Promise<Client[]> {
  return getDb().select().from(clients).where(eq(clients.status, "active"));
}

export async function clientContext(id: string): Promise<ClientContext> {
  const c = await getClient(id);
  if (!c) throw new Error(`unknown client: ${id}`);
  // ponytail: token from env until WS-2 encrypted per-client store
  const token = process.env.META_SYSTEM_USER_TOKEN ?? "";
  return {
    clientId: c.id,
    accountId: c.metaAccountId,
    pageId: c.pageId,
    pixelId: c.pixelId,
    token,
  };
}
