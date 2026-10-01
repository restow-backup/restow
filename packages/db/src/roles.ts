/**
 * The database roles Restow runs on, and the check that they are what they
 * claim to be (sql/rls.sql, docs/ARCHITECTURE.md, tenant isolation).
 *
 *   owner         runs the migrations and owns every table. Used by nothing else.
 *   tenant        the application role (DATABASE_URL): NOSUPERUSER, NOBYPASSRLS,
 *                 owns no table. All tenant work runs on it inside a transaction
 *                 pinned with `app.tenant_id`, so Row Level Security decides which
 *                 rows exist; a query that forgets its tenant filter sees nothing
 *                 of another tenant.
 *   installation  BYPASSRLS (DATABASE_PROVIDER_URL): the few lookups made before a
 *                 tenant is known (session, API key, tenant list), installation-level
 *                 data (settings, provider secrets, the installation audit
 *                 chain) and the cross-tenant background scans. It also owns the
 *                 pg-boss queue schema.
 *
 * Roles are provisioned by the migration step (./migrate.ts) from the login in
 * the tenant and installation connection strings, and every process checks
 * its pools at startup with {@link assertDatabaseRoles}: a tenant pool that can
 * bypass RLS would make every policy decorative, so the process refuses to run.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

/** Anything that can run a parameterised query: a pg Pool, PoolClient or Client. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** The two login roles next to the owner. */
export type RoleKind = "tenant" | "installation";

/** The environment variable that carries each role's connection string. */
export const ROLE_URL_VARIABLE: Record<RoleKind, string> = {
  tenant: "DATABASE_URL",
  installation: "DATABASE_PROVIDER_URL",
};

/** What Postgres says about the role a pool connects as. */
export interface DatabaseRoleInfo {
  name: string;
  superuser: boolean;
  bypassRls: boolean;
  /** Owns a table in the `public` schema (and could switch its RLS off). */
  ownsTables: boolean;
}

export type RoleProblem =
  /** A superuser ignores every policy, even FORCE ROW LEVEL SECURITY. */
  | "superuser"
  /** BYPASSRLS ignores every policy. */
  | "bypass_rls"
  /** A table owner can ALTER TABLE ... DISABLE ROW LEVEL SECURITY. */
  | "owns_tables"
  /** The installation role must see every tenant's rows. */
  | "no_bypass_rls";

/** Why a role may not serve as `kind`; empty when it may. */
export function roleProblems(kind: RoleKind, role: DatabaseRoleInfo): RoleProblem[] {
  if (kind === "installation") {
    return role.superuser || role.bypassRls ? [] : ["no_bypass_rls"];
  }
  const problems: RoleProblem[] = [];
  if (role.superuser) {
    problems.push("superuser");
  }
  if (role.bypassRls) {
    problems.push("bypass_rls");
  }
  if (role.ownsTables) {
    problems.push("owns_tables");
  }
  return problems;
}

const PROBLEM_TEXT: Record<RoleProblem, string> = {
  superuser: "is a superuser",
  bypass_rls: "has BYPASSRLS",
  owns_tables: "owns tables",
  no_bypass_rls: "cannot bypass Row Level Security",
};

/** One line for the operator: which variable, which role, what is wrong, what to do. */
export function describeRoleProblems(
  kind: RoleKind,
  role: DatabaseRoleInfo,
  problems: readonly RoleProblem[],
): string {
  const what = problems.map((problem) => PROBLEM_TEXT[problem]).join(", ");
  const fix =
    kind === "tenant"
      ? "Point it at the application role that the migration step provisions (NOSUPERUSER, NOBYPASSRLS, owns no table), never at the database owner."
      : "Point it at the installation role that the migration step provisions with BYPASSRLS.";
  return `${ROLE_URL_VARIABLE[kind]} connects as "${role.name}", which ${what}. ${fix}`;
}

/** Raised when a pool's role cannot serve its purpose; the message names the fix. */
export class DatabaseRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseRoleError";
  }
}

