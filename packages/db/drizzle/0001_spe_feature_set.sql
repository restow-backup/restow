CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."imap_security" AS ENUM('tls', 'starttls', 'none');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('pending', 'active', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."manifest_object_kind" AS ENUM('mail', 'folder', 'file', 'event', 'contact');--> statement-breakpoint
CREATE TYPE "public"."schedule_kind" AS ENUM('backup', 'verify', 'retention', 'scrub', 'directory', 'archive');--> statement-breakpoint
CREATE TYPE "public"."storage_target_kind" AS ENUM('local', 's3');--> statement-breakpoint
CREATE TYPE "public"."storage_target_role" AS ENUM('primary', 'copy');--> statement-breakpoint
CREATE TYPE "public"."storage_target_status" AS ENUM('unverified', 'ok', 'error');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."notification_level" AS ENUM('info', 'warning', 'error');--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"kind" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manifest_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"protected_object_id" uuid NOT NULL,
	"kind" "manifest_object_kind" NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"parent_path" text DEFAULT '' NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"mtime" timestamp with time zone,
	"item_id" text,
	"message_id" text,
	"chunk_refs" jsonb,
	"metadata" jsonb,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"protected_object_id" uuid,
	"kind" "schedule_kind" NOT NULL,
	"interval_minutes" integer,
	"cron" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_interval_xor_cron_ck" CHECK (("schedules"."interval_minutes" IS NOT NULL) <> ("schedules"."cron" IS NOT NULL)),
	CONSTRAINT "schedules_interval_positive_ck" CHECK ("schedules"."interval_minutes" IS NULL OR "schedules"."interval_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "storage_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text,
	"kind" "storage_target_kind" NOT NULL,
	"role" "storage_target_role" DEFAULT 'primary' NOT NULL,
	"config" jsonb NOT NULL,
	"secret_ref" uuid,
	"status" "storage_target_status" DEFAULT 'unverified' NOT NULL,
	"error_message" text,
	"checked_at" timestamp with time zone,
	"bytes_used" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text,
	"url" text NOT NULL,
	"secret_ref" uuid,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"level" "notification_level" DEFAULT 'info' NOT NULL,
	"event" text NOT NULL,
	"message" text NOT NULL,
	"details" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "restore_jobs" DROP CONSTRAINT "restore_jobs_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "legal_holds" DROP CONSTRAINT "legal_holds_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "config" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "restore_jobs" ALTER COLUMN "actor_user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "actor_user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "legal_holds" ALTER COLUMN "created_by" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status" "tenant_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "edition_limit_mailboxes" integer;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "status" "source_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "entra_tenant_id" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "consent_granted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "consent_by" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "permissions_verified" jsonb;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "host" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "port" integer;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "security" "imap_security";--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "secret_ref" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_objects" ADD CONSTRAINT "manifest_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_objects" ADD CONSTRAINT "manifest_objects_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_objects" ADD CONSTRAINT "manifest_objects_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_targets" ADD CONSTRAINT "storage_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_targets" ADD CONSTRAINT "storage_targets_secret_ref_secrets_id_fk" FOREIGN KEY ("secret_ref") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_secret_ref_secrets_id_fk" FOREIGN KEY ("secret_ref") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secrets_tenant_kind_idx" ON "secrets" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "manifest_objects_snapshot_parent_idx" ON "manifest_objects" USING btree ("snapshot_id","parent_path");--> statement-breakpoint
CREATE INDEX "manifest_objects_tenant_path_idx" ON "manifest_objects" USING btree ("tenant_id","path");--> statement-breakpoint
CREATE INDEX "manifest_objects_object_item_idx" ON "manifest_objects" USING btree ("protected_object_id","item_id");--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "schedules_tenant_kind_idx" ON "schedules" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_targets_tenant_primary_uq" ON "storage_targets" USING btree ("tenant_id") WHERE "storage_targets"."role" = 'primary';--> statement-breakpoint
CREATE INDEX "storage_targets_tenant_idx" ON "storage_targets" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_uq" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_created_idx" ON "webhook_deliveries" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_next_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhooks_tenant_idx" ON "webhooks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "notifications_tenant_created_idx" ON "notifications" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_secret_ref_secrets_id_fk" FOREIGN KEY ("secret_ref") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Hand-written data step (not generated): actor columns used to reference the
-- Restow directory table (users, uuid); from now on they hold better-auth user
-- ids (user, text). Pre-existing rows can only point at directory users, which
-- never match a better-auth id, so clear them before the new FK is validated.
-- The audit_log keeps its actor ids untouched and gets no FK (append-only).
UPDATE "restore_jobs" SET "actor_user_id" = NULL WHERE "actor_user_id" IS NOT NULL AND "actor_user_id" NOT IN (SELECT "id" FROM "public"."user");--> statement-breakpoint
UPDATE "legal_holds" SET "created_by" = NULL WHERE "created_by" IS NOT NULL AND "created_by" NOT IN (SELECT "id" FROM "public"."user");--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_organization_uq" ON "tenants" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "protected_objects_tenant_status_idx" ON "protected_objects" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_tenant_entra_uq" ON "sources" USING btree ("tenant_id","entra_tenant_id") WHERE "sources"."entra_tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_tenant_status_idx" ON "jobs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "jobs_object_created_idx" ON "jobs" USING btree ("protected_object_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_created_idx" ON "audit_log" USING btree ("tenant_id","created_at");