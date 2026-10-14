-- 0.3.5: the manifest index keeps versions instead of a copy of every object per snapshot.
-- Schema only, so it is instant on any database size: the old per-snapshot rows stay in
-- manifest_objects and the worker folds them into manifest_versions in the background
-- (packages/db/src/manifest-versions.ts). Two of manifest_objects' secondary indexes are
-- dropped here, which returns their disk space at once; the readers only need the
-- per-snapshot one while the conversion runs.
CREATE TABLE "manifest_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"protected_object_id" uuid NOT NULL,
	"first_sequence" integer NOT NULL,
	"last_sequence" integer NOT NULL,
	"content_hash" "bytea" NOT NULL,
	"kind" "manifest_object_kind" NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"parent_path" text DEFAULT '' NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"mtime" timestamp with time zone,
	"item_id" text,
	"message_id" text,
	"chunk_refs" "bytea"[],
	"metadata" jsonb,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manifest_versions_range_ck" CHECK ("manifest_versions"."first_sequence" <= "manifest_versions"."last_sequence")
);
--> statement-breakpoint
DROP INDEX "manifest_objects_tenant_path_idx";--> statement-breakpoint
DROP INDEX "manifest_objects_object_item_idx";--> statement-breakpoint
ALTER TABLE "manifest_versions" ADD CONSTRAINT "manifest_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_versions" ADD CONSTRAINT "manifest_versions_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manifest_versions_object_last_idx" ON "manifest_versions" USING btree ("protected_object_id","last_sequence");--> statement-breakpoint
CREATE INDEX "manifest_versions_object_path_idx" ON "manifest_versions" USING btree ("protected_object_id","path");--> statement-breakpoint
CREATE INDEX "manifest_versions_object_item_idx" ON "manifest_versions" USING btree ("protected_object_id","item_id");