const CURRENT_ROLE_SQL = `
  SELECT r.rolname AS name,
         r.rolsuper AS superuser,
         r.rolbypassrls AS bypass_rls,
         EXISTS (
           SELECT 1
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
              AND c.relowner = r.oid
         ) AS owns_tables
    FROM pg_roles r
   WHERE r.rolname = current_user`;

/** Ask Postgres about the role `client` is connected as. */
export async function inspectCurrentRole(client: Queryable): Promise<DatabaseRoleInfo> {
  const { rows } = await client.query<{
    name: string;
    superuser: boolean;
    bypass_rls: boolean;
    owns_tables: boolean;
  }>(CURRENT_ROLE_SQL);
  const [row] = rows;
  if (!row) {
    throw new DatabaseRoleError("the current database role could not be read from pg_roles");
  }
  return {
    name: row.name,
    superuser: row.superuser,
    bypassRls: row.bypass_rls,
    ownsTables: row.owns_tables,
  };
}

/**
 * Refuse to run on pools whose roles defeat tenant isolation: the tenant pool
 * must be subject to RLS, the installation pool must be able to bypass it.
 */
export async function assertDatabaseRoles(pools: {
  tenant: Queryable;
  installation: Queryable;
}): Promise<{ tenant: DatabaseRoleInfo; installation: DatabaseRoleInfo }> {
  const tenant = await inspectCurrentRole(pools.tenant);
  const installation = await inspectCurrentRole(pools.installation);
  const messages: string[] = [];
  for (const [kind, role] of [
    ["tenant", tenant],
    ["installation", installation],
  ] as const) {
    const problems = roleProblems(kind, role);
    if (problems.length > 0) {
      messages.push(describeRoleProblems(kind, role, problems));
    }
  }
  if (tenant.name === installation.name) {
    messages.push(
      `DATABASE_URL and DATABASE_PROVIDER_URL both connect as "${tenant.name}"; they must be two different roles.`,
    );
  }
  if (messages.length > 0) {
    throw new DatabaseRoleError(messages.join(" "));
  }
  return { tenant, installation };
}

// ---------------------------------------------------------------------------
// Provisioning (run by the migration step as the owner)
// ---------------------------------------------------------------------------

/** A login role's name and password, taken from its connection string. */
export interface RoleLogin {
  name: string;
  password: string;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** The login of a `postgres://user:password@host/db` connection string. */
export function roleLoginFromUrl(connectionString: string, variable: string): RoleLogin {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new DatabaseRoleError(`${variable} is not a valid connection string.`);
  }
  const name = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!ROLE_NAME.test(name)) {
    throw new DatabaseRoleError(
      `${variable} must name its role in lower case (letters, digits, underscore), e.g. postgres://restow_app:<password>@postgres:5432/restow.`,
    );
  }
  if (password.length === 0) {
    throw new DatabaseRoleError(`${variable} must carry the role's password.`);
  }
  return { name, password };
}

const SCRAM_ITERATIONS = 4096;
const SCRAM_SALT_BYTES = 16;

function hmac(key: Buffer, text: string): Buffer {
  return createHmac("sha256", key).update(text, "utf8").digest();
}

function scramKeys(password: string, salt: Buffer, iterations: number) {
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const clientKey = hmac(salted, "Client Key");
  return {
    storedKey: createHash("sha256").update(clientKey).digest(),
    serverKey: hmac(salted, "Server Key"),
  };
}

/**
 * A SCRAM-SHA-256 verifier as Postgres stores it in `pg_authid.rolpassword`
 * (RFC 5802/7677). Computed here so the plaintext password never travels in
 * an SQL statement, where statement logging could keep it. The password is
 * used as UTF-8 bytes, exactly as node-postgres uses it when it logs in.
 */
