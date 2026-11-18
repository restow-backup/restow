-- 0.6.0, databases D3 (docs/DATABASES.md 4.3, 4.4, 5.5, 16 "D3"): backup and restore runs of the
-- database connections. Two new tenant tables (Row Level Security in sql/rls.sql):
-- `database_runs` (a backup or a restore, at most one queued or running per connection) and
-- `database_backups` (one restic snapshot per database and run, or the instance's globals); each
-- connection gets its own repository password (`repository_secret_id`). The task kinds
-- `db_backup` and `db_restore` hand an agent its runs. New tables, enum values used by no
-- statement here and two columns without a default: nothing is rewritten.
--> statement-breakpoint
ALTER TYPE "public"."endpoint_task_kind" ADD VALUE 'db_backup';--> statement-breakpoint
ALTER TYPE "public"."endpoint_task_kind" ADD VALUE 'db_restore';--> statement-breakpoint
CREATE TABLE "database_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"run_id" uuid,
	"database_id" uuid,
	"kind" text DEFAULT 'database' NOT NULL,
	"database_name" text NOT NULL,
	"identity" text,
	"instance_key" text,
	"snapshot_id" text NOT NULL,
	"file_name" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" bigint NOT NULL,
	"objects" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_version" text,
	"server_version" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pruned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_backups_kind_ck" CHECK ("database_backups"."kind" IN ('database', 'globals')),
	CONSTRAINT "database_backups_status_ck" CHECK ("database_backups"."status" IN ('active', 'pruned')),
	CONSTRAINT "database_backups_bytes_ck" CHECK ("database_backups"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "database_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"executor_kind" text NOT NULL,
	"executor_endpoint_id" uuid,
	"requested_by" text,
	"fetched_at" timestamp with time zone,
	"token_hash" text,
	"source_backup_id" uuid,
	"target_connection_id" uuid,
	"target_name" text,
	"target_oid" text,
	"error_code" text,
	"error_message" text,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_runs_kind_ck" CHECK ("database_runs"."kind" IN ('backup', 'restore')),
	CONSTRAINT "database_runs_trigger_ck" CHECK ("database_runs"."trigger" IN ('schedule', 'manual')),
	CONSTRAINT "database_runs_status_ck" CHECK ("database_runs"."status" IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
	CONSTRAINT "database_runs_executor_ck" CHECK ("database_runs"."executor_kind" IN ('agent', 'server'))
);
--> statement-breakpoint
ALTER TABLE "database_connections" ADD COLUMN "repository_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "database_connections" ADD COLUMN "repository_initialized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "database_connections" ADD COLUMN "retention_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "database_backups" ADD CONSTRAINT "database_backups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_backups" ADD CONSTRAINT "database_backups_connection_id_database_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."database_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_backups" ADD CONSTRAINT "database_backups_run_id_database_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."database_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_backups" ADD CONSTRAINT "database_backups_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_runs" ADD CONSTRAINT "database_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_runs" ADD CONSTRAINT "database_runs_connection_id_database_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."database_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_runs" ADD CONSTRAINT "database_runs_executor_endpoint_id_endpoints_id_fk" FOREIGN KEY ("executor_endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_runs" ADD CONSTRAINT "database_runs_target_connection_id_database_connections_id_fk" FOREIGN KEY ("target_connection_id") REFERENCES "public"."database_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_backups_database_finished_idx" ON "database_backups" USING btree ("database_id","finished_at");--> statement-breakpoint
CREATE INDEX "database_backups_connection_finished_idx" ON "database_backups" USING btree ("connection_id","finished_at");--> statement-breakpoint
CREATE UNIQUE INDEX "database_backups_connection_snapshot_uq" ON "database_backups" USING btree ("connection_id","snapshot_id");--> statement-breakpoint
CREATE INDEX "database_runs_connection_created_idx" ON "database_runs" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "database_runs_one_active_uq" ON "database_runs" USING btree ("connection_id") WHERE "database_runs"."status" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_repository_secret_id_secrets_id_fk" FOREIGN KEY ("repository_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;