CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"hypothesis" text,
	"metric" text DEFAULT 'cvr' NOT NULL,
	"variant_a_id" text NOT NULL,
	"variant_b_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" date,
	"ended_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
