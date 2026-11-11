-- 0.5.0: the size and space guard of backup runs (#99, docs/STORAGE.md "Unusually large runs").
-- The runs it held and what an administrator decided, and its settings per tenant and per
-- object. Two new tables only, no rewrite of any table. Tenant isolation of both is in
-- sql/rls.sql. Self-contained: the number may change when the branch is merged.
--> statement-breakpoint
CREATE TABLE "run_size_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_kind" text NOT NULL,
	"object_id" uuid NOT NULL,
	"object_name" text NOT NULL,
	"run_id" uuid,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"bytes" bigint NOT NULL,
	"limit_bytes" bigint,
	"median_bytes" bigint,
	"history_runs" integer DEFAULT 0 NOT NULL,
	"free_bytes" bigint,
	"total_bytes" bigint,
	"refused_runs" integer DEFAULT 0 NOT NULL,
	"last_refused_at" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" text,
	"approved_by" text,
	"note" text,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"consumed_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_size_holds_kind_ck" CHECK ("run_size_holds"."object_kind" IN ('endpoint', 'file_share', 'pve_guest', 'm365')),
	CONSTRAINT "run_size_holds_reason_ck" CHECK ("run_size_holds"."reason" IN ('size', 'space')),
	CONSTRAINT "run_size_holds_status_ck" CHECK ("run_size_holds"."status" IN ('pending', 'approved', 'resolved')),
	CONSTRAINT "run_size_holds_resolution_ck" CHECK ("run_size_holds"."resolution" IS NULL OR "run_size_holds"."resolution" IN ('continued', 'limit_raised', 'guard_off')),
	CONSTRAINT "run_size_holds_note_ck" CHECK ("run_size_holds"."note" IS NULL OR char_length("run_size_holds"."note") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "run_size_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_kind" text,
	"object_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by_user_id" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_size_settings_scope_ck" CHECK (("run_size_settings"."object_kind" IS NULL) = ("run_size_settings"."object_id" IS NULL)),
	CONSTRAINT "run_size_settings_kind_ck" CHECK ("run_size_settings"."object_kind" IS NULL OR "run_size_settings"."object_kind" IN ('endpoint', 'file_share', 'pve_guest', 'm365'))
);
--> statement-breakpoint
ALTER TABLE "run_size_holds" ADD CONSTRAINT "run_size_holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_size_holds" ADD CONSTRAINT "run_size_holds_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_size_settings" ADD CONSTRAINT "run_size_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_size_settings" ADD CONSTRAINT "run_size_settings_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_size_holds_open_uq" ON "run_size_holds" USING btree ("object_kind","object_id") WHERE "run_size_holds"."status" IN ('pending', 'approved');--> statement-breakpoint
CREATE INDEX "run_size_holds_tenant_status_idx" ON "run_size_holds" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_size_settings_tenant_uq" ON "run_size_settings" USING btree ("tenant_id") WHERE "run_size_settings"."object_kind" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "run_size_settings_object_uq" ON "run_size_settings" USING btree ("tenant_id","object_kind","object_id") WHERE "run_size_settings"."object_kind" IS NOT NULL;