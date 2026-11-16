-- 0.5.0: the archive's deletion run removed only an item's row. Its chunk references stayed
-- (garbage collection never reclaimed the message), and its sealed record stayed on the primary
-- and every copy, so a "deleted" mail could still be rebuilt. The run now releases the
-- references in the transaction that deletes the row and queues the record here; it then
-- deletes the record on every target and removes the row. A target that refuses (Object Lock,
-- an outage) leaves the row for the next run. A new, empty table under Row Level Security
-- (sql/rls.sql); nothing existing is rewritten.
--> statement-breakpoint
CREATE TABLE "archive_record_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archive_record_deletions" ADD CONSTRAINT "archive_record_deletions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "archive_record_deletions_tenant_item_uq" ON "archive_record_deletions" USING btree ("tenant_id","item_id");--> statement-breakpoint
CREATE INDEX "archive_record_deletions_tenant_created_idx" ON "archive_record_deletions" USING btree ("tenant_id","created_at","id");