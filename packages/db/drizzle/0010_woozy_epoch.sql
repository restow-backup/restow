CREATE TYPE "public"."report_channel" AS ENUM('email', 'in_app', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."report_delivery_kind" AS ENUM('event', 'summary');--> statement-breakpoint
CREATE TYPE "public"."report_delivery_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."report_trigger" AS ENUM('event', 'schedule');--> statement-breakpoint
CREATE TABLE "report_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid,
	"rule_name" text NOT NULL,
	"kind" "report_delivery_kind" NOT NULL,
	"event" text,
	"subject_key" text,
	"payload" jsonb NOT NULL,
	"channel" "report_channel" NOT NULL,
	"recipient" text,
	"language" "tenant_language",
	"status" "report_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger" "report_trigger" NOT NULL,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"throttle_minutes" integer DEFAULT 60 NOT NULL,
	"interval_minutes" integer,
	"cron" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"period_days" integer DEFAULT 7 NOT NULL,
	"sections" text[] DEFAULT '{}'::text[] NOT NULL,
	"email_recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"in_app" boolean DEFAULT false NOT NULL,
	"webhook_id" uuid,
	"language" "tenant_language",
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_rules_schedule_cadence_ck" CHECK ("report_rules"."trigger" <> 'schedule' OR (("report_rules"."interval_minutes" IS NOT NULL) <> ("report_rules"."cron" IS NOT NULL))),
	CONSTRAINT "report_rules_interval_positive_ck" CHECK ("report_rules"."interval_minutes" IS NULL OR "report_rules"."interval_minutes" > 0),
	CONSTRAINT "report_rules_period_ck" CHECK ("report_rules"."period_days" BETWEEN 1 AND 366),
	CONSTRAINT "report_rules_throttle_ck" CHECK ("report_rules"."throttle_minutes" BETWEEN 0 AND 10080)
);
--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_rule_id_report_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."report_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_rules" ADD CONSTRAINT "report_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_rules" ADD CONSTRAINT "report_rules_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_deliveries_tenant_created_idx" ON "report_deliveries" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "report_deliveries_status_next_idx" ON "report_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "report_deliveries_throttle_idx" ON "report_deliveries" USING btree ("rule_id","subject_key","created_at");--> statement-breakpoint
CREATE INDEX "report_rules_tenant_idx" ON "report_rules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "report_rules_due_idx" ON "report_rules" USING btree ("trigger","enabled","next_run_at");--> statement-breakpoint
-- Data migration: the tenant wizard's notification recipient flags become
-- report rules (packages/db/src/schema/reports.ts). The recipients table stays
-- as it is (nothing is deleted); from now on only the rules send anything.
-- Both source tables force RLS even for their owner (sql/rls.sql), so the
-- force is lifted for this one read and restored right after; sql/rls.sql
-- applies it again after every migration run in any case.
ALTER TABLE "tenant_notification_recipients" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenants" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "report_rules" ("tenant_id", "name", "trigger", "events", "email_recipients", "created_by")
SELECT r."tenant_id",
       CASE WHEN t."language" = 'de' THEN 'Fehlgeschlagene Aufträge' ELSE 'Failed jobs' END,
       'event',
       ARRAY['backup.failed', 'restore.failed', 'archive.failed', 'directory.failed'],
       array_agg(r."email" ORDER BY r."created_at"),
       'migration'
FROM "tenant_notification_recipients" r
JOIN "tenants" t ON t."id" = r."tenant_id"
WHERE r."notify_job_failures"
GROUP BY r."tenant_id", t."language";--> statement-breakpoint
INSERT INTO "report_rules" ("tenant_id", "name", "trigger", "events", "email_recipients", "created_by")
SELECT r."tenant_id",
       CASE WHEN t."language" = 'de' THEN 'Wiederherstellbarkeit gefährdet' ELSE 'Recoverability at risk' END,
       'event',
       ARRAY['verify.red', 'scrub.corrupt'],
       array_agg(r."email" ORDER BY r."created_at"),
       'migration'
FROM "tenant_notification_recipients" r
JOIN "tenants" t ON t."id" = r."tenant_id"
WHERE r."notify_readiness_red"
GROUP BY r."tenant_id", t."language";--> statement-breakpoint
INSERT INTO "report_rules" ("tenant_id", "name", "trigger", "cron", "timezone", "period_days", "sections", "email_recipients", "created_by")
SELECT r."tenant_id",
       CASE WHEN t."language" = 'de' THEN 'Wochenbericht' ELSE 'Weekly report' END,
       'schedule',
       '0 7 * * 1',
       COALESCE(NULLIF(t."time_zone", ''), 'UTC'),
       7,
       ARRAY['backups', 'readiness', 'failures', 'storage', 'restores'],
       array_agg(r."email" ORDER BY r."created_at"),
       'migration'
FROM "tenant_notification_recipients" r
JOIN "tenants" t ON t."id" = r."tenant_id"
WHERE r."notify_weekly_report"
GROUP BY r."tenant_id", t."language", t."time_zone";--> statement-breakpoint
ALTER TABLE "tenant_notification_recipients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
