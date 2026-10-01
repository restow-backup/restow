ALTER TABLE "protected_objects" ADD COLUMN "credential_failure" jsonb;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "failure" jsonb;--> statement-breakpoint
ALTER TABLE "item_failures" ADD COLUMN "failure" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "failure" jsonb;--> statement-breakpoint
CREATE INDEX "item_failures_job_idx" ON "item_failures" USING btree ("job_id");