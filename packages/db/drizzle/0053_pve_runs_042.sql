-- Proxmox VE 0.4.2: the Restow server's own VM (found by its SMBIOS UUID at the inventory, or
-- flagged by an admin; backing it up needs a confirmation), the restore checks that wait for a
-- restore point (asked for by an admin, or right after its backup), and the installation's
-- Proxmox VE settings ("check every new restore point right after the backup", default on).
--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "restow_server_detected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "restow_server_flagged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "self_backup_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pve_snapshots" ADD COLUMN "verify_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "pve_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "pve_snapshots_verify_requested_idx" ON "pve_snapshots" USING btree ("verify_requested_at") WHERE "pve_snapshots"."verify_requested_at" IS NOT NULL;