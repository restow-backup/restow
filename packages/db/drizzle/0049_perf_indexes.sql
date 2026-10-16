-- Indexes for large installations (docs/UPDATING.md, 0.4.0): the ransomware judgement reads new
-- restore points by time, the reconciler of left-behind jobs the few active jobs by their pg-boss
-- job, the sidebar and the overviews the Proxmox VE backups that wait for their node. All partial,
-- so they hold only the rows those queries read. The migrator runs in one transaction, which
-- CREATE INDEX CONCURRENTLY cannot: each build holds writes to its table while it reads it once.
--> statement-breakpoint
CREATE INDEX "endpoint_runs_suspicion_idx" ON "endpoint_runs" USING btree ("finished_at","id") WHERE "endpoint_runs"."kind" = 'backup' AND "endpoint_runs"."status" IN ('succeeded', 'partial') AND "endpoint_runs"."snapshot_id" IS NOT NULL AND "endpoint_runs"."finished_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "file_share_runs_suspicion_idx" ON "file_share_runs" USING btree ("finished_at","id") WHERE "file_share_runs"."kind" = 'backup' AND "file_share_runs"."status" IN ('succeeded', 'warning') AND "file_share_runs"."snapshot_id" IS NOT NULL AND "file_share_runs"."finished_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_active_boss_idx" ON "jobs" USING btree ("pg_boss_job_id") WHERE "jobs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "jobs_suspicion_idx" ON "jobs" USING btree ("completed_at","id") WHERE "jobs"."queue" = 'backup' AND "jobs"."status" = 'completed' AND "jobs"."protected_object_id" IS NOT NULL AND "jobs"."completed_at" IS NOT NULL AND ("jobs"."payload"->'result'->>'snapshotId') IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pve_runs_suspicion_idx" ON "pve_runs" USING btree ("finished_at","id") WHERE "pve_runs"."kind" = 'backup' AND "pve_runs"."status" = 'succeeded' AND "pve_runs"."snapshot_id" IS NOT NULL AND "pve_runs"."finished_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pve_tasks_open_backup_idx" ON "pve_tasks" USING btree ("guest_id") WHERE "pve_tasks"."kind" = 'backup' AND "pve_tasks"."status" IN ('pending', 'delivered');