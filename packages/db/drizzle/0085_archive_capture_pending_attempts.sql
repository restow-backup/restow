-- 0.5.0: an announced Graph message whose fetch keeps failing other than with 404 (an item the
-- app cannot read, a 403) stayed pending for good, at the head of the queue; a pass in which no
-- ref could be handled failed and skipped its catch-up, and 500 such refs blocked every newer
-- one. Each pending ref now counts its failed attempts; refs tried least are fetched first, and
-- after five failures a ref is dropped as an open capture gap and left to the catch-up. Existing
-- rows start at zero attempts.
--> statement-breakpoint
ALTER TABLE "archive_capture_pending" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "archive_capture_pending" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "archive_capture_pending" ADD COLUMN "last_attempt_at" timestamp with time zone;