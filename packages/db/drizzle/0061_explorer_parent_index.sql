-- The restore explorer's folder listing: the children of one folder of a restore point, the
-- folders among them and the folders further down, read from an index instead of every version
-- row of the mailbox, OneDrive or site (apps/api snapshots/service.ts `versionListingCte`).
-- Paths in byte order (COLLATE "C") whatever the database's collation, so everything below a
-- folder is one index range. The folders get a partial index of their own: under row-level
-- security a condition on the `kind` enum is applied only after the row is read (enum equality
-- is not leakproof), a partial index still applies. Like 0049, each build reads the whole table
-- once inside the migrator's transaction, where Postgres cannot build CONCURRENTLY: writes to
-- manifest_versions wait meanwhile (docs/UPDATING.md).
--> statement-breakpoint
CREATE INDEX "manifest_versions_object_parent_idx" ON "manifest_versions" USING btree ("protected_object_id",("parent_path" COLLATE "C"),"last_sequence");--> statement-breakpoint
CREATE INDEX "manifest_versions_object_folder_idx" ON "manifest_versions" USING btree ("protected_object_id",("parent_path" COLLATE "C"),"last_sequence") WHERE "manifest_versions"."kind" = 'folder';
