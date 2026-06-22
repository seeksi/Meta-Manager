// Meta Marketing API client. Owned by meta-api-integrator. docs/ARCHITECTURE.md §3.
// Shapes verified against developers.facebook.com/docs/marketing-api (Graph API v23+).
// Invariants:
//   - Only the executor calls applyAbsolutePatch (writes).
//   - Writes are ABSOLUTE targets (status, daily_budget in minor units) — safe to retry.
//   - Rate-limit (code 4 / subcodes) and transient errors retry with backoff; others throw.
//   - On post-write timeout the caller marks the action `uncertain` and reconciles.

import { createHash } from "node:crypto";

export const META_API_VERSION = process.env.META_API_VERSION ?? "v23.0";
const BASE = `https://graph.facebook.com/${META_API_VERSION}`;

function token(): string {
  const t = process.env.META_SYSTEM_USER_TOKEN;
  if (!t) throw new Error("META_SYSTEM_USER_TOKEN not set — Meta app pending approval (see .env.example)");
  return t;
}

export class MetaApiError extends Error {
  constructor(public code: number, public subcode: number | undefined, message: string) {
    super(message);
    this.name = "MetaApiError";
  }
}

// Transient / throttling codes worth retrying. (4/1504022/1504039 = insights rate limit.)
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 613]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function graph<T>(
  path: string,
  params: Record<string, string | number> = {},
  method: "GET" | "POST" = "GET",
): Promise<T> {
  const search = new URLSearchParams({ access_token: token() });
  for (const [k, v] of Object.entries(params)) search.set(k, String(v));

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    if (method === "GET") {
      res = await fetch(`${BASE}/${path}?${search.toString()}`, { method });
    } else {
      res = await fetch(`${BASE}/${path}`, { method, body: search });
    }
    const json = (await res.json()) as { error?: { code: number; error_subcode?: number; message: string } } & T;

    if (json.error) {
      const { code, error_subcode, message } = json.error;
      const retryable = RETRYABLE_CODES.has(code) || error_subcode === 1504022 || error_subcode === 1504039
        || res.status === 429 || res.status >= 500;
      if (retryable && attempt < 5) {
        await sleep(Math.min(2 ** attempt * 250, 8000)); // exp backoff, capped 8s
        continue;
      }
      throw new MetaApiError(code, error_subcode, message);
    }
    return json;
  }
}

// ── Insights (read) ──────────────────────────────────────────────────────────
export interface InsightRow {
  entityType: "account" | "campaign" | "adset" | "ad";
  entityId: string;
  dateStart: string;
  dateStop: string;
  impressions: number;
  reach: number;
  spendCents: number;
  clicks: number;
  purchases: number;
  revenueCents: number;
}

const PURCHASE_TYPES = new Set(["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"]);
const DATE_PRESETS = new Set(["today", "yesterday", "last_3d", "last_7d", "last_14d", "last_28d", "last_30d", "this_month", "last_month"]);

function sumActions(items: { action_type: string; value: string }[] | undefined): number {
  if (!Array.isArray(items)) return 0;
  return items.filter((a) => PURCHASE_TYPES.has(a.action_type)).reduce((s, a) => s + Number(a.value || 0), 0);
}

interface RawInsight {
  date_start: string; date_stop: string;
  impressions?: string; reach?: string; clicks?: string; spend?: string;
  campaign_id?: string; adset_id?: string; ad_id?: string;
  actions?: { action_type: string; value: string }[];
  action_values?: { action_type: string; value: string }[];
}

