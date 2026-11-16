-- 0.5.0: restic repositories split across storage targets (docs/STORAGE.md, "Runs and storage
-- changes", "Repository repair"). Runs record the target their credential was issued for; a
-- container records why its last backup was refused; restore points say why they became
-- unavailable; repository scans and repairs. Nullable columns and a new table only: no rewrite
-- of any table. Tenant isolation of the new table is in sql/rls.sql.
--> statement-breakpoint
CREATE TABLE "storage_repository_repairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"scan_id" uuid,
	"requested_by" text NOT NULL,
	"requested_by_user_id" uuid,
	"result" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_share_runs" ADD COLUMN "storage_target" text;--> statement-breakpoint
ALTER TABLE "file_share_runs" ADD COLUMN "storage_generation" text;--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "repository_problem" jsonb;--> statement-breakpoint
ALTER TABLE "pve_runs" ADD COLUMN "storage_target" text;--> statement-breakpoint
ALTER TABLE "pve_runs" ADD COLUMN "storage_generation" text;--> statement-breakpoint
ALTER TABLE "pve_snapshots" ADD COLUMN "unavailable_reason" text;--> statement-breakpoint
ALTER TABLE "storage_repository_repairs" ADD CONSTRAINT "storage_repository_repairs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_repository_repairs_tenant_idx" ON "storage_repository_repairs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "storage_repository_repairs_queued_idx" ON "storage_repository_repairs" USING btree ("created_at") WHERE "storage_repository_repairs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "storage_repository_repairs_unfinished_uq" ON "storage_repository_repairs" USING btree ("tenant_id") WHERE "storage_repository_repairs"."status" IN ('queued', 'running');