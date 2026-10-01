import {
  type Database,
  type ServiceStatuses,
  assertDatabaseRoles,
  createDb,
  readServiceStatuses,
  settings,
} from "@restow/db";
import { config } from "./config.js";

/**
 * The two database handles of the API (packages/db/src/roles.ts).
 *
 * `db` connects as the application role, which is subject to Row Level
 * Security: every tenant-scoped query runs inside `withTenantTx`, which pins
 * `app.tenant_id` for the transaction (packages/db/sql/rls.sql), and a query
 * that forgets its tenant filter still sees no other tenant's rows. Tables
 * without a tenant (settings, the better-auth tables) are read on it
 * as well.
 *
 * `providerDb` connects as the installation role (BYPASSRLS). It is reserved
 * for what cannot be pinned to one tenant: resolving the tenant and API key of
 * a request, the provider's cross-tenant views (tenant list, mailbox usage,
 * audit of every chain), installation-level rows (provider API keys, provider
 * secrets, the installation audit chain) and the uniqueness checks that span
 * tenants. Anything else belongs on `db`.
 */
export const db: Database = createDb(config.databaseUrl);

/** The installation pool; see the module comment for what may use it. */
export const providerDb: Database = createDb(config.databaseProviderUrl);

/**
 * Refuse to serve on pools that defeat tenant isolation: the application role
 * must be subject to RLS (not superuser, not BYPASSRLS, owning no table), the
 * installation role must bypass it. Throws a `DatabaseRoleError` naming the
 * variable to fix.
 */
export async function assertPoolRoles(): Promise<void> {
  await assertDatabaseRoles({ tenant: db.$client, installation: providerDb.$client });
}

/**
 * Probe database connectivity for `/readyz`. Runs a trivial query against a
 * migrated, non-tenant table; success means the pool connected and the schema is
 * present. Never throws — a failure is reported as `false`.
 */
export async function isDatabaseReachable(database: Database = db): Promise<boolean> {
  try {
    await database.select().from(settings).limit(1);
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
export async function readWorkerAndScheduler(database: Database = db): Promise<ServiceStatuses> {
  try {
    return await readServiceStatuses(database);
  } catch {
    return { worker: "missing", scheduler: "missing" };
  }
}
