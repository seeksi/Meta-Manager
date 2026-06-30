CREATE TABLE "scheduler_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"client_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"result" jsonb
);
--> statement-breakpoint
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_scheduler_runs_job_started" ON "scheduler_runs" USING btree ("job","started_at" DESC NULLS LAST);