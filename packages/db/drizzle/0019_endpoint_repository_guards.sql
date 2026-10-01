CREATE TABLE "endpoint_repository_locks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoint_snapshot_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"snapshot_id" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"snapshot_time" timestamp with time zone,
	"stored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"alerted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "repository_bytes" bigint;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "repository_measured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "quota_refused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "quota_alert_level" text;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "quota_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "maintenance_locked_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "maintenance_locked_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "locked_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "endpoint_repository_locks" ADD CONSTRAINT "endpoint_repository_locks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_repository_locks" ADD CONSTRAINT "endpoint_repository_locks_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_snapshot_flags" ADD CONSTRAINT "endpoint_snapshot_flags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_snapshot_flags" ADD CONSTRAINT "endpoint_snapshot_flags_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_repository_locks_endpoint_name_uq" ON "endpoint_repository_locks" USING btree ("endpoint_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_snapshot_flags_endpoint_snapshot_uq" ON "endpoint_snapshot_flags" USING btree ("endpoint_id","snapshot_id");--> statement-breakpoint
CREATE INDEX "endpoint_snapshot_flags_tenant_idx" ON "endpoint_snapshot_flags" USING btree ("tenant_id","created_at");--> statement-breakpoint
-- Snapshot ids are lower case from 0.1.1 on (restic and the agent know no other form). A
-- restore or restore-test task that still waits for its machine with an id an admin typed
-- in upper case would fail there with invalid_task; ids stored elsewhere are made to match.
-- The tables FORCE Row Level Security (sql/rls.sql), which would hide every row from an
-- owner that is neither superuser nor BYPASSRLS: the flag is lifted for the update and
-- restored right after it, inside the migration transaction.
ALTER TABLE "endpoint_tasks" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "endpoint_runs" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "endpoints" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "endpoint_tasks"
   SET "params" = jsonb_set("params", '{snapshotId}', to_jsonb(lower("params" ->> 'snapshotId')))
 WHERE "status" IN ('pending', 'delivered')
   AND "params" ? 'snapshotId'
   AND "params" ->> 'snapshotId' <> lower("params" ->> 'snapshotId');--> statement-breakpoint
UPDATE "endpoint_runs" SET "snapshot_id" = lower("snapshot_id")
 WHERE "snapshot_id" <> lower("snapshot_id");--> statement-breakpoint
UPDATE "endpoints" SET "last_snapshot_id" = lower("last_snapshot_id")
 WHERE "last_snapshot_id" <> lower("last_snapshot_id");--> statement-breakpoint
ALTER TABLE "endpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "endpoint_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "endpoint_tasks" FORCE ROW LEVEL SECURITY;
