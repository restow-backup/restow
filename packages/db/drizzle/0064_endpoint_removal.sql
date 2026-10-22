-- 0.4.5, removing a machine (#65): a revoked machine can be removed from Restow, its backups
-- deleted at once or when its retention lets the newest one go (@restow/db EndpointRemoval).
-- The row stays as a tombstone so the runs, reports and audit entries keep their machine;
-- `removed_at` leaves it out of every list. The worker finds the removals that are due through
-- the partial index (a handful of rows, never the whole table).
--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "removal" jsonb;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "removal_due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "endpoints_removal_due_idx" ON "endpoints" USING btree ("removal_due_at") WHERE "endpoints"."removal_due_at" IS NOT NULL;