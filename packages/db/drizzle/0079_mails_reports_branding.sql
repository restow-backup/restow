-- 0.5.0: notification recipients of the provider and the floor, delivery-failure alerts, digests,
-- daily/weekly/monthly summary reports, the customer monthly report and branding
-- (docs/NOTIFICATIONS.md). New tables, and nullable or defaulted columns only: no rewrite of any
-- existing table. `report_deliveries.tenant_id` becomes nullable for the provider's own deliveries,
-- which Row Level Security hides from every tenant (sql/rls.sql). The weekly report of the tenants'
-- notification recipients becomes the calendar week (`cadence = 'weekly'`).
--> statement-breakpoint
CREATE TYPE "public"."provider_recipient_kind" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."report_cadence" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."report_digest_window" AS ENUM('hourly', 'daily');--> statement-breakpoint
CREATE TYPE "public"."report_rule_kind" AS ENUM('summary', 'customer');--> statement-breakpoint
CREATE TABLE "branding_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" text NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branding_images_token_unique" UNIQUE("token"),
	CONSTRAINT "branding_images_content_type_ck" CHECK ("branding_images"."content_type" IN ('image/png', 'image/jpeg')),
	CONSTRAINT "branding_images_byte_size_ck" CHECK ("branding_images"."byte_size" <= 524288)
);
--> statement-breakpoint
CREATE TABLE "provider_branding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"sender_name" text,
	"from_address" text,
	"reply_to" text,
	"accent_color" text,
	"footer_text" text,
	"logo_image_id" uuid,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_branding_accent_ck" CHECK ("provider_branding"."accent_color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "provider_branding_footer_ck" CHECK (length("provider_branding"."footer_text") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "tenant_branding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sender_name" text,
	"from_address" text,
	"reply_to" text,
	"accent_color" text,
	"footer_text" text,
	"logo_image_id" uuid,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_branding_tenant_id_unique" UNIQUE("tenant_id"),
	CONSTRAINT "tenant_branding_accent_ck" CHECK ("tenant_branding"."accent_color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "tenant_branding_footer_ck" CHECK (length("tenant_branding"."footer_text") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "provider_notification_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"kind" "provider_recipient_kind" DEFAULT 'member' NOT NULL,
	"user_id" text,
	"mandatory" boolean DEFAULT false NOT NULL,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"delivery" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"language" "tenant_language",
	"failing_since" timestamp with time zone,
	"failure_alerted_at" timestamp with time zone,
	"last_failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_report_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cadence" "report_cadence" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"timezone" text NOT NULL,
	"send_hour" integer DEFAULT 7 NOT NULL,
	"attach_pdf" boolean DEFAULT true NOT NULL,
	"email_recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"language" "tenant_language",
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_report_rules_cadence_unique" UNIQUE("cadence"),
	CONSTRAINT "provider_report_rules_send_hour_ck" CHECK ("provider_report_rules"."send_hour" BETWEEN 0 AND 23)
);
--> statement-breakpoint
CREATE TABLE "report_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"event" text NOT NULL,
	"level" "notification_level" NOT NULL,
	"subject_key" text NOT NULL,
	"message" text,
	"details" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"fanned_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_deliveries" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD COLUMN "about_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD COLUMN "provider_recipient_id" uuid;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD COLUMN "provider_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD COLUMN "report_event_id" uuid;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD COLUMN "digest" "report_digest_window";--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD COLUMN "digest_group" uuid;--> statement-breakpoint
ALTER TABLE "report_rules" ADD COLUMN "cadence" "report_cadence";--> statement-breakpoint
ALTER TABLE "report_rules" ADD COLUMN "attach_pdf" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "report_rules" ADD COLUMN "kind" "report_rule_kind" DEFAULT 'summary' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "mail_failure" jsonb;--> statement-breakpoint
ALTER TABLE "tenant_contacts" ADD COLUMN "monthly_report" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_notification_recipients" ADD COLUMN "delivery" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_notification_recipients" ADD COLUMN "failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_notification_recipients" ADD COLUMN "failure_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_notification_recipients" ADD COLUMN "last_failure_reason" text;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "failure_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "last_failure" text;--> statement-breakpoint
ALTER TABLE "provider_branding" ADD CONSTRAINT "provider_branding_logo_image_id_branding_images_id_fk" FOREIGN KEY ("logo_image_id") REFERENCES "public"."branding_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_logo_image_id_branding_images_id_fk" FOREIGN KEY ("logo_image_id") REFERENCES "public"."branding_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_notification_recipients" ADD CONSTRAINT "provider_notification_recipients_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_notification_recipients" ADD CONSTRAINT "provider_notification_recipients_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_events" ADD CONSTRAINT "report_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_branding_singleton_uq" ON "provider_branding" USING btree ("singleton");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_notification_recipients_email_uq" ON "provider_notification_recipients" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "provider_notification_recipients_owner_uq" ON "provider_notification_recipients" USING btree ("user_id") WHERE "provider_notification_recipients"."kind" = 'owner';--> statement-breakpoint
CREATE INDEX "report_events_pending_idx" ON "report_events" USING btree ("created_at") WHERE "report_events"."fanned_out_at" IS NULL;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_about_tenant_id_tenants_id_fk" FOREIGN KEY ("about_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_provider_recipient_id_provider_notification_recipients_id_fk" FOREIGN KEY ("provider_recipient_id") REFERENCES "public"."provider_notification_recipients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_provider_rule_id_provider_report_rules_id_fk" FOREIGN KEY ("provider_rule_id") REFERENCES "public"."provider_report_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_deliveries_digest_due_idx" ON "report_deliveries" USING btree ("status","digest","next_attempt_at") WHERE "report_deliveries"."digest" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "report_deliveries_provider_throttle_idx" ON "report_deliveries" USING btree ("provider_recipient_id","subject_key","created_at") WHERE "report_deliveries"."provider_recipient_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "report_deliveries_event_idx" ON "report_deliveries" USING btree ("report_event_id") WHERE "report_deliveries"."report_event_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_scope_ck" CHECK ("report_deliveries"."tenant_id" IS NOT NULL OR "report_deliveries"."rule_id" IS NULL);--> statement-breakpoint
ALTER TABLE "report_rules" ADD CONSTRAINT "report_rules_cadence_ck" CHECK ("report_rules"."cadence" IS NULL OR "report_rules"."trigger" = 'schedule');--> statement-breakpoint
ALTER TABLE "report_rules" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "report_rules" SET "cadence" = 'weekly' WHERE "recipient_category" = 'weeklyReport' AND "trigger" = 'schedule' AND "cron" = '0 7 * * 1';--> statement-breakpoint
ALTER TABLE "report_rules" FORCE ROW LEVEL SECURITY;