export async function fetchInsights(params: {
  accountId: string;
  level: "account" | "campaign" | "adset" | "ad";
  since: string; // YYYY-MM-DD or a date_preset keyword (today, yesterday, last_7d, …)
  until: string;
}): Promise<InsightRow[]> {
  const acct = acctPath(params.accountId);
  const query: Record<string, string | number> = {
    level: params.level,
    fields: "impressions,reach,clicks,spend,actions,action_values",
    time_increment: 1,
    limit: 500,
  };
  if (DATE_PRESETS.has(params.since)) query.date_preset = params.since;
  else query.time_range = JSON.stringify({ since: params.since, until: params.until });

  const idKey = params.level === "account" ? null : (`${params.level}_id` as const);
  const out: InsightRow[] = [];
  const basePath = `${acct}/insights`;
  let after: string | undefined;
  let pages = 0;

  do {
    const page: { data: RawInsight[]; paging?: { next?: string; cursors?: { after?: string } } } =
      await graph(basePath, after ? { ...query, after } : query);
    for (const r of page.data) {
      out.push({
        entityType: params.level,
        entityId: idKey ? (r[idKey] ?? acct) : acct,
        dateStart: r.date_start,
        dateStop: r.date_stop,
        impressions: Number(r.impressions ?? 0),
        reach: Number(r.reach ?? 0),
        spendCents: Math.round(Number(r.spend ?? 0) * 100),
        clicks: Number(r.clicks ?? 0),
        purchases: Math.round(sumActions(r.actions)),
        revenueCents: Math.round(sumActions(r.action_values) * 100),
      });
    }
    // Next page: keep the SAME endpoint, advance only the `after` cursor.
    after = page.paging?.next ? page.paging?.cursors?.after : undefined;
    pages++;
  } while (after && pages < 20);
  return out;
}

/** Normalize an ad-account id to the act_<id> form the Graph API expects. */
export function acctPath(accountId = process.env.META_AD_ACCOUNT_ID ?? ""): string {
  return accountId.startsWith("act_") ? accountId : `act_${accountId}`;
}

export interface AccountInfo { id: string; name?: string; accountStatus?: number; currency?: string }

/** Live connectivity check: read the configured ad account. Throws MetaApiError on failure. */
export async function verifyAccess(): Promise<AccountInfo> {
  const obj = await graph<{ id: string; name?: string; account_status?: number; currency?: string }>(
    acctPath(), { fields: "name,account_status,currency" },
  );
  return { id: obj.id, name: obj.name, accountStatus: obj.account_status, currency: obj.currency };
}

// ── Writes (executor only) ─────────────────────────────────────────────────────
export interface AbsolutePatch {
  entityType: "campaign" | "adset" | "ad";
  entityId: string;
  fields: Record<string, string | number | boolean>; // absolute target state (status, daily_budget…)
}

export interface ApplyResult { ok: boolean; metaResponse: unknown }

/** Read an object's current daily budget (minor units / cents), or null if unset. */
export async function getDailyBudgetCents(entityId: string): Promise<number | null> {
  const obj = await graph<{ daily_budget?: string }>(entityId, { fields: "daily_budget" });
  return obj.daily_budget ? Number(obj.daily_budget) : null;
}

export async function applyAbsolutePatch(patch: AbsolutePatch): Promise<ApplyResult> {
  // POST to /{object_id} with the absolute fields. daily_budget is in minor units (cents).
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(patch.fields)) params[k] = typeof v === "boolean" ? String(v) : v;
  const metaResponse = await graph<{ success?: boolean; id?: string }>(patch.entityId, params, "POST");
  return { ok: true, metaResponse };
}

// ── Launch (create) — NOT naturally idempotent, so callers embed a launch token in the object
// name and reconcile-before-create via findByLaunchToken. New objects are created PAUSED.

const LAUNCH_LIST_LIMIT = 200;

/** Find existing creatives/ads whose name carries `[launch:<token>]`. Used to adopt objects a
 *  crashed retry already created (dedup). >1 match = ambiguous → caller must fail closed. */
export async function findByLaunchToken(
  accountId: string, edge: "adcreatives" | "ads", token: string,
): Promise<string[]> {
  const res = await graph<{ data: { id: string; name?: string }[] }>(
    `${acctPath(accountId)}/${edge}`, { fields: "id,name", limit: LAUNCH_LIST_LIMIT },
  );
  const tag = `[launch:${token}]`;
  return res.data.filter((o) => (o.name ?? "").includes(tag)).map((o) => o.id);
}

export interface CreativeSpec {
  name: string; pageId: string; imageUrl: string; link: string;
  message?: string; headline?: string; description?: string; cta?: string;
}

