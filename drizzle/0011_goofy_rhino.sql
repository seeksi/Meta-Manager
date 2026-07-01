ALTER TABLE "ad_actions" ADD COLUMN "compliance_status" text DEFAULT 'pass' NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_actions" ADD COLUMN "compliance_findings" jsonb;--> statement-breakpoint
ALTER TABLE "automation_control" ADD COLUMN "active_compliance_version" integer DEFAULT 1 NOT NULL;