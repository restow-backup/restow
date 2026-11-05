-- 0.5.0: the chain link of an archive item the deletion run removes after its retention stays,
-- as a tombstone (item id and hash, previous and own chain hash, capture time, position).
-- Before, the run deleted the row and with it the link: the chain check recomputed the next
-- item against a predecessor that was gone and reported tampering from the first legitimate
-- deletion on, for good, and every daily anchor after it no longer matched its position. The
-- check now walks items and tombstones together; a gap without a tombstone is tampering. A new,
-- empty table under Row Level Security, append-only for both roles (sql/rls.sql, roles.ts);
-- nothing existing is rewritten.
--> statement-breakpoint
CREATE TABLE "archive_chain_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"item_hash" text NOT NULL,
	"prev_chain_hash" text,
	"chain_hash" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"item_created_at" timestamp with time zone NOT NULL,
	"retention_until" timestamp with time zone,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archive_chain_tombstones" ADD CONSTRAINT "archive_chain_tombstones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "archive_chain_tombstones_tenant_item_uq" ON "archive_chain_tombstones" USING btree ("tenant_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "archive_chain_tombstones_tenant_chain_hash_uq" ON "archive_chain_tombstones" USING btree ("tenant_id","chain_hash");--> statement-breakpoint
CREATE INDEX "archive_chain_tombstones_tenant_created_idx" ON "archive_chain_tombstones" USING btree ("tenant_id","item_created_at","item_id");