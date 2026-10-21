-- Stopping backups from the UI and updating nodes and agents with the server (0.4.2,
-- docs/PVE.md, docs/AGENT.md, docs/UPDATING.md): cancel requests on the tasks and runs of
-- Proxmox VE nodes and endpoint agents (with who asked), the end state `cancelled` for agent runs
-- and tasks, a paused queue and "update now" per node, "update now" per machine, and the phase
-- `fleet` of the job-start pause (the server is updated, nodes and agents follow, at most 15 min).
--> statement-breakpoint
ALTER TYPE "public"."endpoint_run_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TYPE "public"."endpoint_task_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "job_start_pause" DROP CONSTRAINT "job_start_pause_phase";--> statement-breakpoint
ALTER TABLE "endpoint_runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "endpoint_runs" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "endpoint_tasks" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "endpoint_tasks" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "update_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pve_nodes" ADD COLUMN "queue_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pve_nodes" ADD COLUMN "queue_paused_by" text;--> statement-breakpoint
ALTER TABLE "pve_nodes" ADD COLUMN "update_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pve_runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pve_runs" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "pve_tasks" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pve_tasks" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
CREATE INDEX "endpoint_runs_cancelling_idx" ON "endpoint_runs" USING btree ("endpoint_id") WHERE "endpoint_runs"."status" = 'running' AND "endpoint_runs"."cancel_requested_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pve_runs_cancelling_idx" ON "pve_runs" USING btree ("node_id") WHERE "pve_runs"."status" = 'running' AND "pve_runs"."cancel_requested_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "job_start_pause" ADD CONSTRAINT "job_start_pause_phase" CHECK ("job_start_pause"."phase" IN ('draining', 'announced', 'fleet'));