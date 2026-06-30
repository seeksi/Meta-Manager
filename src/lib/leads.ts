// Modules 6+9 — Lead funnel, scoring, conversion & retention. docs/PRODUCT_SPEC.md §6, §9.
import { eq, desc, sql, and, gte } from "drizzle-orm";
import { getDb } from "@/db";
import { leads, metaInsightsDaily } from "@/db/schema";
import { activeClientContext, getClient, isClientNotVerifiedError } from "@/lib/clients";

export const STAGES = ["new", "contacted", "qualified", "converted", "lost"] as const;
export type Stage = (typeof STAGES)[number];

export interface LeadAttributes {
  email?: string;
  phone?: string;
  name?: string;
  [k: string]: unknown;
}

/** Simple, transparent score (0–100). ponytail: heuristic; upgrade to a model later. */
export function scoreLead(attrs: LeadAttributes = {}, source?: string): number {
  let s = 40;
  if (attrs.email) s += 15;
  if (attrs.phone) s += 20;
  if (attrs.name) s += 5;
  if (source && /paid|meta|facebook|instagram/i.test(source)) s += 20;
  return Math.min(s, 100);
}

export interface CaptureInput { source?: string; campaignId?: string; attributes?: LeadAttributes }

export async function captureLead(clientId: string, input: CaptureInput) {
  const db = getDb();
  const attrs = input.attributes ?? {};

  // Light dedup by email WITHIN the client. ponytail: extend to phone/fingerprint later.
  if (attrs.email) {
    const existing = await db.select().from(leads)
      .where(and(eq(leads.clientId, clientId), sql`${leads.attributes}->>'email' = ${attrs.email}`)).limit(1);
    if (existing[0]) {
      const [updated] = await db.update(leads)
        .set({ lastActivityAt: new Date() }).where(eq(leads.id, existing[0].id)).returning();
      return { lead: updated, deduped: true };
    }
  }

  const [row] = await db.insert(leads).values({
    clientId,
    source: input.source ?? null,
    campaignId: input.campaignId ?? (attrs.campaignId as string | undefined) ?? null,
    stage: "new",
    score: scoreLead(attrs, input.source),
    attributes: attrs,
    lastActivityAt: new Date(),
  }).returning();

  // Forward to Meta CAPI for attribution/optimization (event_id = lead id, dedups with the
  // browser pixel). Fire-and-forget: a CAPI hiccup must not fail lead capture.
  // NOTE: CAPI is an attribution event, NOT an ad-entity/budget write — it is intentionally
  // outside the executor + kill-switch guardrails (those gate ad spend), but still requires a
  // verified-active client credential context. sendConversion fails closed when the client has no
  // pixelId, so no env guard is needed here.
  // ponytail: enqueue + retry the event instead of fire-and-forget when this moves off desktop.
  void activeClientContext(row.clientId)
    .then((ctx) => import("@/lib/meta/client")
      .then(({ sendConversion }) => sendConversion(ctx, { eventName: "Lead", eventId: row.id, email: attrs.email, phone: attrs.phone })))
    .catch((e) => {
      if (isClientNotVerifiedError(e)) return;
      console.error("[capi] lead event failed:", e instanceof Error ? e.message : e);
    });
  return { lead: row, deduped: false };
}

export async function listLeads(clientId: string) {
  return getDb().select().from(leads)
    .where(eq(leads.clientId, clientId)).orderBy(desc(leads.capturedAt));
}

export async function setStage(id: string, stage: Stage) {
  const [row] = await getDb().update(leads)
    .set({ stage, lastActivityAt: new Date() }).where(eq(leads.id, id)).returning();
  return row;
}

/** Stub nurture trigger — hands off to an email sequence. */
export async function triggerNurture(id: string) {
  await getDb().update(leads).set({ lastActivityAt: new Date() }).where(eq(leads.id, id));
  // ponytail: enqueue an email-sequence job here (out of scope for MVP).
  return { queued: true, message: "Nurture sequence queued (email-sequence)." };
}

// ── Attribution: cost per lead by campaign ────────────────────────────────────
export interface CplRow { campaignId: string; spendCents: number; leads: number; cplCents: number | null }

/** Pure join of spend-per-campaign and leads-per-campaign → CPL rows (worst-CPL aware). */
export function joinCpl(spendByCampaign: Map<string, number>, leadsByCampaign: Map<string, number>): CplRow[] {
  const ids = new Set([...spendByCampaign.keys(), ...leadsByCampaign.keys()]);
  const rows: CplRow[] = [];
  for (const id of ids) {
    const spendCents = spendByCampaign.get(id) ?? 0;
    const n = leadsByCampaign.get(id) ?? 0;
    rows.push({ campaignId: id, spendCents, leads: n, cplCents: n > 0 ? Math.round(spendCents / n) : null });
  }
  return rows.sort((a, b) => b.spendCents - a.spendCents);
}

export async function cplByCampaign(clientId: string, windowDays = 7): Promise<CplRow[]> {
  const db = getDb();
  const client = await getClient(clientId);
  if (!client) return [];
  const start = new Date(Date.now() - (windowDays - 1) * 86_400_000).toISOString().slice(0, 10);

  const insights = await db.select().from(metaInsightsDaily)
    .where(and(eq(metaInsightsDaily.metaAccountId, client.metaAccountId),
      eq(metaInsightsDaily.entityType, "campaign"), gte(metaInsightsDaily.dateStart, start)));
  const spend = new Map<string, number>();
  for (const r of insights) spend.set(r.entityId, (spend.get(r.entityId) ?? 0) + r.spendCents);

  const leadRows = await db.select().from(leads)
    .where(and(eq(leads.clientId, clientId), gte(leads.capturedAt, new Date(start))));
  const counts = new Map<string, number>();
  for (const l of leadRows) if (l.campaignId) counts.set(l.campaignId, (counts.get(l.campaignId) ?? 0) + 1);

  return joinCpl(spend, counts);
}

export async function funnel(clientId: string) {
  const rows = await getDb()
    .select({ stage: leads.stage, count: sql<number>`count(*)::int` })
    .from(leads).where(eq(leads.clientId, clientId)).groupBy(leads.stage);
  const counts = Object.fromEntries(rows.map((r) => [r.stage, r.count]));
  const total = rows.reduce((a, r) => a + r.count, 0);
  const converted = counts["converted"] ?? 0;
  return {
    total,
    stages: STAGES.map((s) => ({ stage: s, count: counts[s] ?? 0 })),
    conversionRate: total > 0 ? converted / total : 0,
  };
}
