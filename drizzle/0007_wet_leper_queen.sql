-- 0007 — Client scoping (M1 / WS-1). HAND-EDITED from the drizzle baseline into a safe,
-- ordered backfill so existing single-account data keeps working with ZERO manual fixup.
--
-- Strategy: add client_id as NULLABLE, backfill every existing row + the singleton control
-- row to a fixed-id "bootstrap" client, THEN add NOT NULL + FK. The bootstrap client's real
-- meta_account_id / page_id / pixel_id come from env (META_AD_ACCOUNT_ID / META_PAGE_ID /
-- META_PIXEL_ID) which SQL can't read — so we seed a placeholder here and the app upserts the
-- real values at boot via clients.ensureBootstrapClient(). Nothing reads those creds until G2.

-- ── 1. New tables ──────────────────────────────────────────────────────────────
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"meta_account_id" text NOT NULL,
	"page_id" text,
	"pixel_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agency_control" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"emergency_stop" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── 2. Bootstrap client + agency master kill ───────────────────────────────────
-- Fixed id matches clients.BOOTSTRAP_CLIENT_ID. Placeholder creds overwritten at app boot.
INSERT INTO "clients" ("id", "name", "status", "meta_account_id", "page_id", "pixel_id")
VALUES ('00000000-0000-0000-0000-000000000001', 'Bootstrap (existing account)', 'active', '__BOOTSTRAP__', NULL, NULL);
--> statement-breakpoint
-- Master panic switch starts disarmed; per-client gates enforce default-deny.
INSERT INTO "agency_control" ("id", "emergency_stop") VALUES (true, false);
--> statement-breakpoint

-- ── 3. Add client_id as NULLABLE to every operational table ────────────────────
ALTER TABLE "ad_actions" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "ads" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "competitor_creatives" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "metric_rollups_daily" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "spend_reservations" ADD COLUMN "client_id" uuid;--> statement-breakpoint

-- ── 4. Backfill every existing row to the bootstrap client ─────────────────────
UPDATE "ad_actions"            SET "client_id" = '00000000-0000-0000-0000-000000000001' WHERE "client_id" IS NULL;--> statement-breakpoint
UPDATE "ads"                   SET "client_id" = '00000000-0000-0000-0000-000000000001' WHERE "client_id" IS NULL;--> statement-breakpoint
UPDATE "audit_events"          SET "client_id" = '00000000-0000-0000-0000-000000000001' WHERE "client_id" IS NULL;--> statement-breakpoint
UPDATE "competitor_creatives"  SET "client_id" = '00000000-0000-0000-0000-000000000001' WHERE "client_id" IS NULL;--> statement-breakpoint
UPDATE "creatives"             SET "client_id" = '00000000-0000-0000-0000-000000000001' WHERE "client_id" IS NULL;--> statement-breakpoint
UPDATE "experiments"           SET "client_id" = '00000000-0000-0000-0000-000000000001' WHERE "client_id" IS NULL;--> statement-breakpoint
UPDATE "leads"                 SET "client_id" = '00000000-0000-0000-0000-000000000001' WHERE "client_id" IS NULL;--> statement-breakpoint
UPDATE "metric_rollups_daily"  SET "client_id" = '00000000-0000-0000-0000-000000000001' WHERE "client_id" IS NULL;--> statement-breakpoint
UPDATE "spend_reservations"    SET "client_id" = '00000000-0000-0000-0000-000000000001' WHERE "client_id" IS NULL;--> statement-breakpoint

-- ── 5. Enforce NOT NULL + FK now that backfill is complete ─────────────────────
ALTER TABLE "ad_actions"           ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ads"                  ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "competitor_creatives" ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "creatives"            ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments"          ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "leads"                ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "metric_rollups_daily" ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "spend_reservations"   ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_actions" ADD CONSTRAINT "ad_actions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_creatives" ADD CONSTRAINT "competitor_creatives_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_rollups_daily" ADD CONSTRAINT "metric_rollups_daily_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_reservations" ADD CONSTRAINT "spend_reservations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ── 6. Indexes (incl. per-client unique rollup key) ────────────────────────────
DROP INDEX "ux_rollup_daily";--> statement-breakpoint
CREATE UNIQUE INDEX "ux_rollup_daily" ON "metric_rollups_daily" USING btree ("client_id","day","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "ix_ad_actions_client" ON "ad_actions" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ix_audit_client" ON "audit_events" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ix_rollup_client" ON "metric_rollups_daily" USING btree ("client_id");--> statement-breakpoint

-- ── 7. automation_control: singleton boolean id -> per-client uuid PK ──────────
-- Migrate the existing singleton control row (id=true, if any) onto the bootstrap client,
-- carrying over writeMode / caps / optimizer targets / activePolicyVersion untouched.
ALTER TABLE "automation_control" ADD COLUMN "client_id" uuid;--> statement-breakpoint
UPDATE "automation_control" SET "client_id" = '00000000-0000-0000-0000-000000000001' WHERE "id" = true;--> statement-breakpoint
ALTER TABLE "automation_control" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "automation_control" ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_control" ADD CONSTRAINT "automation_control_pkey" PRIMARY KEY ("client_id");--> statement-breakpoint
ALTER TABLE "automation_control" ADD CONSTRAINT "automation_control_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
