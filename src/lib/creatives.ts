// Module 4 — Creative library + ad assembly. docs/PRODUCT_SPEC.md §4.
// Uploads go to Vercel Blob with sha256 dedup. Launch routes through proposeAction (Tier B).
import { put } from "@vercel/blob";
import { createHash } from "node:crypto";
import { eq, desc, and } from "drizzle-orm";
import { getDb } from "@/db";
import { creatives, ads } from "@/db/schema";
import { proposeAction } from "./automation";

export async function uploadCreative(clientId: string, file: { name: string; bytes: Buffer; contentType: string }) {
  const type = file.contentType.startsWith("video") ? "video" : "image";
  const hash = createHash("sha256").update(file.bytes).digest("hex");
  const db = getDb();

  // Dedup within the client's library.
  const existing = await db.select().from(creatives)
    .where(and(eq(creatives.clientId, clientId), eq(creatives.hash, hash))).limit(1);
  if (existing[0]) return { creative: existing[0], deduped: true };

  const blob = await put(`creatives/${hash}-${file.name}`, file.bytes, {
    access: "public",
    contentType: file.contentType,
  });
  const [row] = await db.insert(creatives)
    .values({ clientId, blobUrl: blob.url, type, hash }).returning();
  return { creative: row, deduped: false };
}

export async function listCreatives(clientId: string) {
  return getDb().select().from(creatives)
    .where(eq(creatives.clientId, clientId)).orderBy(desc(creatives.createdAt));
}

export interface AdInput {
  creativeId: string;
  copy: { headline?: string; primaryText?: string; description?: string };
  cta?: string;
  destinationUrl?: string;
  campaignId?: string;
  adsetId?: string;
  launch?: boolean;
}

export async function createAd(clientId: string, input: AdInput) {
  const db = getDb();
  const [ad] = await db.insert(ads).values({
    clientId,
    creativeId: input.creativeId,
    copy: input.copy,
    cta: input.cta ?? null,
    destinationUrl: input.destinationUrl ?? null,
    campaignId: input.campaignId ?? null,
    adsetId: input.adsetId ?? null,
    status: "draft",
  }).returning();

  if (!input.launch) return { ad, action: null };

  // launch_ad is Tier B → proposeAction queues it for approval.
  const action = await proposeAction({
    clientId,
    actionType: "launch_ad",
    entityType: "ad",
    entityId: ad.id,
    targetState: {
      creativeId: input.creativeId,
      copy: input.copy,
      cta: input.cta,
      destinationUrl: input.destinationUrl,
    },
    evidence: { source: "ad-builder" },
    actor: "operator",
  });
  await db.update(ads).set({ status: "queued" }).where(eq(ads.id, ad.id));
  return { ad, action };
}
