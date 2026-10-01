ALTER TABLE "protected_objects" ADD COLUMN "active_since" timestamp with time zone;--> statement-breakpoint
-- Backfill: an object that is active today has, as far as this migration can
-- tell, been protected since it was created (the same value the first-backup
-- grace period used before this column existed). This keeps every existing
-- object's overdue status unchanged at upgrade time; only a future status
-- change moves the clock from here on (see apps/api and apps/worker, which
-- set active_since themselves whenever an object transitions into `active`).
UPDATE "protected_objects" SET "active_since" = "created_at" WHERE "status" = 'active';
