-- 0.5.0, bare metal M1 (docs/BAREMETAL.md 4.3, 14.2): the layout manifests of whole machine backups,
-- stored once per machine and SHA-256 of their canonical encoding, and the run that recorded one points
-- at it. A new table, empty at first, and a nullable column without a default on endpoint_runs: no
-- rewrite of any table. Tenant isolation is in sql/rls.sql.
--> statement-breakpoint
CREATE TABLE "endpoint_layouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"format" text NOT NULL,
	"schema_version" integer NOT NULL,
	"platform" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"verdict" text NOT NULL,
	"layout_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoint_layouts_platform_ck" CHECK ("endpoint_layouts"."platform" IN ('linux', 'darwin'))
);
--> statement-breakpoint
ALTER TABLE "endpoint_runs" ADD COLUMN "layout_id" uuid;--> statement-breakpoint
ALTER TABLE "endpoint_layouts" ADD CONSTRAINT "endpoint_layouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_layouts" ADD CONSTRAINT "endpoint_layouts_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_layouts_endpoint_sha_uq" ON "endpoint_layouts" USING btree ("endpoint_id","sha256");--> statement-breakpoint
CREATE INDEX "endpoint_layouts_endpoint_created_idx" ON "endpoint_layouts" USING btree ("endpoint_id","created_at");--> statement-breakpoint
ALTER TABLE "endpoint_runs" ADD CONSTRAINT "endpoint_runs_layout_id_endpoint_layouts_id_fk" FOREIGN KEY ("layout_id") REFERENCES "public"."endpoint_layouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "endpoint_runs_layout_idx" ON "endpoint_runs" USING btree ("layout_id") WHERE "endpoint_runs"."layout_id" IS NOT NULL;