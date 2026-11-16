-- 0.5.0: the keyed record a job keeps beside its cursor (core CursorStore.putEntries), first used
-- for a restore's per-item progress (core restore/progress.ts). One row per entry: a batch writes
-- only what it holds, where one growing jobs.cursor value was rewritten whole on every save. A new
-- table, empty at first: no rewrite of any table. Tenant isolation is in sql/rls.sql. The trigger
-- drops a job's entries when the job reaches a final status, on every path that ends a job (the
-- worker, the reconciler, a cancel through the API).
--> statement-breakpoint
CREATE TABLE "job_cursor_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_cursor_entries" ADD CONSTRAINT "job_cursor_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cursor_entries" ADD CONSTRAINT "job_cursor_entries_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_cursor_entries_job_key_uq" ON "job_cursor_entries" USING btree ("job_id","key");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION restow_drop_job_cursor_entries()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM job_cursor_entries WHERE job_id = NEW.id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER jobs_drop_cursor_entries
  AFTER UPDATE OF status ON jobs
  FOR EACH ROW
  WHEN (NEW.status IN ('completed', 'failed', 'cancelled') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION restow_drop_job_cursor_entries();
