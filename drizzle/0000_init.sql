CREATE TABLE "action_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"meta_request" jsonb,
	"meta_response" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tier" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"action_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"target_state" jsonb NOT NULL,
	"evidence" jsonb,
	"guardrail_result" jsonb,
	"policy_version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_actions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "ads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creative_id" uuid,
	"copy" jsonb,
	"cta" text,
	"destination_url" text,
	"campaign_id" text,
	"adset_id" text,
	"meta_ad_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"event_type" text NOT NULL,
	"subject_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_control" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"write_mode" text DEFAULT 'off' NOT NULL,
	"emergency_stop" boolean DEFAULT true NOT NULL,
	"max_account_daily_spend_cents" integer DEFAULT 0 NOT NULL,
	"max_action_budget_delta_cents" integer DEFAULT 0 NOT NULL,
	"max_action_budget_delta_pct" numeric DEFAULT '0' NOT NULL,
	"min_metric_freshness_minutes" integer DEFAULT 30 NOT NULL,
	"active_policy_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blob_url" text NOT NULL,
	"type" text NOT NULL,
	"hash" text NOT NULL,
	"meta_creative_id" text,
	"review_state" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text,
	"stage" text DEFAULT 'new' NOT NULL,
	"score" integer,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone,
	"attributes" jsonb
);
--> statement-breakpoint
CREATE TABLE "meta_insights_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meta_account_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"date_start" date NOT NULL,
	"date_stop" date NOT NULL,
	"breakdown_hash" text DEFAULT '' NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"spend_cents" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"purchases" integer DEFAULT 0 NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetch_id" uuid
);
--> statement-breakpoint
CREATE TABLE "meta_insights_hourly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meta_account_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"breakdown_hash" text DEFAULT '' NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"spend_cents" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"purchases" integer DEFAULT 0 NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetch_id" uuid
);
--> statement-breakpoint
CREATE TABLE "metric_fetches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request" jsonb,
	"response" jsonb
);
--> statement-breakpoint
CREATE TABLE "metric_rollups_daily" (
	"day" date NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"spend_cents" integer DEFAULT 0 NOT NULL,
	"roas" numeric,
	"cpa_cents" integer,
	"ctr" numeric,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_reservations" (
	"action_id" uuid PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"delta_daily_budget_cents" integer NOT NULL,
	"status" text DEFAULT 'held' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_attempts" ADD CONSTRAINT "action_attempts_action_id_ad_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."ad_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_reservations" ADD CONSTRAINT "spend_reservations_action_id_ad_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."ad_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_audit_created" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_insights_daily" ON "meta_insights_daily" USING btree ("meta_account_id","entity_type","entity_id","date_start","date_stop","breakdown_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_insights_hourly" ON "meta_insights_hourly" USING btree ("meta_account_id","entity_type","entity_id","hour_start","breakdown_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_rollup_daily" ON "metric_rollups_daily" USING btree ("day","entity_type","entity_id");