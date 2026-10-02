CREATE TABLE "run_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid,
	"endpoint_run_id" uuid,
	"points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"baseline_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_samples_one_run_ck" CHECK (("run_samples"."job_id" IS NOT NULL) <> ("run_samples"."endpoint_run_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "job_progress" ADD COLUMN "bytes_processed" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_progress" ADD COLUMN "bytes_transferred" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_samples" ADD CONSTRAINT "run_samples_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_samples" ADD CONSTRAINT "run_samples_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_samples" ADD CONSTRAINT "run_samples_endpoint_run_id_endpoint_runs_id_fk" FOREIGN KEY ("endpoint_run_id") REFERENCES "public"."endpoint_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_samples_job_uq" ON "run_samples" USING btree ("job_id") WHERE "run_samples"."job_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "run_samples_endpoint_run_uq" ON "run_samples" USING btree ("endpoint_run_id") WHERE "run_samples"."endpoint_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_tenant_created_idx" ON "jobs" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "jobs_backup_job_idx" ON "jobs" USING btree (("payload"->>'backupJobId'));--> statement-breakpoint
CREATE INDEX "endpoint_reports_run_idx" ON "endpoint_reports" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "endpoint_runs_tenant_created_idx" ON "endpoint_runs" USING btree ("tenant_id","created_at","id");