-- The notification matrix (docs/ARCHITECTURE.md, Reports and notifications): every channel keeps the
-- events it gets. Nothing changes for what is sent today: each channel's column starts with exactly
-- the events that reach it now, and the bell's stays null (its default).
ALTER TABLE "tenant_notification_recipients" ADD COLUMN "events" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "bell_events" text[];--> statement-breakpoint
-- The tables force Row Level Security even for their owner (sql/rls.sql), so the force is lifted
-- for the two statements below and restored right after; sql/rls.sql applies it again after every
-- migration run in any case.
ALTER TABLE "tenant_notification_recipients" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhooks" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_rules" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- A recipient's four flags become events: failed runs and a readiness turning red as the events
-- their rules listed, the weekly report as `report.weekly`. "Licence and update notices" never sent
-- anything and go. Every event a rule mails the address about joins as well, so that a rule an
-- administrator made by hand keeps reaching the recipient.
UPDATE "tenant_notification_recipients" AS r SET "events" = ARRAY(
  SELECT DISTINCT e FROM unnest(
    (CASE WHEN r."notify_job_failures"
      THEN ARRAY['backup.failed', 'restore.failed', 'archive.failed', 'directory.failed']
      ELSE '{}'::text[] END)
    || (CASE WHEN r."notify_readiness_red" THEN ARRAY['verify.red', 'scrub.corrupt'] ELSE '{}'::text[] END)
    || (CASE WHEN r."notify_weekly_report" THEN ARRAY['report.weekly'] ELSE '{}'::text[] END)
    || COALESCE((
      SELECT array_agg(ev)
      FROM "report_rules" AS rr, unnest(rr."events") AS ev
      WHERE rr."tenant_id" = r."tenant_id"
        AND rr."trigger" = 'event'
        AND EXISTS (
          SELECT 1 FROM unnest(rr."email_recipients") AS address
          WHERE lower(btrim(address)) = lower(btrim(r."email"))
        )
    ), '{}'::text[])
  ) AS e
  ORDER BY e
);--> statement-breakpoint
-- A webhook's stream subscription switches the catalog events its deliveries are about on, and
-- every event a rule sends to the webhook joins: rules no longer ignore the webhook's list.
UPDATE "webhooks" AS w SET "events" = ARRAY(
  SELECT DISTINCT e FROM unnest(
    w."events"
    || (CASE WHEN 'job.failed' = ANY(w."events")
      THEN ARRAY['backup.failed', 'restore.failed', 'archive.failed', 'directory.failed']
      ELSE '{}'::text[] END)
    || (CASE WHEN 'job.completed' = ANY(w."events")
      THEN ARRAY['backup.succeeded', 'restore.completed']
      ELSE '{}'::text[] END)
    || (CASE WHEN 'verify.completed' = ANY(w."events") THEN ARRAY['verify.completed'] ELSE '{}'::text[] END)
    || COALESCE((
      SELECT array_agg(ev)
      FROM "report_rules" AS rr, unnest(rr."events") AS ev
      WHERE rr."webhook_id" = w."id" AND rr."trigger" = 'event'
    ), '{}'::text[])
  ) AS e
  ORDER BY e
);--> statement-breakpoint
ALTER TABLE "tenant_notification_recipients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhooks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_notification_recipients" DROP COLUMN "notify_job_failures";--> statement-breakpoint
ALTER TABLE "tenant_notification_recipients" DROP COLUMN "notify_weekly_report";--> statement-breakpoint
ALTER TABLE "tenant_notification_recipients" DROP COLUMN "notify_readiness_red";--> statement-breakpoint
ALTER TABLE "tenant_notification_recipients" DROP COLUMN "notify_license_updates";
