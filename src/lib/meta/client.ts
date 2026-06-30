// Meta Marketing API client. Owned by meta-api-integrator. docs/ARCHITECTURE.md §3.
// Shapes verified against developers.facebook.com/docs/marketing-api (Graph API v23+).
// Invariants:
//   - Only the executor calls applyAbsolutePatch (writes).
//   - Writes are ABSOLUTE targets (status, daily_budget in minor units) — safe to retry.
//   - Rate-limit (code 4 / subcodes) and transient errors retry with backoff; others throw.
//   - On post-write timeout the caller marks the action `uncertain` and reconciles.

import { createHash } from "node:crypto";

// META_API_VERSION's env read lives in clients.ts (the sole env-credential boundary after M1, so
// this file reads NO env META_* vars). Re-exported so existing importers keep working.
import { META_API_VERSION } from "@/lib/clients";
export { META_API_VERSION };
const BASE = `https://graph.facebook.com/${META_API_VERSION}`;

// Per-call credential context threaded into every Graph call. A structural subset of clients.ts's
// ClientContext, so callers can pass a ClientContext directly. `token` is agency-wide for now
// (ponytail: per-client encrypted token store is WS-2). clients.ts may yield token="" before
// WS-2, so graph() fails closed on an empty/missing token before any network call.
export interface MetaCtx {
  token: string;
  accountId: string;
  pageId?: string | null;
  pixelId?: string | null;
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
type Paging = { next?: string; cursors?: { after?: string } } | undefined;

function nextCursor(paging: Paging, edge: string): string | undefined {
  if (!paging?.next) return undefined;
  const after = paging.cursors?.after;
  if (!after) throw new MetaApiError(-2, undefined, `${edge} pagination cursor missing — failing closed`);
  return after;
}

async function graph<T>(
  path: string,
  params: Record<string, string | number> = {},
  method: "GET" | "POST" = "GET",
  // retry=false for NON-idempotent creates (createAdCreative/createAdObject): retrying a create
  // whose success response was lost would duplicate the object. They fail closed instead, and the
  // launch saga reconciles by launch token on the next attempt. GETs and idempotent absolute
  // patches stay retryable.
  retry = true,
  // Caller-supplied credential. Required and must be non-empty — fail closed (below) BEFORE any
  // network call rather than ever hitting Meta with an empty bearer.
  token = "",
): Promise<T> {
  if (!token) throw new Error("Meta agency token not set — app pending approval (see Settings → Setup)");
  // Token goes in the Authorization header, NOT the query string — keeps it out of URLs (and
  // therefore out of any logged/echoed request line or transport-error message).
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) search.set(k, String(v));
  const headers = { Authorization: `Bearer ${token}` };

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = method === "GET"
        ? await fetch(`${BASE}/${path}?${search.toString()}`, { method, headers })
        : await fetch(`${BASE}/${path}`, { method, headers, body: search });
    } catch {
      // Transport failure (DNS/TLS/connection). Retry transient; never leak request details.
      if (retry && attempt < 5) { await sleep(Math.min(2 ** attempt * 250, 8000)); continue; }
      throw new MetaApiError(-1, undefined, `Network error calling Meta (${method} /${path})`);
    }
    let json: ({ error?: { code: number; error_subcode?: number; message: string } } & T) | undefined;
    try {
      json = (await res.json()) as { error?: { code: number; error_subcode?: number; message: string } } & T;
    } catch {
      const retryable = res.status === 429 || res.status >= 500;
      if (retry && retryable && attempt < 5) {
        await sleep(Math.min(2 ** attempt * 250, 8000));
        continue;
      }
      throw new MetaApiError(res.status, undefined, `Non-JSON response from Meta (${method} /${path})`);
    }

    if (json.error) {
      const { code, error_subcode, message } = json.error;
      const retryable = RETRYABLE_CODES.has(code) || error_subcode === 1504022 || error_subcode === 1504039
        || res.status === 429 || res.status >= 500;
      if (retry && retryable && attempt < 5) {
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

export async function fetchInsights(ctx: MetaCtx, params: {
  level: "account" | "campaign" | "adset" | "ad";
  since: string; // YYYY-MM-DD or a date_preset keyword (today, yesterday, last_7d, …)
  until: string;
}): Promise<InsightRow[]> {
  const acct = acctPath(ctx.accountId);
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
      await graph(basePath, after ? { ...query, after } : query, "GET", true, ctx.token);
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
    after = nextCursor(page.paging, "insights");
    pages++;
  } while (after && pages < 20);
  if (after) throw new MetaApiError(-2, undefined, "insights fetch truncated (too many pages)");
  return out;
}

/** Normalize an ad-account id to the act_<id> form the Graph API expects. */
export function acctPath(accountId: string): string {
  return accountId.startsWith("act_") ? accountId : `act_${accountId}`;
}

export interface AccountInfo { id: string; name?: string; accountStatus?: number; currency?: string }

/** Live connectivity check: read the client's ad account. Throws MetaApiError on failure. */
export async function verifyAccess(ctx: MetaCtx): Promise<AccountInfo> {
  const obj = await graph<{ id: string; name?: string; account_status?: number; currency?: string }>(
    acctPath(ctx.accountId), { fields: "name,account_status,currency" }, "GET", true, ctx.token,
  );
  return { id: obj.id, name: obj.name, accountStatus: obj.account_status, currency: obj.currency };
}

/** Presence/read check for a Page or Pixel node by id. Throws MetaApiError if unreadable. */
export async function verifyNode(ctx: MetaCtx, id: string): Promise<{ id: string; name?: string }> {
  return graph<{ id: string; name?: string }>(id, { fields: "id,name" }, "GET", true, ctx.token);
}

// ── Writes (executor only) ─────────────────────────────────────────────────────
export interface AbsolutePatch {
  entityType: "campaign" | "adset" | "ad";
  entityId: string;
  fields: Record<string, string | number | boolean>; // absolute target state (status, daily_budget…)
}

export interface ApplyResult { ok: boolean; metaResponse: unknown }

/** Read an object's current daily budget (minor units / cents), or null if unset. */
export async function getDailyBudgetCents(ctx: MetaCtx, entityId: string): Promise<number | null> {
  const obj = await graph<{ daily_budget?: string }>(entityId, { fields: "daily_budget" }, "GET", true, ctx.token);
  return obj.daily_budget ? Number(obj.daily_budget) : null;
}

export interface BudgetInfo {
  isBudgetNode: boolean;       // false ⇒ the node has no budget fields (e.g. an Ad)
  dailyCents: number | null;
  lifetimeCents: number | null;
}

/** Budget shape of a single object. An Ad has no budget fields → Meta error 100 → isBudgetNode
 *  false (its spend is governed by the parent adset/campaign). Distinguishes daily vs lifetime so
 *  callers can fail closed on lifetime (which has no safe daily equivalent for cap projection). */
export async function getBudgetInfo(ctx: MetaCtx, entityId: string): Promise<BudgetInfo> {
  try {
    const o = await graph<{ daily_budget?: string; lifetime_budget?: string }>(
      entityId, { fields: "daily_budget,lifetime_budget" }, "GET", true, ctx.token,
    );
    return {
      isBudgetNode: true,
      dailyCents: o.daily_budget ? Number(o.daily_budget) : null,
      lifetimeCents: o.lifetime_budget ? Number(o.lifetime_budget) : null,
    };
  } catch (e) {
    if (e instanceof MetaApiError && e.code === 100) return { isBudgetNode: false, dailyCents: null, lifetimeCents: null };
    throw e;
  }
}

// Statuses that cannot spend — their budgets don't count toward account exposure.
const NON_SPENDING_STATUS = new Set(["PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "ARCHIVED", "DELETED"]);

export interface BudgetScan { daily: Record<string, number>; hasLifetime: boolean }

async function scanEdgeBudgets(accountId: string, edge: "campaigns" | "adsets", enabledOnly: boolean, token: string): Promise<BudgetScan> {
  const daily: Record<string, number> = {};
  let hasLifetime = false;
  let after: string | undefined;
  let pages = 0;
  do {
    const q: Record<string, string | number> = { fields: "id,daily_budget,lifetime_budget,effective_status", limit: 200 };
    if (after) q.after = after;
    const res = await graph<{ data: { id: string; daily_budget?: string; lifetime_budget?: string; effective_status?: string }[]; paging?: { next?: string; cursors?: { after?: string } } }>(
      `${acctPath(accountId)}/${edge}`, q, "GET", true, token,
    );
    for (const o of res.data) {
      if (enabledOnly && NON_SPENDING_STATUS.has(o.effective_status ?? "")) continue;
      if (o.lifetime_budget) hasLifetime = true; // lifetime can't be converted to a daily cap figure → flag
      if (o.daily_budget) daily[o.id] = Number(o.daily_budget);
    }
    after = nextCursor(res.paging, `/${edge}`);
    pages++;
  } while (after && pages < 20);
  // A truncated scan would under-project the cap → fail closed, never return a partial total.
  if (after) throw new MetaApiError(-2, undefined, `budget scan truncated on /${edge} (too many entities)`);
  return { daily, hasLifetime };
}

/** Enabled-account budget exposure: daily budgets of every entity that CAN currently spend (CBO
 *  campaigns + ABO adsets, mutually exclusive per branch → no double count), plus a flag if ANY
 *  enabled entity uses a lifetime budget (callers fail closed — lifetime has no safe daily cap
 *  equivalent). Used to enforce the account daily-spend cap as a hard ceiling. */
export async function fetchEnabledBudgets(ctx: MetaCtx): Promise<BudgetScan> {
  const [c, a] = await Promise.all([
    scanEdgeBudgets(ctx.accountId, "campaigns", true, ctx.token),
    scanEdgeBudgets(ctx.accountId, "adsets", true, ctx.token),
  ]);
  return { daily: { ...c.daily, ...a.daily }, hasLifetime: c.hasLifetime || a.hasLifetime };
}

/** Child adsets' budget exposure under a campaign (ALL statuses) — the budget that resumes when a
 *  paused ABO campaign is unpaused. Returns summed daily + a lifetime flag (caller fails closed). */
export async function fetchChildAdsetBudgets(ctx: MetaCtx, campaignId: string): Promise<{ dailyCents: number; hasLifetime: boolean }> {
  let dailyCents = 0;
  let hasLifetime = false;
  let after: string | undefined;
  let pages = 0;
  do {
    const q: Record<string, string | number> = { fields: "daily_budget,lifetime_budget", limit: 200 };
    if (after) q.after = after;
    const res = await graph<{ data: { daily_budget?: string; lifetime_budget?: string }[]; paging?: { next?: string; cursors?: { after?: string } } }>(
      `${campaignId}/adsets`, q, "GET", true, ctx.token,
    );
    for (const a of res.data) {
      if (a.lifetime_budget) hasLifetime = true;
      if (a.daily_budget) dailyCents += Number(a.daily_budget);
    }
    after = nextCursor(res.paging, "child adsets");
    pages++;
  } while (after && pages < 20);
  if (after) throw new MetaApiError(-2, undefined, "child adset budget scan truncated (too many adsets)");
  return { dailyCents, hasLifetime };
}

export async function applyAbsolutePatch(ctx: MetaCtx, patch: AbsolutePatch): Promise<ApplyResult> {
  // POST to /{object_id} with the absolute fields. daily_budget is in minor units (cents).
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(patch.fields)) params[k] = typeof v === "boolean" ? String(v) : v;
  const metaResponse = await graph<{ success?: boolean; id?: string }>(patch.entityId, params, "POST", true, ctx.token);
  return { ok: true, metaResponse };
}

// ── Launch (create) — NOT naturally idempotent, so callers embed a launch token in the object
// name and reconcile-before-create via findByLaunchToken. New objects are created PAUSED.

const LAUNCH_LIST_LIMIT = 200;

/** Find existing creatives/ads whose name carries `[launch:<token>]`. Used to adopt objects a
 *  crashed retry already created (dedup). >1 match = ambiguous → caller must fail closed.
 *  Paginates (up to 20 pages × 200) so a match isn't missed past the first page — a missed match
 *  would mean a duplicate create, the exact failure this reconciliation exists to prevent. */
export async function findByLaunchToken(
  ctx: MetaCtx, edge: "adcreatives" | "ads", launchToken: string,
): Promise<string[]> {
  const tag = `[launch:${launchToken}]`;
  const ids: string[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    const q: Record<string, string | number> = { fields: "id,name", limit: LAUNCH_LIST_LIMIT };
    if (after) q.after = after;
    const res = await graph<{ data: { id: string; name?: string }[]; paging?: { next?: string; cursors?: { after?: string } } }>(
      `${acctPath(ctx.accountId)}/${edge}`, q, "GET", true, ctx.token,
    );
    for (const o of res.data) if ((o.name ?? "").includes(tag)) ids.push(o.id);
    after = nextCursor(res.paging, `/${edge}`);
    pages++;
  } while (after && pages < 20);
  // Truncating the search could miss an object a crashed retry already created → duplicate.
  // Fail closed so the launch saga aborts (marks uncertain) instead of risking a duplicate create.
  if (after) throw new MetaApiError(-2, undefined, `launch-token search truncated on /${edge} (too many objects)`);
  return ids;
}

export interface CreativeSpec {
  name: string; pageId: string; imageUrl: string; link: string;
  message?: string; headline?: string; description?: string; cta?: string;
}

/** Create an AdCreative (link ad) via object_story_spec. Returns the creative id. */
export async function createAdCreative(ctx: MetaCtx, spec: CreativeSpec): Promise<string> {
  const linkData: Record<string, unknown> = { link: spec.link };
  if (spec.message) linkData.message = spec.message;
  if (spec.headline) linkData.name = spec.headline;
  if (spec.description) linkData.description = spec.description;
  if (spec.imageUrl) linkData.picture = spec.imageUrl;
  if (spec.cta) linkData.call_to_action = { type: spec.cta.toUpperCase().replace(/\s+/g, "_"), value: { link: spec.link } };

  const res = await graph<{ id: string }>(`${acctPath(ctx.accountId)}/adcreatives`, {
    name: spec.name,
    object_story_spec: JSON.stringify({ page_id: spec.pageId, link_data: linkData }),
  }, "POST", false, ctx.token); // non-idempotent create — no retry (fail closed, reconcile by launch token)
  return res.id;
}

/** Create an Ad under an existing adset, always PAUSED. Returns the ad id. */
export async function createAdObject(
  ctx: MetaCtx, spec: { name: string; adsetId: string; creativeId: string },
): Promise<string> {
  const res = await graph<{ id: string }>(`${acctPath(ctx.accountId)}/ads`, {
    name: spec.name, adset_id: spec.adsetId,
    creative: JSON.stringify({ creative_id: spec.creativeId }), status: "PAUSED",
  }, "POST", false, ctx.token); // non-idempotent create — no retry (fail closed, reconcile by launch token)
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
export async function fetchAdLibrary(ctx: MetaCtx, params: {
  searchTerms: string; countries?: string[]; limit?: number;
}): Promise<AdLibraryItem[]> {
  const res = await graph<{ data: RawAdLibrary[] }>("ads_archive", {
    search_terms: params.searchTerms,
    ad_reached_countries: JSON.stringify(params.countries ?? ["US"]),
    ad_type: "ALL",
    fields: "id,page_name,ad_creative_bodies,ad_delivery_start_time,ad_snapshot_url",
    limit: params.limit ?? 25,
  }, "GET", true, ctx.token);
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
export async function sendConversion(ctx: MetaCtx, ev: ConversionEvent): Promise<{ ok: boolean; metaResponse: unknown }> {
  const pixelId = ctx.pixelId;
  if (!pixelId) throw new Error("Pixel/Dataset ID not set for this client.");
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
    `${pixelId}/events`, { data: JSON.stringify([event]) }, "POST", true, ctx.token,
  );
  return { ok: true, metaResponse };
}
