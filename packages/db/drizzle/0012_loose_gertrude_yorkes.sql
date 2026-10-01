CREATE TYPE "public"."export_format" AS ENUM('eml_zip', 'mbox', 'msg_zip');--> statement-breakpoint
CREATE TYPE "public"."export_origin" AS ENUM('snapshot', 'archive');--> statement-breakpoint
CREATE TYPE "public"."import_upload_status" AS ENUM('uploading', 'ready', 'consumed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."endpoint_arch" AS ENUM('amd64', 'arm64');--> statement-breakpoint
CREATE TYPE "public"."endpoint_os" AS ENUM('linux', 'windows', 'darwin');--> statement-breakpoint
CREATE TYPE "public"."endpoint_profile" AS ENUM('server', 'client');--> statement-breakpoint
CREATE TYPE "public"."endpoint_report_kind" AS ENUM('restore_test', 'repository_check', 'retention');--> statement-breakpoint
CREATE TYPE "public"."endpoint_run_kind" AS ENUM('backup', 'restore', 'verify_sample');--> statement-breakpoint
CREATE TYPE "public"."endpoint_run_status" AS ENUM('running', 'succeeded', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."endpoint_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."endpoint_task_kind" AS ENUM('backup_now', 'restore', 'verify_sample', 'update_config', 'uninstall');--> statement-breakpoint
CREATE TYPE "public"."endpoint_task_status" AS ENUM('pending', 'delivered', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "import_upload_segments" (
	"upload_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"segment_index" integer NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_upload_segments_upload_id_segment_index_pk" PRIMARY KEY("upload_id","segment_index")
);
--> statement-breakpoint
CREATE TABLE "import_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" text,
	"file_name" text NOT NULL,
	"size" bigint NOT NULL,
	"segment_size" integer NOT NULL,
	"segment_count" integer NOT NULL,
	"status" "import_upload_status" DEFAULT 'uploading' NOT NULL,
	"detected_format" text,
	"import_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid,
	"origin" "export_origin" NOT NULL,
	"format" "export_format" NOT NULL,
	"snapshot_id" uuid,
	"protected_object_id" uuid,
	"selection" jsonb NOT NULL,
	"file_name" text,
	"content_type" text,
	"file_size" bigint,
	"segment_size" integer,
	"sha256" text,
	"report" jsonb,
	"expires_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"actor_user_id" text,
	"impersonated" boolean DEFAULT false NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"protected_object_id" uuid NOT NULL,
	"job_id" uuid,
	"name" text NOT NULL,
	"files" jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"report" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoint_enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"profile" "endpoint_profile" NOT NULL,
	"display_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_endpoint_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoint_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"kind" "endpoint_report_kind" NOT NULL,
	"origin" text DEFAULT 'server' NOT NULL,
	"snapshot_id" text,
	"readiness" "recovery_readiness",
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_id" uuid,
	"alerted_at" timestamp with time zone,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoint_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"kind" "endpoint_run_kind" NOT NULL,
	"status" "endpoint_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"snapshot_id" text,
	"stats" jsonb,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"log_tail" text,
	"progress" jsonb,
	"task_id" uuid,
	"alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoint_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"snapshot_id" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoint_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"kind" "endpoint_task_kind" NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "endpoint_task_status" DEFAULT 'pending' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"display_name" text,
	"os" "endpoint_os" NOT NULL,
	"arch" "endpoint_arch" NOT NULL,
	"profile" "endpoint_profile" NOT NULL,
	"agent_version" text,
	"os_version" text,
	"status" "endpoint_status" DEFAULT 'active' NOT NULL,
	"secret_hash" text NOT NULL,
	"repository_secret_id" uuid,
	"config" jsonb NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_state" text,
	"next_run_at" timestamp with time zone,
	"agent_config_version" integer,
	"last_seen_at" timestamp with time zone,
	"last_backup_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_snapshot_id" text,
	"last_retention_at" timestamp with time zone,
	"last_check_at" timestamp with time zone,
	"last_restore_test_at" timestamp with time zone,
	"stale_alerted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_upload_segments" ADD CONSTRAINT "import_upload_segments_upload_id_import_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."import_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_upload_segments" ADD CONSTRAINT "import_upload_segments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_uploads" ADD CONSTRAINT "import_uploads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_uploads" ADD CONSTRAINT "import_uploads_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_exports" ADD CONSTRAINT "mail_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_exports" ADD CONSTRAINT "mail_exports_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_exports" ADD CONSTRAINT "mail_exports_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_exports" ADD CONSTRAINT "mail_exports_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_exports" ADD CONSTRAINT "mail_exports_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_imports" ADD CONSTRAINT "mail_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_imports" ADD CONSTRAINT "mail_imports_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_imports" ADD CONSTRAINT "mail_imports_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_imports" ADD CONSTRAINT "mail_imports_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_imports" ADD CONSTRAINT "mail_imports_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_enrollment_tokens" ADD CONSTRAINT "endpoint_enrollment_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_enrollment_tokens" ADD CONSTRAINT "endpoint_enrollment_tokens_used_by_endpoint_id_endpoints_id_fk" FOREIGN KEY ("used_by_endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_enrollment_tokens" ADD CONSTRAINT "endpoint_enrollment_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_reports" ADD CONSTRAINT "endpoint_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_reports" ADD CONSTRAINT "endpoint_reports_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_runs" ADD CONSTRAINT "endpoint_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_runs" ADD CONSTRAINT "endpoint_runs_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_samples" ADD CONSTRAINT "endpoint_samples_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_samples" ADD CONSTRAINT "endpoint_samples_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_samples" ADD CONSTRAINT "endpoint_samples_run_id_endpoint_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."endpoint_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_tasks" ADD CONSTRAINT "endpoint_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_tasks" ADD CONSTRAINT "endpoint_tasks_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_tasks" ADD CONSTRAINT "endpoint_tasks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_repository_secret_id_secrets_id_fk" FOREIGN KEY ("repository_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_uploads_tenant_status_idx" ON "import_uploads" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "import_uploads_expires_idx" ON "import_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mail_exports_tenant_created_idx" ON "mail_exports" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "mail_exports_expires_idx" ON "mail_exports" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mail_imports_tenant_created_idx" ON "mail_imports" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_enrollment_tokens_hash_uq" ON "endpoint_enrollment_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "endpoint_enrollment_tokens_tenant_idx" ON "endpoint_enrollment_tokens" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "endpoint_reports_endpoint_checked_idx" ON "endpoint_reports" USING btree ("endpoint_id","checked_at");--> statement-breakpoint
CREATE INDEX "endpoint_reports_tenant_kind_idx" ON "endpoint_reports" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "endpoint_runs_endpoint_started_idx" ON "endpoint_runs" USING btree ("endpoint_id","started_at");--> statement-breakpoint
CREATE INDEX "endpoint_runs_tenant_status_idx" ON "endpoint_runs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_samples_run_path_uq" ON "endpoint_samples" USING btree ("run_id","path");--> statement-breakpoint
CREATE INDEX "endpoint_samples_endpoint_snapshot_idx" ON "endpoint_samples" USING btree ("endpoint_id","snapshot_id");--> statement-breakpoint
CREATE INDEX "endpoint_tasks_endpoint_status_idx" ON "endpoint_tasks" USING btree ("endpoint_id","status");--> statement-breakpoint
CREATE INDEX "endpoint_tasks_tenant_created_idx" ON "endpoint_tasks" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "endpoints_tenant_profile_idx" ON "endpoints" USING btree ("tenant_id","profile","status");--> statement-breakpoint
CREATE INDEX "endpoints_status_seen_idx" ON "endpoints" USING btree ("status","last_seen_at");