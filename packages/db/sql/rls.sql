-- Restow — Row Level Security and append-only enforcement (PostgreSQL 16).
--
-- Drizzle Kit generates column/table DDL into ./drizzle but does not manage RLS
-- policies or triggers. This file is applied alongside the generated migrations
-- (the @restow/api migrate step runs the generated SQL and then this file, or a
-- copy of it is committed as a migration). It is idempotent.
--
-- Roles (provisioned right after this file by the migration step, src/roles.ts,
-- from the logins in DATABASE_URL and DATABASE_PROVIDER_URL; every process
-- refuses to start when its pools do not match this description):
--   * the application role (DATABASE_URL): NOSUPERUSER, NOBYPASSRLS, owns no
--     table, so it is SUBJECT to RLS. The API opens a transaction per request
--     and pins the tenant before any query:
--
--         BEGIN;
--         SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000';
--         -- ... queries; RLS restricts every row to this tenant ...
--         COMMIT;
--
--     SET LOCAL scopes the setting to the transaction, so a pooled connection
--     never leaks one tenant's id into the next request. A provider admin acting
--     on a tenant sets that tenant's id explicitly — never cross-tenant in one
--     query.
--   * the owner (DATABASE_MIGRATION_URL), which runs the migrations and nothing
--     else, and the installation role (DATABASE_PROVIDER_URL) with BYPASSRLS for
--     installation-level rows (providers, license, settings), provider-scoped
--     rows where tenant_id IS NULL (provider API keys, provider secrets, the
--     installation audit chain) and the lookups made before a tenant is known.
--     Provider access to tenant data goes through the audited restore/provider
--     path.
--
-- current_setting('app.tenant_id', true) returns NULL when unset (missing_ok),
-- and NULLIF(..., '') guards against an empty string so the ::uuid cast is safe.
-- When no tenant is pinned the predicate is NULL, so a request-scoped session
-- sees no rows until it sets app.tenant_id.

-- ---------------------------------------------------------------------------
-- The tenants table isolates on its own primary key (id), not tenant_id.
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_self ON tenants;
CREATE POLICY tenant_isolation_self ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Per-tenant policy template, applied uniformly to every table that carries a
-- tenant_id column. Tables whose tenant_id is nullable (users, user_roles,
-- audit_log, audit_anchor, secrets, api_keys, notifications) intentionally hide
-- their provider-scope (NULL) rows from a tenant-pinned session; those rows are
-- reached only via the BYPASSRLS provider role. Lookups that happen before a
-- tenant is known (API-key authentication, better-auth sessions) run on that
-- role as well; the better-auth tables themselves carry no RLS.
--
-- Keep this list in sync with packages/db/src/schema: schema.test.ts fails when
-- a table with a tenant_id column is missing here.
--
-- Installation-level tables carry no tenant data and no policy: providers,
-- license, settings, service_heartbeats (process liveness, written by the api,
-- worker and scheduler on either role) and the better-auth tables, rate_limit
-- (the auth rate-limit counters) included.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  target_table text;
  tenant_tables text[] := ARRAY[
    'tenant_keys',
    'tenant_contacts',
    'tenant_notification_recipients',
    'secrets',
    'users',
    'user_roles',
    'sources',
    'protected_objects',
    'snapshots',
    'packs',
    'chunks',
    'manifest_objects',
    'jobs',
    'job_progress',
    'item_failures',
    'restore_jobs',
    'verify_reports',
    'schedules',
    'storage_targets',
    'storage_migrations',
    'audit_log',
    'audit_anchor',
    'archive_items',
    'archive_item_mailboxes',
    'archive_anchor',
    'retention_policies',
    'legal_holds',
    'api_keys',
    'webhooks',
    'webhook_deliveries',
    'notifications',
    'report_rules',
    'report_deliveries',
    'import_uploads',
    'import_upload_segments',
    'mail_imports',
    'mail_exports',
    'endpoints',
    'endpoint_enrollment_tokens',
    'endpoint_runs',
    'endpoint_tasks',
    'endpoint_samples',
    'endpoint_reports',
    'endpoint_downloads',
    'endpoint_repository_locks',
    'endpoint_snapshot_flags',
    'backup_jobs',
    'backup_job_members',
    'run_samples',
    'pve_enrollment_tokens',
    'pve_clusters',
    'pve_nodes',
    'pve_jobs',
    'pve_guests',
    'pve_tasks',
    'pve_runs',
    'pve_run_blocks',
    'pve_snapshots',
    -- Read and written only by the installation role (packages/db roles.ts);
    -- the policy is a second line should the tenant role ever be granted it.
    'provider_member_tenants'
  ];
BEGIN
  FOREACH target_table IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', target_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', target_table);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', target_table);
    EXECUTE format(
      $policy$
        CREATE POLICY tenant_isolation ON %I
          USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
          WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
      $policy$,
      target_table
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Append-only / immutable enforcement.
-- The audit log is append-only: a trigger raises on any UPDATE or DELETE so no
-- one — not even an admin — can rewrite history. The same guard protects the
-- immutable archive items and both hash-chain anchor tables (see docs/ARCHIVE.md,
-- archive immutability). Expired archive items are removed only by the retention run,
-- which must run as the BYPASSRLS provider role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION restow_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % is not allowed',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION restow_forbid_mutation();

DROP TRIGGER IF EXISTS audit_anchor_append_only ON audit_anchor;
CREATE TRIGGER audit_anchor_append_only
  BEFORE UPDATE OR DELETE ON audit_anchor
  FOR EACH ROW EXECUTE FUNCTION restow_forbid_mutation();

DROP TRIGGER IF EXISTS archive_items_append_only ON archive_items;
CREATE TRIGGER archive_items_append_only
  BEFORE UPDATE ON archive_items
  FOR EACH ROW EXECUTE FUNCTION restow_forbid_mutation();

-- An item's mailbox assignments are only ever added; they leave with their item or mailbox.
-- Guarded: the migration tests apply this file to databases of older versions without the table.
DO $$
BEGIN
  IF to_regclass('public.archive_item_mailboxes') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS archive_item_mailboxes_append_only ON archive_item_mailboxes;
    CREATE TRIGGER archive_item_mailboxes_append_only
      BEFORE UPDATE ON archive_item_mailboxes
      FOR EACH ROW EXECUTE FUNCTION restow_forbid_mutation();
  END IF;
END $$;

DROP TRIGGER IF EXISTS archive_anchor_append_only ON archive_anchor;
CREATE TRIGGER archive_anchor_append_only
  BEFORE UPDATE OR DELETE ON archive_anchor
  FOR EACH ROW EXECUTE FUNCTION restow_forbid_mutation();
