-- 0.5.0: a VMID PVE gives to another guest starts a guest row of its own (apps/api
-- pve/node-service.ts reportInventory): the old row is retired (retired_at) and keeps its
-- restore points; only rows that are not retired are unique per cluster and VMID. smbios_uuid
-- tells a VMID that came back as another VM. Two nullable columns, no rewrite; the index is
-- rebuilt once (every existing row is not retired, so it stays unique).
--> statement-breakpoint
DROP INDEX "pve_guests_cluster_vmid_uq";--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "smbios_uuid" text;--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "pve_guests_cluster_vmid_uq" ON "pve_guests" USING btree ("cluster_id","vmid") WHERE "pve_guests"."retired_at" IS NULL;