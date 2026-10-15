CREATE TABLE "file_share_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_share_id" uuid NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"mtime" timestamp with time zone,
	"first_seq" integer NOT NULL,
	"end_seq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_share_downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_share_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"selection" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "file_share_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_share_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"readiness" "recovery_readiness",
	"snapshot_id" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_id" uuid,
	"alerted_at" timestamp with time zone,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_share_repository_locks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_share_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_share_run_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"path" text NOT NULL,
	"code" text NOT NULL,
	"phase" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_share_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_share_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"backup_job_id" uuid,
	"lock_share_id" uuid NOT NULL,
	"target_share_id" uuid,
	"source_snapshot_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"token_hash" text,
	"token_expires_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_progress_at" timestamp with time zone,
	"finish_processed_at" timestamp with time zone,
	"progress" jsonb,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot_id" uuid,
	"item_count" integer DEFAULT 0 NOT NULL,
	"items_stored" integer DEFAULT 0 NOT NULL,
	"failure" jsonb,
	"error_message" text,
	"log_tail" text,
	"requested_by" text,
	"alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_share_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_share_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"snapshot_id" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_share_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_share_id" uuid NOT NULL,
	"run_id" uuid,
	"sequence" integer NOT NULL,
	"restic_snapshot_id" text NOT NULL,
	"snapshot_time" timestamp with time zone NOT NULL,
	"includes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"files" bigint DEFAULT 0 NOT NULL,
	"dirs" bigint DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"bytes_added" bigint DEFAULT 0 NOT NULL,
	"permissions" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"pruned_at" timestamp with time zone,
	"cataloged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"protocol" text NOT NULL,
	"server" text NOT NULL,
	"share_name" text,
	"export_path" text,
	"subfolder" text DEFAULT '' NOT NULL,
	"smb_version" text,
	"smb_encryption" boolean DEFAULT false NOT NULL,
	"smb_domain" text,
	"username" text,
	"credential_secret_id" uuid,
	"nfs_version" text,
	"allow_restore" boolean DEFAULT false NOT NULL,
	"permissions_mode" text DEFAULT 'auto' NOT NULL,
	"reread_permissions" boolean DEFAULT false NOT NULL,
	"private_network_approval" jsonb,
	"repository_secret_id" uuid,
	"repository_ready_at" timestamp with time zone,
	"repository_bytes" bigint,
	"repository_measured_at" timestamp with time zone,
	"quota_gib" integer,
	"quota_alert_level" text,
	"quota_alerted_at" timestamp with time zone,
	"quota_refused_at" timestamp with time zone,
	"last_test" jsonb,
	"credential_failed_at" timestamp with time zone,
	"last_backup_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_snapshot_id" uuid,
	"last_retention_at" timestamp with time zone,
	"last_check_at" timestamp with time zone,
	"last_restore_test_at" timestamp with time zone,
	"last_catalog_at" timestamp with time zone,
	"maintenance_locked_count" integer DEFAULT 0 NOT NULL,
	"maintenance_locked_since" timestamp with time zone,
	"locked_alerted_at" timestamp with time zone,
	"allow_empty_once" boolean DEFAULT false NOT NULL,
	"retired_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_samples" DROP CONSTRAINT "run_samples_one_run_ck";--> statement-breakpoint
