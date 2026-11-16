-- 0.5.0: write-once (WORM) storage (docs/STORAGE.md, "Write-once storage"). A container or a
-- file share whose new chain could not clear its old prefix records the fresh prefix it began
-- under; the installation default records the write-once finding of its newest probe (a tenant
-- target keeps it with its last probe in `storage_targets.config`). Nullable columns only: no
-- rewrite of any table.
--> statement-breakpoint
ALTER TABLE "file_shares" ADD COLUMN "repository_prefix" text;--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "repository_prefix" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "default_storage_write_once" jsonb;
