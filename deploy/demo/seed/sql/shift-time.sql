-- Restow public demo: make a restored template look as fresh as a new seed
-- (deploy/demo/README.md, "Fast reset").
--
-- A template is the database (and the volumes) right after a full seed. The
-- seed moved its history back so that it ends at the moment it ran
-- (seed/src/backdate.ts); restored days later, that history would end days
-- ago: "last backup 3 days ago", charts whose last days are empty. This script
-- moves every system time of the database forward by the age of the template,
-- now() minus the moment it was taken, so the restored demo shows exactly what
-- it showed right after its seed: the same "last backup 12 minutes ago", the
-- same 30 days of history, ending today. Times that lie ahead (expiry dates,
-- next runs) move with everything else, so what was valid for another hour
-- still is.
--
-- Run by deploy/demo/reset.sh as the database owner (the bootstrap superuser of
-- the demo's postgres container), after pg_restore and before any Restow
-- service starts, with the template's moment in the custom setting
-- restow_demo.template_epoch (Unix seconds, fractions allowed):
--
--   PGOPTIONS="-c restow_demo.template_epoch=<seconds>" psql -v ON_ERROR_STOP=1 -f shift-time.sql
--
-- Which columns move: every `timestamp` and `timestamptz` column of every
-- table in schema public, found in the catalog when it runs, so a table a
-- later release adds is covered without a change here and a table an older
-- release lacks is simply not there. This is a superset of what the seed's
-- backdate step moves (backdate.ts RUN_TABLES, FIRST_RUN_TABLES,
-- ENDPOINT_RUN_TABLES; seed/src/shift-time.pg.test.ts checks it), because a
-- restored template has to move everything the UI shows as a time, not only
-- the rows of the history. Not moved:
--
--   - audit_log, audit_anchor: the audit log stays truthful. It keeps the real
--     moment of every seed action (the template's day, at most
--     RESTOW_DEMO_TEMPLATE_MAX_AGE_DAYS ago); it is append-only anyway (a
--     trigger refuses updates).
--   - archive_*: the mail archive is append-only and each item's chain hash
--     covers its moment of capture; moving it would break the chain. Its items
--     keep the template's day as their capture time, as backdate.ts keeps
--     the seed's day.
--   - license: a signed license carries its own dates.
--   - session, verification: sign-ins and one-time codes are not moved but
--     deleted; visitors sign in again with the demo account shown on the
--     sign-in page, as after a full seed.
--   - times that belong to the backed-up data, not to the system: a file's
--     modification time (manifest_objects.mtime, manifest_versions.mtime,
--     file_share_catalog.mtime), a mail's date (item_failures.item_date), and
--     the times restic writes into a snapshot, which live in the repository
--     and cannot be moved (endpoint_snapshot_flags.snapshot_time,
--     file_share_snapshots.snapshot_time, pve_snapshots.backup_at). This is
--     why reset.sh seeds from scratch once a template is older than
--     RESTOW_DEMO_TEMPLATE_MAX_AGE_DAYS: a machine's snapshot list reads those
--     restic times.
--
-- One transaction: either everything moves or nothing does (reset.sh then
-- falls back to a full seed). Leaves nothing behind but the moved rows; the
-- plan is a temporary function (pg_temp) that ends with the session, so the
-- test can read it back.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.restow_demo_shift_plan()
RETURNS TABLE (table_name text, columns text[])
LANGUAGE sql STABLE AS $plan$
  SELECT c.relname::text,
         array_agg(a.attname::text ORDER BY a.attnum)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE n.nspname = 'public'
     -- Plain and partitioned tables; a partition moves with its parent.
     AND c.relkind IN ('r', 'p')
     AND NOT c.relispartition
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND a.attgenerated = ''
     AND a.atttypid IN ('timestamp with time zone'::regtype, 'timestamp without time zone'::regtype)
     AND c.relname NOT IN ('audit_log', 'audit_anchor', 'license', 'session', 'verification')
     AND c.relname NOT LIKE 'archive\_%'
     AND (c.relname || '.' || a.attname) NOT IN (
       'manifest_objects.mtime',
       'manifest_versions.mtime',
       'file_share_catalog.mtime',
       'item_failures.item_date',
       'endpoint_snapshot_flags.snapshot_time',
       'file_share_snapshots.snapshot_time',
       'pve_snapshots.backup_at'
     )
   GROUP BY c.relname
   ORDER BY c.relname
$plan$;

DO $shift$
DECLARE
  setting text := current_setting('restow_demo.template_epoch', true);
  taken timestamptz;
  shift interval;
  item record;
  assignments text;
  moved bigint;
  tables integer := 0;
  total bigint := 0;
  removed bigint;
BEGIN
  IF setting IS NULL OR setting !~ '^[0-9]+(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'restow_demo.template_epoch is not set to the Unix time the template was taken (got %)', coalesce(setting, 'nothing');
  END IF;
  taken := to_timestamp(setting::double precision);
  shift := now() - taken;
  -- A template from the future means a wrong clock or a wrong value; moving
  -- the demo into the past by more than a little is refused, not done.
  IF shift < interval '-1 hour' THEN
    RAISE EXCEPTION 'the template was taken at %, after now (%): refusing to move the demo back in time', taken, now();
  END IF;

  FOR item IN SELECT * FROM pg_temp.restow_demo_shift_plan() LOOP
    SELECT string_agg(format('%1$I = %1$I + $1', column_name), ', ')
      INTO assignments
      FROM unnest(item.columns) AS column_name;
    EXECUTE format('UPDATE %I SET %s', item.table_name, assignments) USING shift;
    GET DIAGNOSTICS moved = ROW_COUNT;
    tables := tables + 1;
    total := total + moved;
    IF moved > 0 THEN
      RAISE NOTICE 'restow-demo shift: % (% rows): %', item.table_name, moved, array_to_string(item.columns, ', ');
    END IF;
  END LOOP;

  -- Time-bound sign-ins and codes of the seed: gone, not moved.
  removed := 0;
  IF to_regclass('public.session') IS NOT NULL THEN
    DELETE FROM session;
    GET DIAGNOSTICS moved = ROW_COUNT;
    removed := removed + moved;
  END IF;
  IF to_regclass('public.verification') IS NOT NULL THEN
    DELETE FROM verification;
    GET DIAGNOSTICS moved = ROW_COUNT;
    removed := removed + moved;
  END IF;

  RAISE NOTICE 'restow-demo shift: moved % rows of % tables forward by % (template taken %); removed % sign-ins and codes',
    total, tables, shift, taken, removed;
END
$shift$;

COMMIT;
