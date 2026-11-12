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
 *                 data (settings, license, provider secrets, the installation audit
 *                 chain, service heartbeats) and the cross-tenant background scans.
 *                 It also owns the pg-boss queue schema.
 *   auth          the better-auth role (DATABASE_AUTH_URL, optional): NOSUPERUSER,
 *                 NOBYPASSRLS, owns no table. better-auth and Restow's own sign-in,
 *                 account and membership code run on it; it is the only role
 *                 besides the installation role that reaches the better-auth tables
 *                 (sessions, password hashes, TOTP secrets, passkeys,
 *                 verification tokens). Of Restow's tables it may only read a
 *                 tenant and append to its audit chain, under Row Level Security.
 *                 Without DATABASE_AUTH_URL its login is derived from the other
 *                 two ({@link deriveAuthLogin}), so no operator has to configure it.
 *
 * The tenant role keeps no access to the better-auth tables beyond the name
 * and e-mail address of a user (who started a restore, created a key), and
 * none to the installation tables or to queued jobs of the pg-boss schema
 * beyond enqueueing one: {@link TABLE_ACCESS} classifies every table, and the
 * schema tests fail on a table it does not name.
 *
 * Roles are provisioned by the migration step (./migrate.ts) from the login in
 * the connection strings, and every process checks its pools at startup with
 * {@link assertDatabaseRoles}: a tenant or auth pool that can bypass RLS would
 * make every policy decorative, so the process refuses to run.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

/** Anything that can run a parameterised query: a pg Pool, PoolClient or Client. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** The login roles next to the owner. */
export type RoleKind = "tenant" | "installation" | "auth";

