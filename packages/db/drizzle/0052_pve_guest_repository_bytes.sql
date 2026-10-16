-- The bytes the restic repository of a Proxmox VE container takes (pve-guests/<guestId>/):
-- measured once on the next backup, then counted with every upload and measured again after
-- a prune; null until first measured. Counted in the tenant's stored bytes.
--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "repository_bytes" bigint;--> statement-breakpoint
ALTER TABLE "pve_guests" ADD COLUMN "repository_measured_at" timestamp with time zone;