export function scramSha256Verifier(
  password: string,
  options: { salt?: Buffer; iterations?: number } = {},
): string {
  const salt = options.salt ?? randomBytes(SCRAM_SALT_BYTES);
  const iterations = options.iterations ?? SCRAM_ITERATIONS;
  const { storedKey, serverKey } = scramKeys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

const VERIFIER = /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;

/** True when `verifier` was made from `password` (so it need not be rewritten). */
export function scramVerifierMatches(password: string, verifier: string | null): boolean {
  const match = verifier ? VERIFIER.exec(verifier) : null;
  if (!match) {
    return false;
  }
  const [, iterations = "", salt = "", storedKey = "", serverKey = ""] = match;
  const keys = scramKeys(password, Buffer.from(salt, "base64"), Number(iterations));
  const expectedStored = Buffer.from(storedKey, "base64");
  const expectedServer = Buffer.from(serverKey, "base64");
  return (
    expectedStored.length === keys.storedKey.length &&
    expectedServer.length === keys.serverKey.length &&
    timingSafeEqual(expectedStored, keys.storedKey) &&
    timingSafeEqual(expectedServer, keys.serverKey)
  );
}

function ident(name: string): string {
  if (!ROLE_NAME.test(name)) {
    throw new DatabaseRoleError(`invalid role name "${name}"`);
  }
  return `"${name}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const ROLE_ATTRIBUTES: Record<RoleKind, string> = {
  tenant: "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT",
  installation: "LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT",
};

/** Tables nobody but the owner may rewrite (the triggers in sql/rls.sql refuse it as well). */
const APPEND_ONLY_TABLES = ["audit_log", "audit_anchor", "archive_anchor"];

/**
 * Who may do what on the provider side (schema/provider-team.ts): read and
 * written only by the installation role. The tenant role, which serves
 * requests pinned to one tenant, never needs them, so it gets no access at
 * all: no tenant-scoped code path can widen a provider admin's rights.
 */
const INSTALLATION_ONLY_TABLES = ["provider_members", "provider_member_tenants"];

async function ensureRole(owner: Queryable, kind: RoleKind, login: RoleLogin): Promise<void> {
  const { rows } = await owner.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [login.name],
  );
  const exists = rows[0]?.exists === true;
  let passwordCurrent = false;
  if (exists) {
    // pg_authid is readable for superusers only; otherwise the password is simply set again.
    // (Asked first: a refused read would abort the surrounding transaction.)
    const { rows: readable } = await owner.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('pg_catalog.pg_authid', 'SELECT') AS allowed",
    );
    if (readable[0]?.allowed) {
      const stored = await owner.query<{ verifier: string | null }>(
        "SELECT rolpassword AS verifier FROM pg_catalog.pg_authid WHERE rolname = $1",
        [login.name],
      );
      passwordCurrent = scramVerifierMatches(login.password, stored.rows[0]?.verifier ?? null);
    }
  }
  const password = passwordCurrent
    ? ""
    : ` PASSWORD ${literal(scramSha256Verifier(login.password))}`;
  await owner.query(
    `${exists ? "ALTER" : "CREATE"} ROLE ${ident(login.name)} WITH ${ROLE_ATTRIBUTES[kind]}${password}`,
  );
}

/**
 * Hand the pg-boss schema to the installation role. pg-boss creates a table
 * per queue and attaches it to `pgboss.job`, which only the owner may do; an
 * installation that ran pg-boss as the database owner so far moves over here.
 */
function pgBossOwnershipSql(installation: string): string {
  const target = literal(installation);
  return `
DO $$
DECLARE
  target text := ${target};
  item record;
BEGIN
  IF to_regnamespace('pgboss') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE format('ALTER SCHEMA pgboss OWNER TO %I', target);
  FOR item IN
    SELECT c.relname,
           CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
                          WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END AS kind
      FROM pg_class c
     WHERE c.relnamespace = 'pgboss'::regnamespace
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
       AND pg_get_userbyid(c.relowner) <> target
       -- identity and serial sequences move together with their table
       AND NOT (c.relkind = 'S' AND EXISTS (
             SELECT 1 FROM pg_depend d
              WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                AND d.deptype IN ('a', 'i')))
  LOOP
    EXECUTE format('ALTER %s pgboss.%I OWNER TO %I', item.kind, item.relname, target);
  END LOOP;
  FOR item IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
     WHERE p.pronamespace = 'pgboss'::regnamespace
       AND pg_get_userbyid(p.proowner) <> target
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO %I', item.signature, target);
  END LOOP;
  FOR item IN
    SELECT t.typname
      FROM pg_type t
     WHERE t.typnamespace = 'pgboss'::regnamespace
       AND t.typtype IN ('e', 'd')
       AND pg_get_userbyid(t.typowner) <> target
  LOOP
    EXECUTE format('ALTER TYPE pgboss.%I OWNER TO %I', item.typname, target);
  END LOOP;
END $$`;
}

/**
 * Create or update the tenant and installation roles and grant them what they
 * need. Idempotent; runs after every migration as the owner, which must be a
 * superuser (the compose default) or at least allowed to create BYPASSRLS roles.
 * `owner` must be one connection (a client, not a pool): everything happens
 * in a single transaction.
 */
export async function provisionRoles(
  owner: Queryable,
  roles: { tenant: RoleLogin; installation: RoleLogin },
): Promise<void> {
  const { rows } = await owner.query<{ owner: string; database: string }>(
    "SELECT current_user AS owner, current_database() AS database",
  );
  const context = rows[0];
  if (!context) {
    throw new DatabaseRoleError("the migration connection could not name its role");
  }
  if (roles.tenant.name === roles.installation.name) {
    throw new DatabaseRoleError(
      `DATABASE_URL and DATABASE_PROVIDER_URL must use two different roles (both use "${roles.tenant.name}").`,
    );
  }
  for (const [kind, login] of [
    ["tenant", roles.tenant],
    ["installation", roles.installation],
  ] as const) {
    if (login.name === context.owner) {
      throw new DatabaseRoleError(
        `${ROLE_URL_VARIABLE[kind]} connects as "${login.name}", the owner that runs the migrations (DATABASE_MIGRATION_URL). Give it a role of its own.`,
      );
    }
  }

  const tenant = ident(roles.tenant.name);
  const installation = ident(roles.installation.name);
  const database = `"${context.database.replace(/"/g, '""')}"`;
  const both = `${tenant}, ${installation}`;

  await owner.query("BEGIN");
  try {
    await ensureRole(owner, "tenant", roles.tenant);
    await ensureRole(owner, "installation", roles.installation);
    for (const statement of [
      `GRANT CONNECT ON DATABASE ${database} TO ${both}`,
      // pg-boss creates its own schema on first start, as the installation role.
      `GRANT CREATE ON DATABASE ${database} TO ${installation}`,
      `GRANT USAGE ON SCHEMA public TO ${both}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${both}`,
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${both}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${both}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${both}`,
      `REVOKE UPDATE, DELETE, TRUNCATE ON ${APPEND_ONLY_TABLES.join(", ")} FROM ${both}`,
      // Archived mail is immutable; only the retention run (installation role) removes it.
      `REVOKE UPDATE, TRUNCATE ON archive_items FROM ${both}`,
      `REVOKE DELETE ON archive_items FROM ${tenant}`,
      // Only once the tables exist (a database being upgraded may not have them yet).
      ...INSTALLATION_ONLY_TABLES.map(
        (table) =>
          `DO $$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON ${table} FROM ${tenant}'; END IF; END $$`,
      ),
      // Whatever pg-boss creates as the installation role, the tenant role may enqueue into:
      // the API and the scheduler insert jobs inside tenant-pinned transactions.
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${installation} GRANT USAGE ON SCHEMAS TO ${tenant}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${installation} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${tenant}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${installation} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${tenant}`,
      pgBossOwnershipSql(roles.installation.name),
    ]) {
      await owner.query(statement);
    }
    const { rows: pgBoss } = await owner.query<{ present: boolean }>(
      "SELECT to_regnamespace('pgboss') IS NOT NULL AS present",
    );
    if (pgBoss[0]?.present) {
      await owner.query(`GRANT USAGE ON SCHEMA pgboss TO ${tenant}`);
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${tenant}`,
      );
      await owner.query(
        `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss TO ${tenant}`,
      );
    }
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
