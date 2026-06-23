// Drizzle schema — see docs/ARCHITECTURE.md §4. Money is stored as integer cents.
import {
  pgTable, text, integer, boolean, timestamp, jsonb, uuid, numeric, date,
  uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Metrics (plain Postgres + rollups; partition/BRIN later) ───────────────────
export const metricFetches = pgTable("metric_fetches", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  request: jsonb("request"),
  response: jsonb("response"),
});

export const metaInsightsDaily = pgTable(
  "meta_insights_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    metaAccountId: text("meta_account_id").notNull(),
    entityType: text("entity_type").notNull(), // account|campaign|adset|ad
    entityId: text("entity_id").notNull(),
    dateStart: date("date_start").notNull(),
    dateStop: date("date_stop").notNull(),
    breakdownHash: text("breakdown_hash").notNull().default(""),
    impressions: integer("impressions").notNull().default(0),
    reach: integer("reach").notNull().default(0),
    spendCents: integer("spend_cents").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    purchases: integer("purchases").notNull().default(0),
    revenueCents: integer("revenue_cents").notNull().default(0),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    fetchId: uuid("fetch_id"),
  },
  (t) => [
    uniqueIndex("ux_insights_daily").on(
      t.metaAccountId, t.entityType, t.entityId, t.dateStart, t.dateStop, t.breakdownHash,
    ),
  ],
);

export const metaInsightsHourly = pgTable(
  "meta_insights_hourly",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    metaAccountId: text("meta_account_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    hourStart: timestamp("hour_start", { withTimezone: true }).notNull(),
    breakdownHash: text("breakdown_hash").notNull().default(""),
    impressions: integer("impressions").notNull().default(0),
    spendCents: integer("spend_cents").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    purchases: integer("purchases").notNull().default(0),
    revenueCents: integer("revenue_cents").notNull().default(0),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    fetchId: uuid("fetch_id"),
  },
  (t) => [
    uniqueIndex("ux_insights_hourly").on(
      t.metaAccountId, t.entityType, t.entityId, t.hourStart, t.breakdownHash,
    ),
  ],
);

export const metricRollupsDaily = pgTable(
  "metric_rollups_daily",
  {
    day: date("day").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    spendCents: integer("spend_cents").notNull().default(0),
    roas: numeric("roas"),
    cpaCents: integer("cpa_cents"),
    ctr: numeric("ctr"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ux_rollup_daily").on(t.day, t.entityType, t.entityId)],
);

// ── Autonomy engine (see §5) ───────────────────────────────────────────────────
// Singleton control row (id always true). write_mode: off|observe|tier_a|all.
export const automationControl = pgTable("automation_control", {
  id: boolean("id").primaryKey().default(true),
  writeMode: text("write_mode").notNull().default("off"),
  emergencyStop: boolean("emergency_stop").notNull().default(true), // KILL SWITCH (true = stopped)
  maxAccountDailySpendCents: integer("max_account_daily_spend_cents").notNull().default(0),
  maxActionBudgetDeltaCents: integer("max_action_budget_delta_cents").notNull().default(0),
  maxActionBudgetDeltaPct: numeric("max_action_budget_delta_pct").notNull().default("0"),
  minMetricFreshnessMinutes: integer("min_metric_freshness_minutes").notNull().default(30),
  // Optimizer targets (drive proposal rules).
  targetCpaCents: integer("target_cpa_cents").notNull().default(5000),
  targetRoas: numeric("target_roas").notNull().default("2"),
  activePolicyVersion: integer("active_policy_version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull().default("system"),
});

// status: proposed|blocked|pending_approval|approved|executing|succeeded|failed|uncertain
export const adActions = pgTable("ad_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tier: text("tier").notNull(), // A | B
  status: text("status").notNull().default("proposed"),
  actionType: text("action_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  targetState: jsonb("target_state").notNull(), // absolute target, never deltas
  // Persisted so the executor can RE-RUN guardrails at write time (caps depend on these).
  dailyBudgetDeltaCents: integer("daily_budget_delta_cents").notNull().default(0),
  dailyBudgetDeltaPct: numeric("daily_budget_delta_pct").notNull().default("0"),
  projectedDailySpendCents: integer("projected_daily_spend_cents").notNull().default(0),
  evidence: jsonb("evidence"),
  guardrailResult: jsonb("guardrail_result"),
  policyVersion: integer("policy_version").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const actionAttempts = pgTable("action_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  actionId: uuid("action_id").notNull().references(() => adActions.id),
  attempt: integer("attempt").notNull(),
  metaRequest: jsonb("meta_request"),
  metaResponse: jsonb("meta_response"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actor: text("actor").notNull(), // operator | system | optimizer
    eventType: text("event_type").notNull(),
    subjectId: text("subject_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    actionId: uuid("action_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_audit_created").on(t.createdAt)],
);

export const spendReservations = pgTable("spend_reservations", {
  actionId: uuid("action_id").primaryKey().references(() => adActions.id),
  day: date("day").notNull(),
  deltaDailyBudgetCents: integer("delta_daily_budget_cents").notNull(),
  status: text("status").notNull().default("held"), // held|committed|released
});

// ── Creatives / ads / leads ─────────────────────────────────────────────────────
export const creatives = pgTable("creatives", {
  id: uuid("id").primaryKey().defaultRandom(),
  blobUrl: text("blob_url").notNull(),
  type: text("type").notNull(), // image | video
  hash: text("hash").notNull(),
  metaCreativeId: text("meta_creative_id"),
  reviewState: text("review_state").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ads = pgTable("ads", {
  id: uuid("id").primaryKey().defaultRandom(),
  creativeId: uuid("creative_id").references(() => creatives.id),
  copy: jsonb("copy"), // { headline, primaryText, description }
  cta: text("cta"),
  destinationUrl: text("destination_url"),
  campaignId: text("campaign_id"),
  adsetId: text("adset_id"),
  metaAdId: text("meta_ad_id"),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const leads = pgTable("leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source"),
  campaignId: text("campaign_id"), // attribution: Meta campaign that produced the lead
  stage: text("stage").notNull().default("new"),
  score: integer("score"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  attributes: jsonb("attributes"),
});

// ── Competitor research (Meta Ad Library + scraping actors) ─────────────────────
export const competitorCreatives = pgTable("competitor_creatives", {
  id: uuid("id").primaryKey().defaultRandom(),
  advertiser: text("advertiser").notNull(),
  adArchiveId: text("ad_archive_id"), // Meta Ad Library id
  body: text("body"),
  mediaUrl: text("media_url"),
  startedRunning: date("started_running"),
  daysRunning: integer("days_running"),
  tags: jsonb("tags").notNull().default([]), // reusable pattern tags
  raw: jsonb("raw"),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── A/B experiments ─────────────────────────────────────────────────────────────
export const experiments = pgTable("experiments", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  hypothesis: text("hypothesis"),
  metric: text("metric").notNull().default("cvr"), // cvr = purchases/clicks
  variantAId: text("variant_a_id").notNull(), // entity id (campaign/ad)
  variantBId: text("variant_b_id").notNull(),
  status: text("status").notNull().default("running"), // running | concluded
  startedAt: date("started_at"),
  endedAt: date("ended_at"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const schema = {
  metricFetches, metaInsightsDaily, metaInsightsHourly, metricRollupsDaily,
  automationControl, adActions, actionAttempts, auditEvents, spendReservations,
  creatives, ads, leads, competitorCreatives, experiments,
};

void sql; // re-export anchor for future raw-SQL helpers
