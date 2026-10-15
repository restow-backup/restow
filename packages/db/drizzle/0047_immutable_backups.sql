-- Immutable backups (docs/STORAGE.md, "Immutable backups"): a repository's immutability setting
-- with its history and what the worker last found (renewal, verification), and the deletions a
-- target refused because the object is still locked. Tenant data under Row Level Security.
--> statement-breakpoint
CREATE TABLE "immutability_deferred_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"key" text NOT NULL,
	"retain_until" timestamp with time zone,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_targets" ADD COLUMN "immutability" jsonb;--> statement-breakpoint
ALTER TABLE "storage_targets" ADD COLUMN "immutability_state" jsonb;--> statement-breakpoint
ALTER TABLE "immutability_deferred_deletions" ADD CONSTRAINT "immutability_deferred_deletions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immutability_deferred_deletions" ADD CONSTRAINT "immutability_deferred_deletions_target_id_storage_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."storage_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "immutability_deferred_target_key_uq" ON "immutability_deferred_deletions" USING btree ("target_id","key");--> statement-breakpoint
CREATE INDEX "immutability_deferred_tenant_idx" ON "immutability_deferred_deletions" USING btree ("tenant_id");