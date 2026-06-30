ALTER TABLE "clients" ADD COLUMN "verify_state" text DEFAULT 'draft' NOT NULL;
--> statement-breakpoint
-- Only the bootstrap account is implicitly trusted.
UPDATE "clients" SET "verify_state" = 'active' WHERE "id" = '00000000-0000-0000-0000-000000000001';
