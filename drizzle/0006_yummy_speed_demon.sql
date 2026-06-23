ALTER TABLE "ad_actions" ADD COLUMN "daily_budget_delta_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_actions" ADD COLUMN "daily_budget_delta_pct" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_actions" ADD COLUMN "projected_daily_spend_cents" integer DEFAULT 0 NOT NULL;