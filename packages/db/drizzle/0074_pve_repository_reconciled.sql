-- 0.5.0: when the worker last compared a container's restic repository with its restore points
-- (apps/worker pve/maintenance.ts reconcileGuestRepository). A nullable column without a default:
-- no rewrite of pve_guests; null means due, so every container is compared once after the update.
--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "repository_reconciled_at" timestamp with time zone;