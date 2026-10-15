-- One-click recommended jobs (#52): the job Restow recommended and made carries a marker, one per
-- tenant and key, so a second click (or two at once) adds to that job instead of making another.
ALTER TABLE "backup_jobs" ADD COLUMN "recommended" text;--> statement-breakpoint
ALTER TABLE "pve_jobs" ADD COLUMN "recommended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_jobs_tenant_recommended_uq" ON "backup_jobs" USING btree ("tenant_id","recommended") WHERE "backup_jobs"."recommended" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pve_jobs_tenant_recommended_uq" ON "pve_jobs" USING btree ("tenant_id") WHERE "pve_jobs"."recommended";