/** The environment variable that carries each role's connection string. */
export const ROLE_URL_VARIABLE: Record<RoleKind, string> = {
  tenant: "DATABASE_URL",
  installation: "DATABASE_PROVIDER_URL",
  // Optional: derived from the other two when unset (deriveAuthLogin).
  auth: "DATABASE_AUTH_URL",
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

/** Roles that must stay subject to Row Level Security. */
function boundByRls(kind: RoleKind): boolean {
  return kind !== "installation";
}

/** Why a role may not serve as `kind`; empty when it may. */
export function roleProblems(kind: RoleKind, role: DatabaseRoleInfo): RoleProblem[] {
  if (!boundByRls(kind)) {
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
      : kind === "auth"
        ? "Point it at the auth role that the migration step provisions (NOSUPERUSER, NOBYPASSRLS, owns no table), or remove it so the derived auth role is used."
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
 * (and the auth pool of the api) must be subject to RLS, the installation
 * pool must be able to bypass it, and no two pools may share a role.
 */
export async function assertDatabaseRoles(pools: {
  tenant: Queryable;
  installation: Queryable;
  auth?: Queryable;
}): Promise<{ tenant: DatabaseRoleInfo; installation: DatabaseRoleInfo; auth?: DatabaseRoleInfo }> {
  const tenant = await inspectCurrentRole(pools.tenant);
  const installation = await inspectCurrentRole(pools.installation);
  const auth = pools.auth ? await inspectCurrentRole(pools.auth) : undefined;
  const checked: [RoleKind, DatabaseRoleInfo][] = [
    ["tenant", tenant],
    ["installation", installation],
  ];
  if (auth) {
    checked.push(["auth", auth]);
  }
  const messages: string[] = [];
  for (const [kind, role] of checked) {
    const problems = roleProblems(kind, role);
    if (problems.length > 0) {
      messages.push(describeRoleProblems(kind, role, problems));
    }
  }
  for (const [index, [kind, role]] of checked.entries()) {
    for (const [otherKind, other] of checked.slice(index + 1)) {
      if (role.name === other.name) {
        messages.push(
          `${ROLE_URL_VARIABLE[kind]} and ${ROLE_URL_VARIABLE[otherKind]} both connect as "${role.name}"; they must be different roles.`,
        );
      }
    }
  }
  if (messages.length > 0) {
    throw new DatabaseRoleError(messages.join(" "));
  }
  return auth ? { tenant, installation, auth } : { tenant, installation };
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
  auth: "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT",
};

// ---------------------------------------------------------------------------
// The auth role's login
// ---------------------------------------------------------------------------

/** Suffix of the derived auth role's name. */
const AUTH_ROLE_SUFFIX = "_auth";

/** Domain separation of the derived password: a new scheme gets a new label. */
const AUTH_PASSWORD_LABEL = "restow/database-auth-role/v1";

/**
 * The auth role's login when DATABASE_AUTH_URL is not set: named after the
 * tenant role (`restow_app` becomes `restow_app_auth`), its password an HMAC
 * of that name keyed with the installation role's password. Deterministic, so
 * the migration step (which creates the role) and the api (which connects
 * with it) arrive at the same login from the variables both already have, and
 * an upgrade needs no new setting. Whoever knows the installation password
 * can compute it, and already holds a role that reaches strictly more; a
 * changed installation password changes it too, and the next migration step
 * sets the new one.
 */
export function deriveAuthLogin(tenant: RoleLogin, installation: RoleLogin): RoleLogin {
  const name = `${tenant.name.slice(0, 63 - AUTH_ROLE_SUFFIX.length)}${AUTH_ROLE_SUFFIX}`;
  const password = createHmac("sha256", Buffer.from(installation.password, "utf8"))
    .update(`${AUTH_PASSWORD_LABEL}:${name}`, "utf8")
    .digest("base64url");
  return { name, password };
}

type Env = Readonly<Record<string, string | undefined>>;

function envValue(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * The auth role's login from the environment: DATABASE_AUTH_URL when set,
 * else derived from DATABASE_URL and DATABASE_PROVIDER_URL ({@link deriveAuthLogin}).
 */
export function authLoginFromEnvironment(env: Env): RoleLogin {
  const explicit = envValue(env, ROLE_URL_VARIABLE.auth);
  if (explicit) {
    return roleLoginFromUrl(explicit, ROLE_URL_VARIABLE.auth);
  }
  const tenant = envValue(env, ROLE_URL_VARIABLE.tenant);
  const installation = envValue(env, ROLE_URL_VARIABLE.installation);
  if (!tenant || !installation) {
    throw new DatabaseRoleError(
      `${ROLE_URL_VARIABLE.tenant} and ${ROLE_URL_VARIABLE.installation} are required to derive the auth role (or set ${ROLE_URL_VARIABLE.auth}).`,
    );
  }
  return deriveAuthLogin(
    roleLoginFromUrl(tenant, ROLE_URL_VARIABLE.tenant),
    roleLoginFromUrl(installation, ROLE_URL_VARIABLE.installation),
  );
}

/**
 * The auth pool's connection string: DATABASE_AUTH_URL when set, else
 * DATABASE_URL (same host, database and options) with the derived login.
 */
export function authUrlFromEnvironment(env: Env): string {
  const explicit = envValue(env, ROLE_URL_VARIABLE.auth);
  if (explicit) {
    return explicit;
  }
  const login = authLoginFromEnvironment(env);
  const url = new URL(envValue(env, ROLE_URL_VARIABLE.tenant) as string);
  url.username = login.name;
  url.password = login.password;
  return url.toString();
}

// ---------------------------------------------------------------------------
// Which role reaches which table
// ---------------------------------------------------------------------------

/**
 * Where a table belongs:
 *
 *   tenant        tenant data under the Row Level Security policy of
 *                 sql/rls.sql: the tenant role within its pinned tenant, the
 *                 installation role across tenants.
 *   auth          better-auth's tables: the auth and installation roles. The
 *                 tenant role reads {@link TENANT_USER_COLUMNS} of `user`, nothing else.
 *   installation  installation-level rows: the installation role alone.
 */
export type TableAccess = "tenant" | "auth" | "installation";

/**
 * Every table that is not plain tenant data (a `tenant_id` column listed in
 * sql/rls.sql). packages/db schema tests fail on a table that is neither, so a
 * new table has to be placed here, or under Row Level Security, before it ships.
 */
export const TABLE_ACCESS: Readonly<Record<string, TableAccess>> = {
  // Isolated on its own id (sql/rls.sql `tenant_isolation_self`).
  tenants: "tenant",
  // better-auth (schema/auth.ts).
  user: "auth",
  session: "auth",
  account: "auth",
  verification: "auth",
  passkey: "auth",
  organization: "auth",
  member: "auth",
  invitation: "auth",
  two_factor: "auth",
  rate_limit: "auth",
  // Installation level.
  providers: "installation",
  settings: "installation",
  license: "installation",
  service_heartbeats: "installation",
  // Services that need a manual restart (restart-requests.ts); no tenant data.
  restart_requests: "installation",
  // New job starts paused for an update (job-start-pause.ts); no tenant data.
  job_start_pause: "installation",
  // Restore mode after restoring a database dump (restore-mode.ts); no tenant data beyond ids.
  installation_restore_mode: "installation",
  // Worker nodes on other hosts and their one-time join tokens (schema/cluster.ts).
  cluster_join_tokens: "installation",
  cluster_nodes: "installation",
  // Who may do what on the provider side (schema/provider-team.ts): no
  // tenant-scoped code path can widen a provider admin's rights.
  provider_members: "installation",
  // Carries tenant_id and a policy, a second line should it ever be granted.
  provider_member_tenants: "installation",
  // The provider's notification recipients and its summary reports across tenants (0.5.0).
  provider_notification_recipients: "installation",
  provider_report_rules: "installation",
  // Branding (0.5.0): the provider's, and the logos the public image route serves.
  provider_branding: "installation",
  branding_images: "installation",
};

/** The tables {@link TABLE_ACCESS} gives `access`. */
export function tablesWithAccess(access: TableAccess): string[] {
  return Object.entries(TABLE_ACCESS)
    .filter(([, value]) => value === access)
    .map(([table]) => table);
}

/**
 * The columns of better-auth's `user` the tenant role may read: the name and
 * address of whoever acted, which tenant views show next to their own rows
 * (who requested a restore, an export or an import, who created an API key).
 * Neither a credential nor the provider role of a person.
 */
export const TENANT_USER_COLUMNS = ["id", "name", "email"] as const;

/**
 * Restow tables the auth role reaches besides better-auth's, under Row Level
 * Security like the tenant role: redeeming a set-password link checks the
 * tenant it was issued for and appends that tenant's audit entry in the same
 * pinned transaction as the password (apps/api features/accounts).
 */
export const AUTH_ROLE_RESTOW_GRANTS: Readonly<Record<string, string>> = {
  tenants: "SELECT",
  audit_log: "SELECT, INSERT",
};

/** Tables nobody but the owner may rewrite (the triggers in sql/rls.sql refuse it as well). */
const APPEND_ONLY_TABLES = ["audit_log", "audit_anchor", "archive_anchor"];

// ---------------------------------------------------------------------------
// The role of worker nodes on other hosts (node-roles.ts)
// ---------------------------------------------------------------------------

/** Suffix of the node role's name. */
const NODE_ROLE_SUFFIX = "_node";

/**
 * The role the installation login of a worker node switches to (node-roles.ts): named after the
 * installation role (`restow_provider` becomes `restow_provider_node`), so two installations on
 * one Postgres server never share it. NOLOGIN and BYPASSRLS like the installation role, with the
 * installation role's table rights minus what only the api needs: no CREATE on the database, no
 * access to the sign-in tables, the provider team or the join tokens, and only a read of the
 * node list ({@link NODE_DENIED_TABLES}, {@link NODE_TABLE_READS}). A worker host that is taken
 * over can do what a worker does, not plant a join token, take over a provider account or widen
 * a provider member's rights. Created by the first join (node-roles.ts `createNodeLogins`); the
 * migration step renews its grants while it exists.
 */
export function nodeInstallationRoleName(installationRole: string): string {
  if (!ROLE_NAME.test(installationRole)) {
    throw new DatabaseRoleError(`invalid role name "${installationRole}"`);
  }
  return `${installationRole.slice(0, 63 - NODE_ROLE_SUFFIX.length)}${NODE_ROLE_SUFFIX}`;
}

/** The node role's attributes: BYPASSRLS for the cross-tenant scans of a worker, no login. */
const NODE_ROLE_ATTRIBUTES =
  "NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT";

/**
 * Tables the node role gets nothing on (beyond {@link NODE_TABLE_READS}): better-auth's (password
 * hashes, sessions, second factors, passkeys, provider admins), the provider team, and the
 * cluster's own tables, so a node can neither create a join token nor change the node list.
 */
export const NODE_DENIED_TABLES: readonly string[] = [
  ...tablesWithAccess("auth"),
  "provider_members",
  "provider_member_tenants",
  "cluster_join_tokens",
  "cluster_nodes",
];

/** What the node role may read of {@link NODE_DENIED_TABLES}: `restow node check` asks whether it is still an active node. */
export const NODE_TABLE_READS: Readonly<Record<string, string>> = {
  cluster_nodes: "SELECT",
};

/** Run `statement` only when `schema` exists. */
function whenSchemaExists(schema: string, statement: string): string {
  return `DO $$ BEGIN IF to_regnamespace(${literal(schema)}) IS NOT NULL THEN EXECUTE ${literal(statement)}; END IF; END $$`;
}

/**
 * The node role's access to the pg-boss schema: the job and queue tables a worker and a standby
 * scheduler read and write, nothing it could own (the queue partitions are the installation
 * role's; the main host creates them). Run as the installation role (which owns the schema) or
 * as the database owner; `installationRole` names the role whose future pg-boss tables are
 * covered as well.
 */
function nodeQueueAccessStatements(nodeRole: string, installationRole: string): string[] {
  const role = ident(nodeRole);
  return [
    `GRANT USAGE ON SCHEMA pgboss TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${role}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss TO ${role}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(installationRole)} IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(installationRole)} IN SCHEMA pgboss GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`,
  ];
}

/**
 * Create the node role when it is missing (the database owner, a superuser in the compose
 * default; a concurrent creation for another database of the same server is fine) and give it
 * its rights on the current database. One statement list, run by {@link provisionRoles} and by
 * node-roles.ts `createNodeLogins` inside their transaction.
 */
export function nodeRoleStatements(input: {
  readonly nodeRole: string;
  readonly installationRole: string;
  /** The current database, already quoted. */
  readonly database: string;
}): string[] {
  const role = ident(input.nodeRole);
  return [
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(input.nodeRole)}) THEN
    BEGIN
      CREATE ROLE ${role} WITH ${NODE_ROLE_ATTRIBUTES};
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL;
    END;
  END IF;
END $$`,
    `ALTER ROLE ${role} WITH ${NODE_ROLE_ATTRIBUTES}`,
    `GRANT CONNECT ON DATABASE ${input.database} TO ${role}`,
    // Never CREATE on the database: a node creates no schema (pg-boss' is the main host's).
    `REVOKE CREATE ON DATABASE ${input.database} FROM ${role}`,
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    `REVOKE UPDATE, DELETE, TRUNCATE ON ${APPEND_ONLY_TABLES.join(", ")} FROM ${role}`,
    `REVOKE UPDATE, TRUNCATE ON archive_items FROM ${role}`,
    whenTableExists(
      "archive_item_mailboxes",
      `REVOKE UPDATE, TRUNCATE ON archive_item_mailboxes FROM ${role}`,
    ),
    whenTableExists(
      "archive_item_captures",
      `REVOKE UPDATE, TRUNCATE ON archive_item_captures FROM ${role}`,
    ),
    ...NODE_DENIED_TABLES.map((table) =>
      whenTableExists(table, `REVOKE ALL ON ${ident(table)} FROM ${role}`),
    ),
    ...Object.entries(NODE_TABLE_READS).map(([table, privileges]) =>
      whenTableExists(table, `GRANT ${privileges} ON ${ident(table)} TO ${role}`),
    ),
    // The schema check of a node (node-guard.ts, `restow node check`).
    ...migrationTableStatements(input.nodeRole),
    ...nodeQueueAccessStatements(input.nodeRole, input.installationRole).map((statement) =>
      whenSchemaExists("pgboss", statement),
    ),
  ];
}

/**
 * Read access to Drizzle's migration journal (`drizzle.__drizzle_migrations`): a worker node
 * compares the database's migrations with its image's (migrate.ts `appliedMigrationCount`).
 */
function migrationTableStatements(role: string): string[] {
  return [
    whenSchemaExists("drizzle", `GRANT USAGE ON SCHEMA drizzle TO ${ident(role)}`),
    `DO $$ BEGIN IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN EXECUTE ${literal(`GRANT SELECT ON drizzle.__drizzle_migrations TO ${ident(role)}`)}; END IF; END $$`,
  ];
}

/** Run `statement` only when `table` exists (a database being upgraded may not have it yet). */
function whenTableExists(table: string, statement: string): string {
  return `DO $$ BEGIN IF to_regclass(${literal(`public.${ident(table)}`)}) IS NOT NULL THEN EXECUTE ${literal(statement)}; END IF; END $$`;
}

/** Serializes every change of the roles' grants (migration step, worker, scheduler). */
const GRANT_LOCK = "SELECT pg_advisory_xact_lock(hashtext('restow.database-roles'))";

/**
 * What the tenant role may do in the pg-boss schema: enqueue a job, nothing
 * else. pg-boss' `send` is one `INSERT INTO pgboss.job ... SELECT ... JOIN
 * pgboss.queue ... RETURNING id`, so it needs INSERT on the job table, the id
 * it returns, and the queue definitions (which the API also checks for before
 * a first backup). It cannot read another job's payload, nor change, cancel
 * or delete one: cancelling runs on the installation pool. Rows go through
 * the partitioned `pgboss.job`, so the per-queue partitions need no grant.
 */
function queueAccessStatements(tenant: string): string[] {
  const role = ident(tenant);
  return [
    `REVOKE ALL ON ALL TABLES IN SCHEMA pgboss FROM ${role}`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA pgboss FROM ${role}`,
    `GRANT USAGE ON SCHEMA pgboss TO ${role}`,
    `DO $$ BEGIN IF to_regclass('pgboss.queue') IS NOT NULL THEN EXECUTE ${literal(`GRANT SELECT ON pgboss.queue TO ${role}`)}; END IF; END $$`,
    `DO $$ BEGIN IF to_regclass('pgboss.job') IS NOT NULL THEN EXECUTE ${literal(`GRANT INSERT, SELECT (id) ON pgboss.job TO ${role}`)}; END IF; END $$`,
  ];
}

/**
 * Give the tenant role its enqueue-only access to the pg-boss schema. The
 * migration step does it when the schema already exists; the worker and the
 * scheduler, which create (and upgrade) the schema as the installation role
 * that owns it, call this right after pg-boss has started, so a fresh
 * installation and a pg-boss upgrade get the same grants. `installation`
 * connects as that role; `tenantRole` is the tenant pool's role name. One
 * statement batch, so it is a single transaction, serialized with the
 * migration step's by an advisory lock.
 */
export async function grantQueueAccess(installation: Queryable, tenantRole: string): Promise<void> {
  const { rows } = await installation.query<{ role: string; owns: boolean; node: boolean }>(
    `SELECT current_user AS role,
            COALESCE((SELECT pg_get_userbyid(nspowner) = current_user
                        FROM pg_namespace WHERE nspname = 'pgboss'), false) AS owns,
            EXISTS (SELECT 1 FROM pg_roles
                     WHERE rolname = left(current_user, ${63 - NODE_ROLE_SUFFIX.length}) || ${literal(NODE_ROLE_SUFFIX)}) AS node`,
  );
  const self = rows[0];
  // A worker node's role does not own the schema: the main host's processes grant.
  if (!self?.owns) {
    return;
  }
  // Several statements in one simple query run as one implicit transaction:
  // all or nothing, and the pooled connection never stays in a failed one.
  const statements = [
    GRANT_LOCK,
    ...queueAccessStatements(tenantRole),
    ...(self.node ? nodeQueueAccessStatements(nodeInstallationRoleName(self.role), self.role) : []),
  ];
  await installation.query(statements.join(";\n"));
}

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
 * Create or update the tenant, installation and auth roles and grant them
 * what they need. Idempotent; runs after every migration as the owner, which
 * must be a superuser (the compose default) or at least allowed to create
 * BYPASSRLS roles. `owner` must be one connection (a client, not a pool):
 * everything happens in a single transaction. Without `auth` the auth role's
 * login is derived from the other two ({@link deriveAuthLogin}).
 */
export async function provisionRoles(
  owner: Queryable,
  roles: { tenant: RoleLogin; installation: RoleLogin; auth?: RoleLogin },
): Promise<void> {
  const { rows } = await owner.query<{ owner: string; database: string }>(
    "SELECT current_user AS owner, current_database() AS database",
  );
  const context = rows[0];
  if (!context) {
    throw new DatabaseRoleError("the migration connection could not name its role");
  }
  const logins: Record<RoleKind, RoleLogin> = {
    tenant: roles.tenant,
    installation: roles.installation,
    auth: roles.auth ?? deriveAuthLogin(roles.tenant, roles.installation),
  };
  const kinds = Object.keys(logins) as RoleKind[];
  for (const [index, kind] of kinds.entries()) {
    for (const other of kinds.slice(index + 1)) {
      if (logins[kind].name === logins[other].name) {
        throw new DatabaseRoleError(
          `${ROLE_URL_VARIABLE[kind]} and ${ROLE_URL_VARIABLE[other]} must use different roles (both use "${logins[kind].name}").`,
        );
      }
    }
    if (logins[kind].name === context.owner) {
      throw new DatabaseRoleError(
        `${ROLE_URL_VARIABLE[kind]} connects as "${logins[kind].name}", the owner that runs the migrations (DATABASE_MIGRATION_URL). Give it a role of its own.`,
      );
    }
  }

  const tenant = ident(logins.tenant.name);
  const installation = ident(logins.installation.name);
  const auth = ident(logins.auth.name);
  const database = `"${context.database.replace(/"/g, '""')}"`;
  const both = `${tenant}, ${installation}`;
  const all = `${tenant}, ${installation}, ${auth}`;

  await owner.query("BEGIN");
  try {
    await owner.query(GRANT_LOCK);
    for (const kind of kinds) {
      await ensureRole(owner, kind, logins[kind]);
    }
    for (const statement of [
      `GRANT CONNECT ON DATABASE ${database} TO ${all}`,
      // pg-boss creates its own schema on first start, as the installation role.
      `GRANT CREATE ON DATABASE ${database} TO ${installation}`,
      `GRANT USAGE ON SCHEMA public TO ${all}`,
      // Tenant data: everything not classified otherwise below is under Row Level Security.
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${both}`,
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${both}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${both}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${both}`,
      `REVOKE UPDATE, DELETE, TRUNCATE ON ${APPEND_ONLY_TABLES.join(", ")} FROM ${both}`,
      // Archived mail is immutable; only the retention run (installation role) removes it.
      `REVOKE UPDATE, TRUNCATE ON archive_items FROM ${both}`,
      `REVOKE DELETE ON archive_items FROM ${tenant}`,
      // An archived mail's mailbox assignments are append-only in the same way.
      // (Guarded: an older database may not have it yet.)
      whenTableExists(
        "archive_item_mailboxes",
        `REVOKE UPDATE, TRUNCATE ON archive_item_mailboxes FROM ${both}`,
      ),
      whenTableExists(
        "archive_item_mailboxes",
        `REVOKE DELETE ON archive_item_mailboxes FROM ${tenant}`,
      ),
      // The chain links of items deleted after their retention stay for good (0.5.0).
      whenTableExists(
        "archive_chain_tombstones",
        `REVOKE UPDATE, DELETE, TRUNCATE ON archive_chain_tombstones FROM ${both}`,
      ),
      // So are its further captures (0.4.4): the tenant role selects and inserts.
      whenTableExists(
        "archive_item_captures",
        `REVOKE UPDATE, TRUNCATE ON archive_item_captures FROM ${both}`,
      ),
      whenTableExists(
        "archive_item_captures",
        `REVOKE DELETE ON archive_item_captures FROM ${tenant}`,
      ),
      // The installation tables are the installation role's alone.
      ...tablesWithAccess("installation").map((table) =>
        whenTableExists(table, `REVOKE ALL ON ${ident(table)} FROM ${tenant}`),
      ),
      // better-auth's tables: the auth role (and the installation role); the
      // tenant role only the name and address of a user.
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${auth}`,
      ...tablesWithAccess("auth").flatMap((table) => [
        whenTableExists(table, `REVOKE ALL ON ${ident(table)} FROM ${tenant}`),
        whenTableExists(
          table,
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ${ident(table)} TO ${auth}`,
        ),
      ]),
      whenTableExists(
        "user",
        `GRANT SELECT (${TENANT_USER_COLUMNS.join(", ")}) ON ${ident("user")} TO ${tenant}`,
      ),
      ...Object.entries(AUTH_ROLE_RESTOW_GRANTS).map(([table, privileges]) =>
        whenTableExists(table, `GRANT ${privileges} ON ${ident(table)} TO ${auth}`),
      ),
      // Until 0.3.5 the tenant role got everything the installation role created
      // (the pg-boss schema); now it gets enqueue access only (queueAccessStatements).
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${installation} REVOKE ALL ON SCHEMAS FROM ${tenant}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${installation} REVOKE ALL ON TABLES FROM ${tenant}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${installation} REVOKE ALL ON SEQUENCES FROM ${tenant}`,
      pgBossOwnershipSql(logins.installation.name),
      // A worker node checks the schema version as the installation role (node-guard.ts).
      ...migrationTableStatements(logins.installation.name),
    ]) {
      await owner.query(statement);
    }
    // The worker nodes' role, once a node has joined: its grants follow every migration.
    const nodeRole = nodeInstallationRoleName(logins.installation.name);
    const { rows: nodes } = await owner.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present",
      [nodeRole],
    );
    if (nodes[0]?.present) {
      for (const statement of nodeRoleStatements({
        nodeRole,
        installationRole: logins.installation.name,
        database,
      })) {
        await owner.query(statement);
      }
    }
    const { rows: pgBoss } = await owner.query<{ present: boolean }>(
      "SELECT to_regnamespace('pgboss') IS NOT NULL AS present",
    );
    if (pgBoss[0]?.present) {
      for (const statement of queueAccessStatements(logins.tenant.name)) {
        await owner.query(statement);
      }
    }
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
