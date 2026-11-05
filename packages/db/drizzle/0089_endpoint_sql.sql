-- 0.5.0 (W2a, docs/BAREMETAL-WINDOWS.md 5.1 and 6.4): the native SQL Server backup of a Windows
-- machine. One `sql` run per instance makes a copy-only full of each database into a snapshot of
-- its own; `sql_restore` restores one backup under a new name; `sql_verify` restores the newest full
-- from the repository under a check name and runs DBCC CHECKDB on it (report kind `sql_verify`);
-- `sql_inventory` asks the agent for a fresh inventory and finishes on delivery. The enum values
-- come first and nothing here uses them (every migration of a release runs in one transaction).
-- endpoint_sql_databases is one database of one instance (a new family_guid under the same name is
-- another row); endpoint_sql_backups one backup file in the repository, with the chain columns of
-- the second stage (W2b) already here, the SHA-256 and FILELISTONLY of the file for the restore
-- script, and `status` 'pruned' once retention forgot its snapshot. Both are tenant tables
-- (sql/rls.sql). Self-contained: the number may change when the branch is merged.
ALTER TYPE "public"."endpoint_report_kind" ADD VALUE 'sql_verify';--> statement-breakpoint
ALTER TYPE "public"."endpoint_run_kind" ADD VALUE 'sql';--> statement-breakpoint
ALTER TYPE "public"."endpoint_run_kind" ADD VALUE 'sql_restore';--> statement-breakpoint
ALTER TYPE "public"."endpoint_run_kind" ADD VALUE 'sql_verify';--> statement-breakpoint
ALTER TYPE "public"."endpoint_task_kind" ADD VALUE 'sql_restore';--> statement-breakpoint
ALTER TYPE "public"."endpoint_task_kind" ADD VALUE 'sql_verify';--> statement-breakpoint
ALTER TYPE "public"."endpoint_task_kind" ADD VALUE 'sql_inventory';--> statement-breakpoint
CREATE TABLE "endpoint_sql_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" text NOT NULL,
	"copy_only" boolean NOT NULL,
	"restic_snapshot_id" text NOT NULL,
	"path_in_snapshot" text NOT NULL,
	"sha256" text NOT NULL,
	"first_lsn" numeric(25, 0) NOT NULL,
	"last_lsn" numeric(25, 0) NOT NULL,
	"database_backup_lsn" numeric(25, 0),
	"checkpoint_lsn" numeric(25, 0),
	"fork_point_lsn" numeric(25, 0),
	"database_guid" uuid NOT NULL,
	"family_guid" uuid NOT NULL,
	"first_recovery_fork_guid" uuid,
	"last_recovery_fork_guid" uuid,
	"begins_log_chain" boolean DEFAULT false NOT NULL,
	"has_bulk_logged_data" boolean DEFAULT false NOT NULL,
	"backup_start" timestamp with time zone NOT NULL,
	"backup_finish" timestamp with time zone NOT NULL,
	"bytes" bigint NOT NULL,
	"file_list" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compressed" boolean DEFAULT false NOT NULL,
	"checksum" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoint_sql_backups_kind_ck" CHECK ("endpoint_sql_backups"."kind" IN ('full', 'log', 'tail')),
	CONSTRAINT "endpoint_sql_backups_status_ck" CHECK ("endpoint_sql_backups"."status" IN ('active', 'pruned'))
);
--> statement-breakpoint
CREATE TABLE "endpoint_sql_databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"instance" text NOT NULL,
	"database" text NOT NULL,
	"family_guid" uuid NOT NULL,
	"database_guid" uuid NOT NULL,
	"recovery_model" text NOT NULL,
	"mode" text DEFAULT 'alongside' NOT NULL,
	"chain_closed_at" timestamp with time zone,
	"dropped_at" timestamp with time zone,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tde_confirmed_at" timestamp with time zone,
	"tde_confirmed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoint_sql_databases_mode_ck" CHECK ("endpoint_sql_databases"."mode" IN ('alongside', 'own_log_chain', 'off'))
);
--> statement-breakpoint
ALTER TABLE "endpoint_sql_backups" ADD CONSTRAINT "endpoint_sql_backups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_sql_backups" ADD CONSTRAINT "endpoint_sql_backups_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_sql_backups" ADD CONSTRAINT "endpoint_sql_backups_database_id_endpoint_sql_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."endpoint_sql_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_sql_backups" ADD CONSTRAINT "endpoint_sql_backups_run_id_endpoint_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."endpoint_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_sql_databases" ADD CONSTRAINT "endpoint_sql_databases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_sql_databases" ADD CONSTRAINT "endpoint_sql_databases_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "endpoint_sql_backups_chain_idx" ON "endpoint_sql_backups" USING btree ("database_id","first_lsn");--> statement-breakpoint
CREATE INDEX "endpoint_sql_backups_snapshot_idx" ON "endpoint_sql_backups" USING btree ("endpoint_id","restic_snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_sql_databases_uq" ON "endpoint_sql_databases" USING btree ("endpoint_id","instance","database","family_guid");