-- 0.4.7: why an orphaned Microsoft 365 object is not backed up while it is still in the
-- directory (account disabled, no licence, OneDrive or site locked), and the admin's
-- confirmation of an object Restow stopped backing up (amber "please confirm" until then, grey
-- "intentionally no longer backed up" after). Nullable columns; the backfill rewrites the
-- orphaned rows only: objects orphaned before this release count as confirmed ('migration'),
-- so an upgrade shows no long amber list and raises no notices for them.
--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "inactive_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "inactive_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "status_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "status_confirmed_by" text;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD CONSTRAINT "protected_objects_status_reason_ck" CHECK ("protected_objects"."status_reason" IS NULL OR "protected_objects"."status_reason" IN ('account_disabled', 'no_license', 'locked'));--> statement-breakpoint
ALTER TABLE "protected_objects" ADD CONSTRAINT "protected_objects_status_confirmed_ck" CHECK (("protected_objects"."status_confirmed_at" IS NULL) = ("protected_objects"."status_confirmed_by" IS NULL));--> statement-breakpoint
UPDATE "protected_objects"
  SET "inactive_since" = "updated_at",
      "inactive_notified_at" = now(),
      "status_confirmed_at" = now(),
      "status_confirmed_by" = 'migration'
  WHERE "status" = 'orphaned';--> statement-breakpoint
CREATE OR REPLACE FUNCTION "protected_objects_inactive_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'orphaned' THEN
    -- Reason, date, notice and confirmation only describe an orphaned object: active or
    -- excluded again (enabled, licensed, unlocked, back in the source) drops them all.
    NEW.status_reason := NULL;
    NEW.inactive_since := NULL;
    NEW.inactive_notified_at := NULL;
    NEW.status_confirmed_at := NULL;
    NEW.status_confirmed_by := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    -- A row created orphaned (imports, tests) keeps what it was given; only the date is due.
    NEW.inactive_since := COALESCE(NEW.inactive_since, now());
  ELSIF OLD.status IS DISTINCT FROM 'orphaned' THEN
    -- A new transition into orphaned: a fresh date, a fresh notice, a fresh confirmation.
    NEW.inactive_since := now();
    IF OLD.status = 'excluded' THEN
      -- Never backed up (admin or rule exclusion): nothing stopped, nothing to confirm.
      NEW.inactive_notified_at := now();
      NEW.status_confirmed_at := now();
      NEW.status_confirmed_by := 'excluded';
    ELSE
      NEW.inactive_notified_at := NULL;
      NEW.status_confirmed_at := NULL;
      NEW.status_confirmed_by := NULL;
    END IF;
  ELSIF NEW.inactive_since IS NULL THEN
    NEW.inactive_since := COALESCE(OLD.inactive_since, now());
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "protected_objects_inactive_state"
  BEFORE INSERT OR UPDATE OF "status", "status_reason", "inactive_since", "inactive_notified_at", "status_confirmed_at", "status_confirmed_by" ON "protected_objects"
  FOR EACH ROW EXECUTE FUNCTION "protected_objects_inactive_state"();
