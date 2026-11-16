-- 0.5.0: a capture gap counted one attempt per pass or job, with no time between them. Passes run
-- minutes apart (back to back while more than 500 announced messages wait), so a Graph mailbox that
-- answered 500 on $value for two minutes during a backlog, or an IMAP server that refused for half
-- an hour, used up every attempt of mail that was fetchable shortly after, and an open gap was
-- final: nothing asked for it again. An attempt now counts at most once an hour (last_attempt_at),
-- and open gaps that may succeed later are asked for again once a day. Existing gaps take their
-- last sighting as their last attempt.
--> statement-breakpoint
ALTER TABLE "archive_capture_gaps" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
UPDATE "archive_capture_gaps" SET "last_attempt_at" = "last_seen_at";
