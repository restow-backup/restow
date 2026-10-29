-- 0.4.7: why an orphaned Microsoft 365 mailbox is not backed up while its user is still in the
-- directory (account disabled, no licence). Nullable column, no backfill, no rewrite.
--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD CONSTRAINT "protected_objects_status_reason_ck" CHECK ("protected_objects"."status_reason" IS NULL OR "protected_objects"."status_reason" IN ('account_disabled', 'no_license'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "protected_objects_clear_status_reason"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The reason only describes an orphaned object: any other status drops it.
  IF NEW.status <> 'orphaned' THEN
    NEW.status_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "protected_objects_clear_status_reason"
  BEFORE INSERT OR UPDATE OF "status", "status_reason" ON "protected_objects"
  FOR EACH ROW EXECUTE FUNCTION "protected_objects_clear_status_reason"();
