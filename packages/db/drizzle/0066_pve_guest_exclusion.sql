-- 0.4.7: an administrator can exclude a Proxmox VE guest from backup (docs/PVE.md, "Excluding a
-- guest"). Two nullable columns, no rewrite of the table.
--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "excluded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "excluded_by" text;