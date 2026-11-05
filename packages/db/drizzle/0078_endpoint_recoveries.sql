-- 0.5.0, bare metal M3 (docs/BAREMETAL.md 9, 11, 14.2): recovery codes and the sessions the recovery
-- ISO exchanges them for (only hashes of the code proof and of the session secret, at most 48 hours
-- after issue), their logs, rebind tokens in endpoint_enrollment_tokens (the machine they rebind, a
-- purpose, whether they may bring a revoked machine back; at most 24 hours), and the mark of the first
-- backup after a rebind on endpoint_runs. Two new tables, empty at first; the new columns are nullable
-- or carry a constant default, so no table is rewritten. Tenant isolation is in sql/rls.sql.
--> statement-breakpoint
CREATE TYPE "public"."endpoint_recovery_kind" AS ENUM('code');--> statement-breakpoint
CREATE TYPE "public"."endpoint_recovery_status" AS ENUM('issued', 'pending_approval', 'active', 'finishing', 'succeeded', 'failed', 'cancelled', 'expired', 'revoked');--> statement-breakpoint
CREATE TABLE "endpoint_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"kind" "endpoint_recovery_kind" NOT NULL,
	"status" "endpoint_recovery_status" DEFAULT 'issued' NOT NULL,
	"code_hash" text,
	"instance_origin" text,
	"spki_sha256" text,
	"require_approval" boolean DEFAULT true NOT NULL,
	"snapshot_id" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"used_at" timestamp with time zone,
	"used_ip" text,
	"session_secret_hash" text,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"credentials_issued_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"recovery_version" text,
	"hardware" jsonb,
	"ssh_keys" jsonb,
	"ssh_host_keys" jsonb,
	"progress" jsonb,
	"verification" jsonb,
	"warnings" jsonb,
	"log_bytes" integer DEFAULT 0 NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoint_recoveries_max_48h" CHECK ("endpoint_recoveries"."expires_at" <= "endpoint_recoveries"."issued_at" + interval '48 hours')
);
--> statement-breakpoint
CREATE TABLE "endpoint_recovery_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recovery_id" uuid NOT NULL,
	"lines" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "endpoint_enrollment_tokens" ADD COLUMN "endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "endpoint_enrollment_tokens" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "endpoint_enrollment_tokens" ADD COLUMN "unrevoke" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "endpoint_runs" ADD COLUMN "activity_baseline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "endpoint_recoveries" ADD CONSTRAINT "endpoint_recoveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_recoveries" ADD CONSTRAINT "endpoint_recoveries_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_recoveries" ADD CONSTRAINT "endpoint_recoveries_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_recoveries" ADD CONSTRAINT "endpoint_recoveries_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_recoveries" ADD CONSTRAINT "endpoint_recoveries_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_recovery_log" ADD CONSTRAINT "endpoint_recovery_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_recovery_log" ADD CONSTRAINT "endpoint_recovery_log_recovery_id_endpoint_recoveries_id_fk" FOREIGN KEY ("recovery_id") REFERENCES "public"."endpoint_recoveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_recoveries_code_uq" ON "endpoint_recoveries" USING btree ("code_hash") WHERE "endpoint_recoveries"."code_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "endpoint_recoveries_endpoint_idx" ON "endpoint_recoveries" USING btree ("endpoint_id","issued_at");--> statement-breakpoint
CREATE INDEX "endpoint_recoveries_active_idx" ON "endpoint_recoveries" USING btree ("endpoint_id") WHERE "endpoint_recoveries"."status" IN ('active', 'finishing');--> statement-breakpoint
CREATE INDEX "endpoint_recovery_log_recovery_idx" ON "endpoint_recovery_log" USING btree ("recovery_id","created_at","id");--> statement-breakpoint
ALTER TABLE "endpoint_enrollment_tokens" ADD CONSTRAINT "endpoint_enrollment_tokens_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_enrollment_tokens" ADD CONSTRAINT "endpoint_enrollment_tokens_purpose_ck" CHECK ("endpoint_enrollment_tokens"."purpose" IS NULL OR "endpoint_enrollment_tokens"."purpose" IN ('baremetal', 'reinstall', 'mac_setup'));--> statement-breakpoint
ALTER TABLE "endpoint_enrollment_tokens" ADD CONSTRAINT "endpoint_enrollment_tokens_rebind_24h" CHECK ("endpoint_enrollment_tokens"."endpoint_id" IS NULL OR "endpoint_enrollment_tokens"."expires_at" <= "endpoint_enrollment_tokens"."created_at" + interval '24 hours');