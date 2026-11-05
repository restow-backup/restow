-- 0.5.0: under the journal's 'keep' policy every report became an item of its own, so a report
-- Exchange sent again because our 250 was lost (or came after its timeout) was archived twice.
-- A journal item now keeps the hash of its report as delivered, transport fields left out
-- (@restow/core archive/identity.ts journalReportHash); the same report again finds its item and
-- is answered without a second one. Unique per tenant, so two concurrent deliveries of one
-- report cannot both commit. Null for other sources and for items received before.
--> statement-breakpoint
ALTER TABLE "archive_items" ADD COLUMN "report_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "archive_items_tenant_report_hash_uq" ON "archive_items" USING btree ("tenant_id","report_hash") WHERE "archive_items"."report_hash" IS NOT NULL;