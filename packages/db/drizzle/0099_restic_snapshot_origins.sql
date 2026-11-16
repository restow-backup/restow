-- 0.5.0: promoting a copy target with restic repositories (docs/STORAGE.md, "Promoting a copy").
-- The promotion rewrites the recorded snapshot ids to the copy's; this table keeps restic's
-- persistent id of each, so the other copy targets (which hold the restore point under that id)
-- can still be read and promoted once the promoted primary is lost. A new table only, no rewrite
-- of any table. Tenant isolation of the new table is in sql/rls.sql.
-- Self-contained: the number may change when the branch is merged.
--> statement-breakpoint
CREATE TABLE "restic_snapshot_origins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"persistent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "restic_snapshot_origins" ADD CONSTRAINT "restic_snapshot_origins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "restic_snapshot_origins_uq" ON "restic_snapshot_origins" USING btree ("tenant_id","prefix","snapshot_id");