ALTER TABLE "warning_acknowledgements" DROP CONSTRAINT "warning_acknowledgements_one_target_ck";--> statement-breakpoint
ALTER TABLE "run_samples" ADD COLUMN "file_share_run_id" uuid;--> statement-breakpoint
ALTER TABLE "warning_acknowledgements" ADD COLUMN "file_share_id" uuid;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "file_share_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "file_share_catalog" ADD CONSTRAINT "file_share_catalog_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_catalog" ADD CONSTRAINT "file_share_catalog_file_share_id_file_shares_id_fk" FOREIGN KEY ("file_share_id") REFERENCES "public"."file_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_downloads" ADD CONSTRAINT "file_share_downloads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_downloads" ADD CONSTRAINT "file_share_downloads_file_share_id_file_shares_id_fk" FOREIGN KEY ("file_share_id") REFERENCES "public"."file_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_downloads" ADD CONSTRAINT "file_share_downloads_snapshot_id_file_share_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."file_share_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_downloads" ADD CONSTRAINT "file_share_downloads_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_reports" ADD CONSTRAINT "file_share_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_reports" ADD CONSTRAINT "file_share_reports_file_share_id_file_shares_id_fk" FOREIGN KEY ("file_share_id") REFERENCES "public"."file_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_repository_locks" ADD CONSTRAINT "file_share_repository_locks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_repository_locks" ADD CONSTRAINT "file_share_repository_locks_file_share_id_file_shares_id_fk" FOREIGN KEY ("file_share_id") REFERENCES "public"."file_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_run_items" ADD CONSTRAINT "file_share_run_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_run_items" ADD CONSTRAINT "file_share_run_items_run_id_file_share_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."file_share_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_runs" ADD CONSTRAINT "file_share_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_runs" ADD CONSTRAINT "file_share_runs_file_share_id_file_shares_id_fk" FOREIGN KEY ("file_share_id") REFERENCES "public"."file_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_runs" ADD CONSTRAINT "file_share_runs_backup_job_id_backup_jobs_id_fk" FOREIGN KEY ("backup_job_id") REFERENCES "public"."backup_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_runs" ADD CONSTRAINT "file_share_runs_lock_share_id_file_shares_id_fk" FOREIGN KEY ("lock_share_id") REFERENCES "public"."file_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_runs" ADD CONSTRAINT "file_share_runs_target_share_id_file_shares_id_fk" FOREIGN KEY ("target_share_id") REFERENCES "public"."file_shares"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_runs" ADD CONSTRAINT "file_share_runs_source_snapshot_id_file_share_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."file_share_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_runs" ADD CONSTRAINT "file_share_runs_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_samples" ADD CONSTRAINT "file_share_samples_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_samples" ADD CONSTRAINT "file_share_samples_file_share_id_file_shares_id_fk" FOREIGN KEY ("file_share_id") REFERENCES "public"."file_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_samples" ADD CONSTRAINT "file_share_samples_run_id_file_share_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."file_share_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_snapshots" ADD CONSTRAINT "file_share_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_share_snapshots" ADD CONSTRAINT "file_share_snapshots_file_share_id_file_shares_id_fk" FOREIGN KEY ("file_share_id") REFERENCES "public"."file_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_credential_secret_id_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_repository_secret_id_secrets_id_fk" FOREIGN KEY ("repository_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_share_catalog_version_uq" ON "file_share_catalog" USING btree ("file_share_id","path","first_seq");--> statement-breakpoint
CREATE INDEX "file_share_catalog_open_idx" ON "file_share_catalog" USING btree ("file_share_id","end_seq");--> statement-breakpoint
CREATE INDEX "file_share_catalog_name_idx" ON "file_share_catalog" USING btree ("file_share_id",lower("name") text_pattern_ops);--> statement-breakpoint
CREATE INDEX "file_share_downloads_share_idx" ON "file_share_downloads" USING btree ("file_share_id");--> statement-breakpoint
CREATE INDEX "file_share_downloads_expires_idx" ON "file_share_downloads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "file_share_reports_share_checked_idx" ON "file_share_reports" USING btree ("file_share_id","checked_at");--> statement-breakpoint
CREATE INDEX "file_share_reports_tenant_kind_idx" ON "file_share_reports" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "file_share_repository_locks_share_name_uq" ON "file_share_repository_locks" USING btree ("file_share_id","name");--> statement-breakpoint
CREATE INDEX "file_share_run_items_run_code_idx" ON "file_share_run_items" USING btree ("run_id","code");--> statement-breakpoint
CREATE INDEX "file_share_runs_share_created_idx" ON "file_share_runs" USING btree ("file_share_id","created_at");--> statement-breakpoint
CREATE INDEX "file_share_runs_tenant_created_idx" ON "file_share_runs" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "file_share_runs_status_queued_idx" ON "file_share_runs" USING btree ("status","queued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "file_share_runs_lock_active_uq" ON "file_share_runs" USING btree ("lock_share_id") WHERE "file_share_runs"."status" IN ('starting', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "file_share_runs_backup_queued_uq" ON "file_share_runs" USING btree ("file_share_id") WHERE "file_share_runs"."kind" = 'backup' AND "file_share_runs"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "file_share_samples_run_path_uq" ON "file_share_samples" USING btree ("run_id","path");--> statement-breakpoint
CREATE INDEX "file_share_samples_share_snapshot_idx" ON "file_share_samples" USING btree ("file_share_id","snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_share_snapshots_share_sequence_uq" ON "file_share_snapshots" USING btree ("file_share_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "file_share_snapshots_share_restic_uq" ON "file_share_snapshots" USING btree ("file_share_id","restic_snapshot_id");--> statement-breakpoint
CREATE INDEX "file_share_snapshots_tenant_idx" ON "file_share_snapshots" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "file_shares_tenant_idx" ON "file_shares" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_shares_tenant_name_uq" ON "file_shares" USING btree ("tenant_id",lower("name")) WHERE "file_shares"."retired_at" IS NULL;--> statement-breakpoint
CREATE INDEX "file_shares_tenant_retired_idx" ON "file_shares" USING btree ("tenant_id","retired_at");--> statement-breakpoint
ALTER TABLE "run_samples" ADD CONSTRAINT "run_samples_file_share_run_id_file_share_runs_id_fk" FOREIGN KEY ("file_share_run_id") REFERENCES "public"."file_share_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warning_acknowledgements" ADD CONSTRAINT "warning_acknowledgements_file_share_id_file_shares_id_fk" FOREIGN KEY ("file_share_id") REFERENCES "public"."file_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_samples_file_share_run_uq" ON "run_samples" USING btree ("file_share_run_id") WHERE "run_samples"."file_share_run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "warning_acknowledgements_file_share_uq" ON "warning_acknowledgements" USING btree ("file_share_id") WHERE "warning_acknowledgements"."file_share_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "run_samples" ADD CONSTRAINT "run_samples_one_run_ck" CHECK (num_nonnulls("run_samples"."job_id", "run_samples"."endpoint_run_id", "run_samples"."file_share_run_id") = 1);--> statement-breakpoint
ALTER TABLE "warning_acknowledgements" ADD CONSTRAINT "warning_acknowledgements_one_target_ck" CHECK (num_nonnulls("warning_acknowledgements"."protected_object_id", "warning_acknowledgements"."endpoint_id", "warning_acknowledgements"."file_share_id") = 1);--> statement-breakpoint
-- Search by name (docs/FILESHARES.md 8.5): a trigram index where the pg_trgm extension can be
-- created. An external Postgres without the extension, or a migration role without the right to
-- create it, searches with the text_pattern_ops index and ILIKE instead: slower, but correct.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
    RAISE NOTICE 'pg_trgm is not available; file share search uses the text_pattern_ops index';
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "file_share_catalog_name_trgm_idx" ON "file_share_catalog" USING gin (lower("name") gin_trgm_ops)';
  END IF;
END $$;
