CREATE TYPE "public"."tenant_language" AS ENUM('de', 'en');--> statement-breakpoint
CREATE TYPE "public"."storage_migration_mode" AS ENUM('move', 'keep');--> statement-breakpoint
CREATE TYPE "public"."storage_migration_status" AS ENUM('queued', 'copying', 'verifying', 'switching', 'completed', 'failed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."job_queue" ADD VALUE 'storage_migration';--> statement-breakpoint
ALTER TYPE "public"."storage_target_kind" ADD VALUE 'installation_default';--> statement-breakpoint
ALTER TYPE "public"."storage_target_role" ADD VALUE 'previous';--> statement-breakpoint
CREATE TABLE "tenant_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"email" text,
	"phone" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_notification_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"notify_job_failures" boolean DEFAULT false NOT NULL,
	"notify_weekly_report" boolean DEFAULT false NOT NULL,
	"notify_readiness_red" boolean DEFAULT false NOT NULL,
	"notify_license_updates" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_target_id" uuid,
	"destination_target_id" uuid NOT NULL,
	"mode" "storage_migration_mode" NOT NULL,
	"status" "storage_migration_status" DEFAULT 'queued' NOT NULL,
	"job_id" uuid,
	"objects_total" integer DEFAULT 0 NOT NULL,
	"objects_done" integer DEFAULT 0 NOT NULL,
	"bytes_total" bigint DEFAULT 0 NOT NULL,
	"bytes_done" bigint DEFAULT 0 NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"switched_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "customer_number" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "vat_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "country_code" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "language" "tenant_language";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "tenant_contacts" ADD CONSTRAINT "tenant_contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_notification_recipients" ADD CONSTRAINT "tenant_notification_recipients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_migrations" ADD CONSTRAINT "storage_migrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_migrations" ADD CONSTRAINT "storage_migrations_source_target_id_storage_targets_id_fk" FOREIGN KEY ("source_target_id") REFERENCES "public"."storage_targets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_migrations" ADD CONSTRAINT "storage_migrations_destination_target_id_storage_targets_id_fk" FOREIGN KEY ("destination_target_id") REFERENCES "public"."storage_targets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_migrations" ADD CONSTRAINT "storage_migrations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_contacts_tenant_primary_uq" ON "tenant_contacts" USING btree ("tenant_id") WHERE "tenant_contacts"."is_primary" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_notification_recipients_tenant_email_uq" ON "tenant_notification_recipients" USING btree ("tenant_id",lower("email"));--> statement-breakpoint
CREATE INDEX "storage_migrations_tenant_idx" ON "storage_migrations" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_migrations_tenant_unfinished_uq" ON "storage_migrations" USING btree ("tenant_id") WHERE "storage_migrations"."status" IN ('queued', 'copying', 'verifying', 'switching');--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_customer_number_uq" ON "tenants" USING btree (lower("customer_number")) WHERE "tenants"."customer_number" IS NOT NULL;