-- 0.5.0: the size check of backup runs warns by default (#99, maintainer decision). A run past
-- its size limit whose object is in `warn` mode goes on; the notice it raised once is kept on the
-- run (`noticed_at`, `notice`: object name, bytes written, limit, usual size) for Warnings. Two
-- nullable columns and a partial index: no rewrite of the table.
-- Self-contained: the number may change when the branch is merged.
--> statement-breakpoint
ALTER TABLE "run_size_runs" ADD COLUMN "noticed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_size_runs" ADD COLUMN "notice" jsonb;--> statement-breakpoint
CREATE INDEX "run_size_runs_notice_idx" ON "run_size_runs" USING btree ("tenant_id","noticed_at") WHERE "run_size_runs"."noticed_at" IS NOT NULL;