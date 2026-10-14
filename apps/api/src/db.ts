import {
  type Database,
  type ServiceStatuses,
  assertDatabaseRoles,
  authUrlFromEnvironment,
  createDb,
  readServiceStatuses,
  tenants,
} from "@restow/db";
import { config } from "./config.js";

/**
 * The three database handles of the API (packages/db/src/roles.ts).
 *
 * `db` connects as the application role, which is subject to Row Level
 * Security: every tenant-scoped query runs inside `withTenantTx`, which pins
 * `app.tenant_id` for the transaction (packages/db/sql/rls.sql), and a query
 * that forgets its tenant filter still sees no other tenant's rows. It has
 * no access to the installation tables (settings, license, providers, service
 * heartbeats, the provider team) and of better-auth's tables only the name
 * and e-mail address of a user.
 *
 * `authDb` connects as the auth role, also subject to Row Level Security. It
 * is better-auth's database and the one for Restow's own code on its tables:
 * sessions, accounts and passwords, passkeys, TOTP, verification tokens,
 * memberships and invitations. Of Restow's tables it reads a tenant and
 * appends to its audit chain, nothing else.
 *
 * `providerDb` connects as the installation role (BYPASSRLS). It is reserved
 * for what cannot be pinned to one tenant: resolving the tenant and API key of
 * a request, the provider's cross-tenant views (tenant list, mailbox usage,
 * audit of every chain), installation-level rows (settings, license, provider
 * API keys, provider secrets, the installation audit chain) and the
 * uniqueness checks that span tenants. Anything else belongs on `db`.
 */
/**
 * Where a pool without a connection string goes: a port nothing listens on,
 * so its queries fail at once. An empty string would make node-postgres fall
 * back to libpq's defaults (localhost:5432, the OS user, no password); a
 * server there that asks for a password keeps that half-done login for its
 * whole authentication_timeout, and every DROP DATABASE on it waits that
 * long. The api refuses to start without its URLs (config.ts); this only
 * reaches code that imports the module without them, such as a test.
 */
const UNCONFIGURED_URL = "postgres://unconfigured@127.0.0.1:1/unconfigured";

function pool(url: string): Database {
  return createDb(url || UNCONFIGURED_URL);
}

export const db: Database = pool(config.databaseUrl);

/** The installation pool; see the module comment for what may use it. */
export const providerDb: Database = pool(config.databaseProviderUrl);

/** Why the auth pool's connection string could not be built, if it could not. */
let authUrlProblem: unknown = null;

function authUrl(): string {
  try {
    return authUrlFromEnvironment({
      DATABASE_URL: config.databaseUrl,
      DATABASE_PROVIDER_URL: config.databaseProviderUrl,
      DATABASE_AUTH_URL: config.databaseAuthUrl,
    });
  } catch (error) {
    // Reported by assertPoolRoles at startup, like any other pool problem.
    authUrlProblem = error;
    return "";
  }
}

/** The auth pool; see the module comment for what may use it. */
export const authDb: Database = pool(authUrl());

/**
 * Refuse to serve on pools that defeat tenant isolation: the application and
 * auth roles must be subject to RLS (not superuser, not BYPASSRLS, owning no
 * table), the installation role must bypass it, and all three must differ.
 * Throws a `DatabaseRoleError` naming the variable to fix.
 */
export async function assertPoolRoles(): Promise<void> {
  if (authUrlProblem) {
    throw authUrlProblem;
  }
  await assertDatabaseRoles({
    tenant: db.$client,
    installation: providerDb.$client,
    auth: authDb.$client,
  });
}

/**
 * Probe database connectivity for `/readyz`. Runs a trivial query against a
 * migrated table the application role may read (`tenants`; unpinned, Row
 * Level Security returns no row); success means the pool connected and the
 * schema is present. Never throws — a failure is reported as `false`.
 */
export async function isDatabaseReachable(database: Database = db): Promise<boolean> {
  try {
    await database.select({ id: tenants.id }).from(tenants).limit(1);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which of the worker and the scheduler has reported in within the last two
 * minutes (`service_heartbeats`, written by those processes), for `/readyz`.
 * A role that cannot be confirmed, because the table cannot be read, is
 * `missing`. Never throws.
 */
export async function readWorkerAndScheduler(
  database: Database = providerDb,
): Promise<ServiceStatuses> {
  try {
    return await readServiceStatuses(database);
  } catch {
    return { worker: "missing", scheduler: "missing" };
  }
}
