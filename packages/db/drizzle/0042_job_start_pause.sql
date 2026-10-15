-- New job starts paused for an update (#46): one row while an update waits for running jobs
-- or is announced; the scheduler, the worker and the PVE heartbeat read it. Installation level.
CREATE TABLE "job_start_pause" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"mode" text NOT NULL,
	"phase" text NOT NULL,
	"version" text NOT NULL,
	"lead_seconds" integer NOT NULL,
	"request" jsonb NOT NULL,
	"requested_by" jsonb NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"announced_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_start_pause_mode" CHECK ("job_start_pause"."mode" IN ('wait', 'drain', 'interrupt')),
	CONSTRAINT "job_start_pause_phase" CHECK ("job_start_pause"."phase" IN ('draining', 'announced'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_start_pause_singleton_uq" ON "job_start_pause" USING btree ("singleton");