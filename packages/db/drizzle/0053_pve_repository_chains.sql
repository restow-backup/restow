-- A container's repository can begin a new backup chain (docs/PVE.md, "New backup chain"):
-- when a backup finds it missing on the primary target, or when an administrator resets it.
-- The guest keeps the last chain changes; the restore points of the chain before become
-- `unavailable` (pve_snapshots.status, text) with the time they did.
--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "repository_chains" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pve_snapshots" ADD COLUMN "unavailable_at" timestamp with time zone;