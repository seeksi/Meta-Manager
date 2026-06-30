CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operators_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_owner_id_operators_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- G4 bootstrap ownership seam. Fixed id matches clients.BOOTSTRAP_OPERATOR_ID; the app
-- refreshes username from OPERATOR_USERNAME at boot.
INSERT INTO "operators" ("id", "username")
VALUES ('00000000-0000-0000-0000-000000000010', 'operator')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "clients"
SET "owner_id" = '00000000-0000-0000-0000-000000000010'
WHERE "owner_id" IS NULL;
