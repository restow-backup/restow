-- 0.5.0 (#48): the restore explorer's "From the archive" lists one mailbox's mail since its newest
-- backup began (apps/api archive/gap.ts). An index on (tenant, mailbox, capture time) makes the
-- mailbox's own captures an index range instead of a scan of the tenant's archive; the index on
-- the assignments gains their time (tenant, mailbox, created_at) for the same reason, so a mailbox
-- that journal reports or forwarded copies reach by assignment is not read over its whole history
-- (same leading columns, so it replaces the old one for every other lookup). A partial index finds
-- the page's Message-IDs in the newest backup's index, so marking what the backup holds already
-- does not read every mail of the mailbox. Each build reads its table once (manifest_versions: its
-- mail rows) inside the migrator's transaction; new captures and backups wait for it meanwhile,
-- nothing is rewritten.
--
-- `tenants.journal_address_issued_at`: when the journal address was issued or confirmed from 0.5.0
-- on, which is what counts as journaling set up for the menu entry "Archive" (apps/api
-- archive/availability.ts). Null for every address issued before: up to 0.4.12 the tenant page
-- issued it on its first view, also where nobody set up journaling.
--> statement-breakpoint
DROP INDEX "archive_item_mailboxes_object_idx";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "journal_address_issued_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "archive_item_mailboxes_object_created_idx" ON "archive_item_mailboxes" USING btree ("tenant_id","protected_object_id","created_at");--> statement-breakpoint
CREATE INDEX "archive_items_tenant_object_received_idx" ON "archive_items" USING btree ("tenant_id","protected_object_id","received_at");--> statement-breakpoint
CREATE INDEX "manifest_versions_object_message_idx" ON "manifest_versions" USING btree ("protected_object_id","message_id") WHERE "manifest_versions"."message_id" IS NOT NULL;
