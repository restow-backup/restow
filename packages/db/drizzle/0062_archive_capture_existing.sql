-- 0.4.4, data migration: mail jobs that archived before the update keep doing exactly what they
-- did (docs/ARCHIVE.md "Erfassungswege", docs/UPDATING.md). Before 0.4.4 the archive took in
-- Exchange journal reports only; the capture ways of 0.4.4 would otherwise start on such a job by
-- themselves with the defaults (Graph for Microsoft 365, IMAP sync for IMAP and Google), each
-- with a one-time takeover of every mailbox. So every mail job with archive on whose
-- `archive_capture` is still empty gets: Microsoft 365 by Exchange journaling only, and IMAP and
-- Google accounts with no way and the marker `pending` (no capture until an administrator
-- chooses; the API accepts the job without a way while the marker stands, and choosing a way
-- clears it). All three kinds are set whatever the job holds today, so a mailbox added later is
-- not captured by a new way either. Jobs that do not archive, and jobs whose ways were already
-- chosen, are left alone. backup_jobs forces Row Level Security even for its owner
-- (sql/rls.sql), so the force is lifted for this one statement and restored right after;
-- sql/rls.sql applies it again after every migration run.
ALTER TABLE "backup_jobs" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "backup_jobs"
   SET "archive_capture" = '{"m365":{"graph":false,"journal":true},"imap":{"sync":false,"forward":false,"pending":true},"google":{"sync":false,"forward":false,"pending":true}}'::jsonb
 WHERE "kind" = 'mail' AND "archive" AND "archive_capture" = '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "backup_jobs" FORCE ROW LEVEL SECURITY;
