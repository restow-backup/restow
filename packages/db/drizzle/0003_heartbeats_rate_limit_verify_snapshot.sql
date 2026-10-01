CREATE TYPE "public"."service_role" AS ENUM('api', 'worker', 'scheduler');--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "service_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "service_role" NOT NULL,
	"instance_id" text NOT NULL,
	"version" text NOT NULL,
	"hostname" text,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_heartbeats_hostname_not_ip" CHECK ("service_heartbeats"."hostname" !~ '^[0-9]{1,3}([.][0-9]{1,3}){3}$' AND strpos("service_heartbeats"."hostname", ':') = 0)
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "entra_object_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "entra_tenant_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "schedule_defaults_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verify_reports" ADD COLUMN "snapshot_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "service_heartbeats_instance_uq" ON "service_heartbeats" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "service_heartbeats_role_beat_idx" ON "service_heartbeats" USING btree ("role","beat_at");--> statement-breakpoint
ALTER TABLE "verify_reports" ADD CONSTRAINT "verify_reports_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_entra_identity_uidx" ON "user" USING btree ("entra_tenant_id","entra_object_id") WHERE "user"."entra_tenant_id" IS NOT NULL AND "user"."entra_object_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "verify_reports_object_snapshot_idx" ON "verify_reports" USING btree ("protected_object_id","snapshot_id");--> statement-breakpoint
-- Hand-written backfill (not generated): link the verification reports written
-- before this migration to the snapshot they checked. Their details name it as
-- `snapshotId` or, in the readiness report format of the verify engine, as
-- `snapshot.id` (preferred in that order). A value counts only when it is a
-- well-formed UUID of a snapshot of the same tenant and protected object;
-- anything else leaves the report unlinked (null), as a pruned snapshot would.
--
-- The tables FORCE Row Level Security (sql/rls.sql), which would hide every row
-- from an owner that is neither superuser nor BYPASSRLS. The flag is lifted for
-- the backfill and restored right after it, inside the migration transaction.
ALTER TABLE "verify_reports" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "snapshots" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "verify_reports" AS "report"
   SET "snapshot_id" = "linked"."snapshot_id"
  FROM (
    SELECT DISTINCT ON ("candidate"."report_id")
           "candidate"."report_id",
           "snapshot"."id" AS "snapshot_id"
      FROM (
        SELECT "id" AS "report_id", "tenant_id", "protected_object_id",
               1 AS "preference", "details" ->> 'snapshotId' AS "value"
          FROM "verify_reports"
         WHERE "snapshot_id" IS NULL
        UNION ALL
        SELECT "id", "tenant_id", "protected_object_id",
               2, "details" -> 'snapshot' ->> 'id'
          FROM "verify_reports"
         WHERE "snapshot_id" IS NULL
      ) AS "candidate"
      JOIN "snapshots" AS "snapshot"
        ON "snapshot"."id" = CASE
             WHEN "candidate"."value" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN "candidate"."value"::uuid
           END
       AND "snapshot"."tenant_id" = "candidate"."tenant_id"
       AND "snapshot"."protected_object_id" = "candidate"."protected_object_id"
     ORDER BY "candidate"."report_id", "candidate"."preference"
  ) AS "linked"
 WHERE "report"."id" = "linked"."report_id";--> statement-breakpoint
ALTER TABLE "snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "verify_reports" FORCE ROW LEVEL SECURITY;
