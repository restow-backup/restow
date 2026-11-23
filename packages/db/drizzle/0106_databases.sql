-- 0.6.0, databases D1 (docs/DATABASES.md 2.1, 9): the module "Databases" with its connections, the
-- databases they found and the tests ("Test connection") an executor ran, all tenant-scoped (Row
-- Level Security in sql/rls.sql); credentials stay in `secrets`. The task kind `db_probe` lets an
-- agent run a test. Three new tables, empty at first, and one enum value used by no statement here:
-- nothing is rewritten.
--
-- The module is new, and settings.modules stores the modules that are off (0094): it would be on in
-- every installation that updates. It is switched off there, unless a backup job of the
-- installation (or one of its members) has the native SQL Server backup on, which moves into this
-- module (E3): then it stays on, so nothing that is in use disappears from the menu. An
-- installation without a settings row has not run the setup yet; its wizard asks. backup_jobs and
-- backup_job_members force Row Level Security even for their owner (sql/rls.sql), so the force is
-- lifted for the one statement that reads them and restored right after.
--> statement-breakpoint
ALTER TYPE "public"."endpoint_task_kind" ADD VALUE 'db_probe';--> statement-breakpoint
CREATE TABLE "database_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"engine" text NOT NULL,
	"host" text,
	"port" integer,
	"path" text,
	"login_database" text,
	"executor_kind" text NOT NULL,
	"executor_endpoint_id" uuid,
	"auth_method" text DEFAULT 'password' NOT NULL,
	"credential_secret_id" uuid,
	"allow_unencrypted" boolean DEFAULT false NOT NULL,
	"tls_fingerprint" text,
	"tls_subject" text,
	"tls_issuer" text,
	"tls_not_after" timestamp with time zone,
	"tls_confirmed_at" timestamp with time zone,
	"tls_confirmed_by" text,
	"private_network_approval" jsonb,
	"mode" text DEFAULT 'backup' NOT NULL,
	"schedule" jsonb NOT NULL,
	"retention_policy_id" uuid,
	"selection" jsonb DEFAULT '{"mode":"all","names":[],"exclude":[]}'::jsonb NOT NULL,
	"instance_key" text,
	"instance_identity" jsonb,
	"server_version" text,
	"last_check" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_connections_engine_ck" CHECK ("database_connections"."engine" IN ('postgresql', 'mysql', 'mariadb', 'sqlserver', 'sqlite')),
	CONSTRAINT "database_connections_executor_ck" CHECK ("database_connections"."executor_kind" IN ('agent', 'server')),
	CONSTRAINT "database_connections_auth_ck" CHECK ("database_connections"."auth_method" IN ('password', 'socket')),
	CONSTRAINT "database_connections_mode_ck" CHECK ("database_connections"."mode" IN ('backup', 'pitr', 'warm_copy')),
	CONSTRAINT "database_connections_address_ck" CHECK (CASE WHEN "database_connections"."engine" = 'sqlite' THEN "database_connections"."path" IS NOT NULL AND "database_connections"."host" IS NULL ELSE "database_connections"."host" IS NOT NULL AND "database_connections"."path" IS NULL END),
	CONSTRAINT "database_connections_port_ck" CHECK ("database_connections"."port" IS NULL OR "database_connections"."port" BETWEEN 1 AND 65535),
	CONSTRAINT "database_connections_server_ck" CHECK ("database_connections"."executor_kind" = 'agent' OR ("database_connections"."executor_endpoint_id" IS NULL AND "database_connections"."auth_method" = 'password' AND "database_connections"."engine" IN ('postgresql', 'mysql', 'mariadb')))
);
--> statement-breakpoint
CREATE TABLE "database_probes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid,
	"executor_kind" text NOT NULL,
	"executor_endpoint_id" uuid,
	"spec" jsonb NOT NULL,
	"credential_secret_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error_code" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "database_probes_status_ck" CHECK ("database_probes"."status" IN ('pending', 'running', 'done', 'failed', 'expired')),
	CONSTRAINT "database_probes_executor_ck" CHECK ("database_probes"."executor_kind" IN ('agent', 'server'))
);
--> statement-breakpoint
CREATE TABLE "databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"identity" text,
	"instance_key" text,
	"size_bytes" bigint,
	"accessible" boolean DEFAULT true NOT NULL,
	"dropped_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_executor_endpoint_id_endpoints_id_fk" FOREIGN KEY ("executor_endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_credential_secret_id_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_retention_policy_id_retention_policies_id_fk" FOREIGN KEY ("retention_policy_id") REFERENCES "public"."retention_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_probes" ADD CONSTRAINT "database_probes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_probes" ADD CONSTRAINT "database_probes_connection_id_database_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."database_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_probes" ADD CONSTRAINT "database_probes_executor_endpoint_id_endpoints_id_fk" FOREIGN KEY ("executor_endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_probes" ADD CONSTRAINT "database_probes_credential_secret_id_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_connection_id_database_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."database_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "database_connections_tenant_name_uq" ON "database_connections" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "database_connections_executor_idx" ON "database_connections" USING btree ("executor_endpoint_id");--> statement-breakpoint
CREATE INDEX "database_probes_tenant_created_idx" ON "database_probes" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "database_probes_endpoint_idx" ON "database_probes" USING btree ("executor_endpoint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "databases_connection_name_identity_uq" ON "databases" USING btree ("connection_id",coalesce("instance_key", ''),"name",coalesce("identity", ''));--> statement-breakpoint
CREATE INDEX "databases_tenant_idx" ON "databases" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "backup_jobs" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "backup_job_members" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "settings"
SET "modules" = jsonb_set(
  "modules",
  '{hidden}',
  coalesce("modules" -> 'hidden', '[]'::jsonb) || '["databases"]'::jsonb
)
WHERE NOT (coalesce("modules" -> 'hidden', '[]'::jsonb) ? 'databases')
  AND NOT EXISTS (
    SELECT 1 FROM "backup_jobs" WHERE "backup_jobs"."settings" -> 'sql' ->> 'enabled' = 'true'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "backup_job_members"
    WHERE "backup_job_members"."overrides" -> 'sql' ->> 'enabled' = 'true'
  );--> statement-breakpoint
ALTER TABLE "backup_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "backup_job_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The sealed credentials of a test live as long as the test may use them: a test that is
-- deleted (by its connection, its machine or the cleanup) takes them along, and a machine that
-- is revoked or removed ends its open tests and drops their credentials at once, without
-- waiting for a request of the tenant.
CREATE OR REPLACE FUNCTION restow_drop_database_probe_secret()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM secrets WHERE id = OLD.credential_secret_id AND tenant_id = OLD.tenant_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER database_probes_drop_secret
  AFTER DELETE ON database_probes
  FOR EACH ROW
  WHEN (OLD.credential_secret_id IS NOT NULL)
  EXECUTE FUNCTION restow_drop_database_probe_secret();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION restow_end_endpoint_database_probes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  WITH ended AS (
    UPDATE database_probes p
       SET status = CASE WHEN p.status IN ('pending', 'running') THEN 'expired' ELSE p.status END,
           error_code = CASE WHEN p.status IN ('pending', 'running') THEN 'db_runner_offline' ELSE p.error_code END,
           finished_at = coalesce(p.finished_at, now()),
           credential_secret_id = NULL
      FROM (
        SELECT id, credential_secret_id
          FROM database_probes
         WHERE executor_endpoint_id = NEW.id
           AND tenant_id = NEW.tenant_id
           AND (status IN ('pending', 'running') OR credential_secret_id IS NOT NULL)
         FOR UPDATE
      ) prior
     WHERE p.id = prior.id
    RETURNING prior.credential_secret_id AS secret_id
  )
  DELETE FROM secrets
   WHERE tenant_id = NEW.tenant_id
     AND id IN (SELECT secret_id FROM ended WHERE secret_id IS NOT NULL);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER endpoints_end_database_probes
  AFTER UPDATE OF status, removed_at ON endpoints
  FOR EACH ROW
  WHEN (NEW.status <> 'active' OR NEW.removed_at IS NOT NULL)
  EXECUTE FUNCTION restow_end_endpoint_database_probes();
