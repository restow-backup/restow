-- 0.5.0: the daily size samples of the capacity page (apps/worker storage-samples.ts). A new table,
-- empty at first: no rewrite of any table. Tenant isolation is in sql/rls.sql.
--> statement-breakpoint
CREATE TABLE "storage_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid,
	"day" date NOT NULL,
	"bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_samples_source_day_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","source_kind","source_id","day"),
	CONSTRAINT "storage_samples_kind_ck" CHECK ("storage_samples"."source_kind" IN ('chunk_store', 'endpoint', 'file_share', 'pve_guest')),
	CONSTRAINT "storage_samples_source_ck" CHECK (("storage_samples"."source_kind" = 'chunk_store') = ("storage_samples"."source_id" IS NULL)),
	CONSTRAINT "storage_samples_bytes_ck" CHECK ("storage_samples"."bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "storage_samples" ADD CONSTRAINT "storage_samples_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_samples_day_idx" ON "storage_samples" USING btree ("day");