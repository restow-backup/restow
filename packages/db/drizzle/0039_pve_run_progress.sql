-- How far a running Proxmox VE backup is (#51): the node reports what it read and uploaded every few
-- seconds while the run goes; null for runs of older nodes and before the first report.
ALTER TABLE "pve_runs" ADD COLUMN "progress" jsonb;