/** Create an AdCreative (link ad) via object_story_spec. Returns the creative id. */
export async function createAdCreative(accountId: string, spec: CreativeSpec): Promise<string> {
  const linkData: Record<string, unknown> = { link: spec.link };
  if (spec.message) linkData.message = spec.message;
  if (spec.headline) linkData.name = spec.headline;
  if (spec.description) linkData.description = spec.description;
  if (spec.imageUrl) linkData.picture = spec.imageUrl;
  if (spec.cta) linkData.call_to_action = { type: spec.cta.toUpperCase().replace(/\s+/g, "_"), value: { link: spec.link } };

  const res = await graph<{ id: string }>(`${acctPath(accountId)}/adcreatives`, {
    name: spec.name,
    object_story_spec: JSON.stringify({ page_id: spec.pageId, link_data: linkData }),
  }, "POST");
  return res.id;
}

/** Create an Ad under an existing adset, always PAUSED. Returns the ad id. */
export async function createAdObject(
  accountId: string, spec: { name: string; adsetId: string; creativeId: string },
): Promise<string> {
  const res = await graph<{ id: string }>(`${acctPath(accountId)}/ads`, {
    name: spec.name, adset_id: spec.adsetId,
    creative: JSON.stringify({ creative_id: spec.creativeId }), status: "PAUSED",
  }, "POST");
  return res.id;
}

// ── Ad Library (competitor research, read) ─────────────────────────────────────
interface RawAdLibrary {
  id: string; page_name?: string; ad_creative_bodies?: string[];
  ad_delivery_start_time?: string; ad_snapshot_url?: string;
}
export interface AdLibraryItem {
  advertiser: string; adArchiveId: string; body?: string; mediaUrl?: string;
  startedRunning?: string; raw: unknown;
}

/** Search the public Ad Library (`/ads_archive`). Note: coverage varies by region — many
 *  countries expose only political/issue ads via API; commercial-ad coverage is best in the EU. */
export async function fetchAdLibrary(params: {
  searchTerms: string; countries?: string[]; limit?: number;
}): Promise<AdLibraryItem[]> {
  const res = await graph<{ data: RawAdLibrary[] }>("ads_archive", {
    search_terms: params.searchTerms,
    ad_reached_countries: JSON.stringify(params.countries ?? ["US"]),
    ad_type: "ALL",
    fields: "id,page_name,ad_creative_bodies,ad_delivery_start_time,ad_snapshot_url",
    limit: params.limit ?? 25,
  });
  return res.data.map((d) => ({
    advertiser: d.page_name ?? "unknown",
    adArchiveId: String(d.id),
    body: Array.isArray(d.ad_creative_bodies) ? d.ad_creative_bodies[0] : undefined,
    mediaUrl: d.ad_snapshot_url,
    startedRunning: d.ad_delivery_start_time ? String(d.ad_delivery_start_time).slice(0, 10) : undefined,
    raw: d,
  }));
}

// ── Conversions API (server events, write) ─────────────────────────────────────
const sha256 = (s: string) => createHash("sha256").update(s.trim().toLowerCase()).digest("hex");

export interface ConversionEvent {
  eventName: string;   // "Lead", "Purchase", …
  eventId: string;     // dedup key (e.g. the lead id) — matches the browser pixel event
  email?: string; phone?: string;
  value?: number; currency?: string;
  eventTime?: number;  // unix seconds (defaults to now)
}

/** Send a server-side conversion to the Pixel via CAPI. PII is sha256-hashed. */
export async function sendConversion(ev: ConversionEvent): Promise<{ ok: boolean; metaResponse: unknown }> {
  const pixelId = process.env.META_PIXEL_ID;
  if (!pixelId) throw new Error("META_PIXEL_ID not set");
  const user_data: Record<string, string[]> = {};
  if (ev.email) user_data.em = [sha256(ev.email)];
  if (ev.phone) user_data.ph = [sha256(ev.phone)];

  const event: Record<string, unknown> = {
    event_name: ev.eventName,
    event_time: ev.eventTime ?? Math.floor(Date.now() / 1000),
    action_source: "system_generated",
    event_id: ev.eventId,
    user_data,
  };
  if (ev.value != null) event.custom_data = { value: ev.value, currency: ev.currency ?? "USD" };

  const metaResponse = await graph<{ events_received?: number }>(
    `${pixelId}/events`, { data: JSON.stringify([event]) }, "POST",
  );
  return { ok: true, metaResponse };
}
