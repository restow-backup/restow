-- Boot tests of Proxmox VE restore points (docs/PVE.md, "Boot test"): the newest result per
-- restore point (green only when the restored VM's guest agent answered) and when a guest's last
-- boot test was planned, so a weekly test is not planned again on every pass. The run itself is
-- a pve_runs row of kind 'boot_test' (kind is text; no change needed there).
ALTER TABLE "pve_guests" ADD COLUMN "last_boot_test_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pve_snapshots" ADD COLUMN "boot_test" jsonb;
