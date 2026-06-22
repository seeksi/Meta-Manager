CREATE TABLE "competitor_creatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advertiser" text NOT NULL,
	"ad_archive_id" text,
	"body" text,
	"media_url" text,
	"started_running" date,
	"days_running" integer,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
