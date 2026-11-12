-- 0.5.0: when the worker last compared a container's restic repository with its restore points
-- (apps/worker pve/maintenance.ts reconcileGuestRepository). A nullable column without a default:
-- no rewrite of pve_guests; null means due, so every container is compared once after the update.
-- A VMID PVE gives to another guest starts a guest row of its own (apps/api
-- pve/node-service.ts reportInventory): the old row is retired (retired_at) and keeps its
-- restore points; only rows that are not retired are unique per cluster and VMID. smbios_uuid
-- tells a VMID that came back as another VM. Nullable columns, no rewrite; the index is
-- rebuilt once (every existing row is not retired, so it stays unique).
--> statement-breakpoint
DROP INDEX "pve_guests_cluster_vmid_uq";--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "repository_reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "smbios_uuid" text;--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "pve_guests_cluster_vmid_uq" ON "pve_guests" USING btree ("cluster_id","vmid") WHERE "pve_guests"."retired_at" IS NULL;