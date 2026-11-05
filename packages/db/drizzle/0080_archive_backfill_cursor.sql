-- 0.5.0: the one-time takeover of a mailbox's existing mail (the archive backfill) keeps its
-- position on the capture stream instead of only in its job's cursor. A continuation is a new
-- job with an empty cursor, so every continuation started over from the first folder (quadratic
-- work, and for a large mailbox a backfill that never finished); a retried or re-queued backfill
-- did the same. The column is null until a backfill saves its first checkpoint and is cleared
-- when the backfill completes. Adding a nullable column rewrites nothing.
--> statement-breakpoint
ALTER TABLE "archive_capture_streams" ADD COLUMN "backfill_cursor" jsonb;
