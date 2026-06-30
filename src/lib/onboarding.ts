import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditEvents, clients } from "@/db/schema";
import { ensureControl, setControl } from "@/lib/automation";
import { BOOTSTRAP_OPERATOR_ID, clientContext, getClient, validateClientId, type Client } from "@/lib/clients";
import { verifyAccess, verifyNode, type AccountInfo } from "@/lib/meta/client";

export async function createClient(input: {
  name: string;
  metaAccountId: string;
  pageId?: string | null;
  pixelId?: string | null;
  ownerId?: string;
}): Promise<Client> {
  const [client] = await getDb()
    .insert(clients)
    .values({
      ownerId: input.ownerId ?? BOOTSTRAP_OPERATOR_ID,
      name: input.name,
      metaAccountId: input.metaAccountId,
      pageId: input.pageId ?? null,
      pixelId: input.pixelId ?? null,
    })
    .returning();

  await ensureControl(client.id);
  await setControl(client.id, { writeMode: "observe", emergencyStop: true }, "operator");

  return client;
}

export async function verifyClient(id: string): Promise<
  { ok: true; client: Client; account: AccountInfo } | { ok: false; message: string }
> {
  validateClientId(id);
  const client = await getClient(id);
  if (!client) return { ok: false, message: "unknown client" };

  await setVerifyState(id, "verifying");
  const ctx = await clientContext(id);
  if (!ctx.accountId) {
    await setVerifyState(id, "failed");
    return { ok: false, message: "Ad account not set for this client." };
  }

  try {
    const account = await verifyAccess(ctx);
    if (ctx.pageId) await verifyNode(ctx, ctx.pageId);
    if (ctx.pixelId) await verifyNode(ctx, ctx.pixelId);

    await setVerifyState(id, "active");
    await getDb().insert(auditEvents).values({
      clientId: id,
      actor: "operator",
      eventType: "client.verified",
      subjectId: id,
      after: { accountId: account.id, name: account.name ?? null, currency: account.currency ?? null },
    });
    return { ok: true, client: (await getClient(id))!, account };
  } catch (e) {
    await setVerifyState(id, "failed");
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

async function setVerifyState(id: string, verifyState: "verifying" | "active" | "failed") {
  await getDb().update(clients).set({ verifyState }).where(eq(clients.id, id));
}
