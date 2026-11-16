-- 0.5.0: restore mode after restoring a database dump (docs/STORAGE.md, "Restore mode and
-- progress markers"). New tables only: the restore mode with its history (installation-level),
-- and, under Row Level Security like every tenant table (sql/rls.sql), the database's progress
-- per tenant (a missing row counts as 0, so no row is written for existing tenants), its last
-- comparison with each storage target, the refused deletion passes and wrapped keys (and sealed
-- repository passwords) in storage that differ from the database. No existing table is changed.
--> statement-breakpoint
CREATE TABLE "installation_restore_mode" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" jsonb NOT NULL,
	"hold_jobs_before" timestamp with time zone NOT NULL,
	"detection" jsonb,
	"ended_at" timestamp with time zone,
	"ended_by" jsonb,
	"checked" text,
	"storage_only_data" text,
	"keep_unknown_before" timestamp with time zone,
	"rebase" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_restore_mode_source" CHECK ("installation_restore_mode"."source" IN ('cli', 'api', 'detected')),
	CONSTRAINT "installation_restore_mode_storage_only_data" CHECK ("installation_restore_mode"."storage_only_data" IS NULL OR "installation_restore_mode"."storage_only_data" IN ('keep', 'release'))
);
--> statement-breakpoint
CREATE TABLE "key_mirror_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"object_key" text,
	"stored_sha256" text NOT NULL,
	"kind" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "key_mirror_findings_kind" CHECK ("key_mirror_findings"."kind" IN ('conflict', 'damaged'))
);
--> statement-breakpoint
CREATE TABLE "restore_mode_refusals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restore_mode_id" uuid NOT NULL,
	"tenant_id" uuid,
	"pass" text NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sample" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restore_mode_refusals_uq" UNIQUE NULLS NOT DISTINCT("restore_mode_id","pass","day","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "storage_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"rebased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_progress_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_id" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"storage_max_seq" bigint,
	"db_seq" bigint NOT NULL,
	"unknown_key_versions" integer[] DEFAULT '{}' NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_progress_checks_outcome" CHECK ("storage_progress_checks"."outcome" IN ('ok', 'ahead', 'unreachable', 'foreign', 'none'))
);
--> statement-breakpoint
ALTER TABLE "key_mirror_findings" ADD CONSTRAINT "key_mirror_findings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_mode_refusals" ADD CONSTRAINT "restore_mode_refusals_restore_mode_id_installation_restore_mode_id_fk" FOREIGN KEY ("restore_mode_id") REFERENCES "public"."installation_restore_mode"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_mode_refusals" ADD CONSTRAINT "restore_mode_refusals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_progress" ADD CONSTRAINT "storage_progress_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_progress_checks" ADD CONSTRAINT "storage_progress_checks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "installation_restore_mode_active_uq" ON "installation_restore_mode" USING btree ("singleton") WHERE "installation_restore_mode"."ended_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "key_mirror_findings_uq" ON "key_mirror_findings" USING btree ("tenant_id","target_id","key_version","stored_sha256");--> statement-breakpoint
CREATE INDEX "key_mirror_findings_open_idx" ON "key_mirror_findings" USING btree ("tenant_id") WHERE "key_mirror_findings"."resolved_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_progress_tenant_uq" ON "storage_progress" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_progress_checks_target_uq" ON "storage_progress_checks" USING btree ("tenant_id","target_id");