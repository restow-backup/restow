-- 0.5.4, ransomware detection (docs/RANSOMWARE.md, "Results, episodes and alerts"): a restore point
-- whose only findings are the amount of change is `unusual` (a warning without a retention hold)
-- instead of `suspicious`, and `reclassified_at` marks the judgements the worker turned from
-- `suspicious` to `unusual` once after the update. A nullable column without a default and a check
-- that every existing row meets; only the event lists of the notification rules and recipients are
-- updated (below). The journal time lies between 0105 and the migrations of 0.6.0, which renumber.
--> statement-breakpoint
ALTER TABLE "restore_point_suspicions" DROP CONSTRAINT "restore_point_suspicions_verdict_ck";--> statement-breakpoint
ALTER TABLE "restore_point_suspicions" ADD COLUMN "reclassified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "restore_point_suspicions" ADD CONSTRAINT "restore_point_suspicions_verdict_ck" CHECK ("restore_point_suspicions"."verdict" IN ('none', 'unusual', 'suspicious'));--> statement-breakpoint
-- Data migration: whoever is told about `backup.suspicious` is told about the new warning
-- `backup.unusual_change` as well, which takes over the findings of the amount of change alone.
-- Rules and tenant recipients force RLS even for their owner (sql/rls.sql), so the force is lifted
-- for this update; sql/rls.sql applies it again after every migration run. Webhooks keep their
-- list: a receiver opts into a new event type itself.
ALTER TABLE "report_rules" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_notification_recipients" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "report_rules" SET "events" = array_append("events", 'backup.unusual_change')
  WHERE 'backup.suspicious' = ANY("events") AND NOT 'backup.unusual_change' = ANY("events");--> statement-breakpoint
UPDATE "tenant_notification_recipients" SET "events" = array_append("events", 'backup.unusual_change')
  WHERE 'backup.suspicious' = ANY("events") AND NOT 'backup.unusual_change' = ANY("events");--> statement-breakpoint
UPDATE "provider_notification_recipients" SET "events" = array_append("events", 'backup.unusual_change')
  WHERE 'backup.suspicious' = ANY("events") AND NOT 'backup.unusual_change' = ANY("events");--> statement-breakpoint
ALTER TABLE "report_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_notification_recipients" FORCE ROW LEVEL SECURITY;
