-- 0.4.8: an IMAP account whose login keeps being refused. The object stays active and red; the
-- worker counts refused password logins in six new columns, an open question "was this account
-- shut down?" follows after 3 counted failures over 24 h, and only the admin's "Yes" sets the
-- state: orphaned with the reason 'login_refused', confirmed at once. The check
-- protected_objects_login_refused_ck makes the reason impossible without an IMAP kind, the
-- orphaned status, an admin's confirmation (not the 'excluded' or 'migration' one the trigger
-- writes itself) and a next probe date, so no worker, scheduler or sync can set it and the
-- planner can never lose the account. No backfill:
-- existing rows get 0 / NULL, nothing is asked after the update until logins fail again.
--> statement-breakpoint
ALTER TABLE "protected_objects" DROP CONSTRAINT "protected_objects_status_reason_ck";--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "login_failed_runs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "login_failed_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "login_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "login_question_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "login_question_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "login_probe_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD CONSTRAINT "protected_objects_login_refused_ck" CHECK ("protected_objects"."status_reason" IS DISTINCT FROM 'login_refused' OR ("protected_objects"."kind" = 'imap' AND "protected_objects"."status" = 'orphaned' AND "protected_objects"."status_confirmed_at" IS NOT NULL AND "protected_objects"."status_confirmed_by" NOT IN ('excluded', 'migration') AND "protected_objects"."login_probe_due_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "protected_objects" ADD CONSTRAINT "protected_objects_login_question_ck" CHECK ("protected_objects"."login_question_dismissed_at" IS NULL OR "protected_objects"."login_question_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "protected_objects" ADD CONSTRAINT "protected_objects_login_failed_runs_ck" CHECK ("protected_objects"."login_failed_runs" >= 0);--> statement-breakpoint
ALTER TABLE "protected_objects" ADD CONSTRAINT "protected_objects_status_reason_ck" CHECK ("protected_objects"."status_reason" IS NULL OR "protected_objects"."status_reason" IN ('account_disabled', 'no_license', 'locked', 'login_refused'));--> statement-breakpoint
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
    ELSIF NEW.status_reason = 'login_refused' THEN
      -- An IMAP account the admin confirmed as shut down (the answer "Yes" to the login
      -- question): the writer gives the confirmation, nothing is left to notify, and the first
      -- login probe is due in a week unless the writer said otherwise.
      NEW.inactive_notified_at := now();
      NEW.login_probe_due_at := COALESCE(NEW.login_probe_due_at, now() + interval '7 days');
    ELSE
      NEW.inactive_notified_at := NULL;
      NEW.status_confirmed_at := NULL;
      NEW.status_confirmed_by := NULL;
    END IF;
  ELSIF NEW.inactive_since IS NULL THEN
    NEW.inactive_since := COALESCE(OLD.inactive_since, now());
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT (NEW.status = 'orphaned' AND NEW.status_reason IS NOT DISTINCT FROM 'login_refused') THEN
    -- The login streak, the question and the probe date only describe an account that is active
    -- and failing or shut down because of it: any other status change (reactivation, an admin
    -- excluding the account, also while a question is open) starts from zero.
    NEW.login_failed_runs := 0;
    NEW.login_failed_since := NULL;
    NEW.login_failed_at := NULL;
    NEW.login_question_at := NULL;
    NEW.login_question_dismissed_at := NULL;
    NEW.login_probe_due_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
