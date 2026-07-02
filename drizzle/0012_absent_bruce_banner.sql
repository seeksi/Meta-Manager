CREATE TABLE "audit_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"score" integer,
	"engine_version" integer NOT NULL,
	"summary" jsonb,
	"inputs" jsonb,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_audit_runs_client" ON "audit_runs" USING btree ("client_id","started_at" DESC NULLS LAST);