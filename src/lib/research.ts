// Module 7 — Competitor creative research. docs/PRODUCT_SPEC.md §7.
// Stores creatives from the Meta Ad Library / scraping actors; surfaces long-runners and
// reusable pattern tags. Use for inspiration, not copying.
import { eq, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { competitorCreatives } from "@/db/schema";

export const LONG_RUNNER_DAYS = 30; // ads running this long are likely winners

export interface CompetitorInput {
  advertiser: string;
  adArchiveId?: string;
  body?: string;
  mediaUrl?: string;
  startedRunning?: string; // YYYY-MM-DD
  raw?: unknown;
}

function daysSince(date?: string): number | null {
  if (!date) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000));
}

/**
 * Ingest a batch of competitor creatives. Items come pre-fetched from the Meta Ad Library
 * API or an Apify actor (wired via the meta-creatives-research workflow / Apify MCP).
 * ponytail: actor call is out-of-band; this persists + dedups by adArchiveId.
 */
export async function ingestCompetitors(items: CompetitorInput[]) {
  const db = getDb();
  let added = 0;
  for (const it of items) {
    if (it.adArchiveId) {
      const existing = await db.select().from(competitorCreatives)
        .where(eq(competitorCreatives.adArchiveId, it.adArchiveId)).limit(1);
      if (existing[0]) continue;
    }
    await db.insert(competitorCreatives).values({
      advertiser: it.advertiser,
      adArchiveId: it.adArchiveId ?? null,
      body: it.body ?? null,
      mediaUrl: it.mediaUrl ?? null,
      startedRunning: it.startedRunning ?? null,
      daysRunning: daysSince(it.startedRunning),
      raw: it.raw ?? null,
    });
    added++;
  }
  return { added };
}

export async function listCompetitors() {
  const rows = await getDb().select().from(competitorCreatives)
    .orderBy(desc(competitorCreatives.daysRunning));
  return rows.map((r) => ({ ...r, longRunner: (r.daysRunning ?? 0) >= LONG_RUNNER_DAYS }));
}

export async function tagCreative(id: string, tags: string[]) {
  const [row] = await getDb().update(competitorCreatives)
    .set({ tags }).where(eq(competitorCreatives.id, id)).returning();
  return row;
}
