-- 0.5.0: what the archive capture could not take in, kept durably (docs/ARCHIVE.md "Lücken der
-- Erfassung"). Until now an IMAP folder the server refused (EXAMINE or STATUS with a NO, a
-- throttling cap included) and a message the server listed but never delivered were given up
-- with a warning in the log; the stream stayed "live" and nothing showed that mail was missing.
-- A gap is one row per stream, kind (folder or message) and ref; every failed attempt counts, from
-- the third on (or when a way gives up at once, e.g. a Graph message without a MIME export) it is
-- open and the stream shows "incomplete"; captured later it is resolved. A new, empty table under
-- Row Level Security (sql/rls.sql); nothing existing is rewritten.
--> statement-breakpoint
CREATE TYPE "public"."archive_capture_gap_kind" AS ENUM('folder', 'message');--> statement-breakpoint
CREATE TABLE "archive_capture_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stream_id" uuid NOT NULL,
	"kind" "archive_capture_gap_kind" NOT NULL,
	"ref" text NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archive_capture_gaps" ADD CONSTRAINT "archive_capture_gaps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_capture_gaps" ADD CONSTRAINT "archive_capture_gaps_stream_id_archive_capture_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."archive_capture_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "archive_capture_gaps_stream_ref_uq" ON "archive_capture_gaps" USING btree ("stream_id","kind","ref");--> statement-breakpoint
CREATE INDEX "archive_capture_gaps_open_idx" ON "archive_capture_gaps" USING btree ("tenant_id","stream_id") WHERE "archive_capture_gaps"."resolved_at" IS NULL AND "archive_capture_gaps"."opened_at" IS NOT NULL;