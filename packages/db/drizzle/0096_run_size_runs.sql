-- 0.5.0: the size and space guard of backup runs, second step (#99). What the guard knows of a
-- run survives the process that measures it (`run_size_runs`: bytes stored so far, an exemption),
-- and a hold can end without an administrator: its object's settings no longer hold it, the
-- target has room again, or the object is gone (three more resolutions). A new table and a
-- replaced check constraint, no rewrite of any table. Tenant isolation of the new table is in
-- sql/rls.sql. Self-contained: the number may change when the branch is merged.
--> statement-breakpoint
CREATE TABLE "run_size_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_kind" text NOT NULL,
	"object_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"written_bytes" bigint DEFAULT 0 NOT NULL,
	"exemption" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_size_runs_kind_ck" CHECK ("run_size_runs"."object_kind" IN ('endpoint', 'file_share', 'pve_guest', 'm365')),
	CONSTRAINT "run_size_runs_exemption_ck" CHECK ("run_size_runs"."exemption" IS NULL OR "run_size_runs"."exemption" IN ('continued', 'new_repository'))
);
--> statement-breakpoint
ALTER TABLE "run_size_holds" DROP CONSTRAINT "run_size_holds_resolution_ck";--> statement-breakpoint
ALTER TABLE "run_size_runs" ADD CONSTRAINT "run_size_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_size_runs_run_uq" ON "run_size_runs" USING btree ("object_kind","run_id");--> statement-breakpoint
CREATE INDEX "run_size_runs_object_idx" ON "run_size_runs" USING btree ("object_kind","object_id","created_at");--> statement-breakpoint
ALTER TABLE "run_size_holds" ADD CONSTRAINT "run_size_holds_resolution_ck" CHECK ("run_size_holds"."resolution" IS NULL OR "run_size_holds"."resolution" IN ('continued', 'limit_raised', 'guard_off', 'settings_changed', 'space_freed', 'object_removed'));