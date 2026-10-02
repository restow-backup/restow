CREATE TYPE "public"."backup_job_kind" AS ENUM('mail', 'endpoint');--> statement-breakpoint
CREATE TYPE "public"."backup_job_scope" AS ENUM('all', 'selected');--> statement-breakpoint
CREATE TABLE "backup_job_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"protected_object_id" uuid,
	"endpoint_id" uuid,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"verify_next_run_at" timestamp with time zone,
	"verify_last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_job_members_one_target_ck" CHECK (("backup_job_members"."protected_object_id" IS NOT NULL) <> ("backup_job_members"."endpoint_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "backup_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "backup_job_kind" NOT NULL,
	"name" text NOT NULL,
	"scope_mode" "backup_job_scope" DEFAULT 'selected' NOT NULL,
	"schedule" jsonb,
	"verify_schedule" jsonb,
	"storage_target_id" uuid,
	"retention_policy_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"origin" text DEFAULT 'user' NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"verify_next_run_at" timestamp with time zone,
	"verify_last_run_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "backup_jobs_migrated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "superseded_by_job_id" uuid;--> statement-breakpoint
ALTER TABLE "backup_job_members" ADD CONSTRAINT "backup_job_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_job_members" ADD CONSTRAINT "backup_job_members_job_id_backup_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."backup_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_job_members" ADD CONSTRAINT "backup_job_members_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_job_members" ADD CONSTRAINT "backup_job_members_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_storage_target_id_storage_targets_id_fk" FOREIGN KEY ("storage_target_id") REFERENCES "public"."storage_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_retention_policy_id_retention_policies_id_fk" FOREIGN KEY ("retention_policy_id") REFERENCES "public"."retention_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_job_members_job_idx" ON "backup_job_members" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "backup_job_members_tenant_idx" ON "backup_job_members" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_job_members_object_uq" ON "backup_job_members" USING btree ("protected_object_id") WHERE "backup_job_members"."protected_object_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_job_members_endpoint_uq" ON "backup_job_members" USING btree ("endpoint_id") WHERE "backup_job_members"."endpoint_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "backup_jobs_tenant_kind_idx" ON "backup_jobs" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "backup_jobs_due_idx" ON "backup_jobs" USING btree ("kind","enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_jobs_tenant_kind_name_uq" ON "backup_jobs" USING btree ("tenant_id","kind",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "backup_jobs_tenant_kind_all_uq" ON "backup_jobs" USING btree ("tenant_id","kind") WHERE "backup_jobs"."scope_mode" = 'all';