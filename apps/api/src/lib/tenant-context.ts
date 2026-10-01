import type { Database } from "@restow/db";
import { type SQL, sql } from "drizzle-orm";

/**
 * Tenant context for Row Level Security (packages/db/sql/rls.sql).
 *
 * Every tenant-scoped query must run inside a transaction that first pins the
 * tenant: `SET LOCAL app.tenant_id = '<uuid>'`. `SET LOCAL` is scoped to the
 * transaction, so a pooled connection can never leak one tenant's id into the
 * next request. `SET` does not accept bind parameters, so the pin is issued via
 * `set_config(name, value, is_local = true)`, which does — the tenant id is never
 * interpolated into SQL text.
 */

/** A Drizzle transaction handle as passed to `db.transaction(fn)`. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Anything that can run queries: the pool-backed database or an open transaction. */
export type DbExecutor = Database | Transaction;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical (hyphenated, hex) UUID string. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Reject anything that is not a UUID before it can reach the session setting. */
export function assertTenantId(tenantId: string): void {
  if (!isUuid(tenantId)) {
    throw new TypeError("tenantId must be a UUID");
  }
}

/** The parameterized statement that pins `app.tenant_id` for the current transaction. */
export function pinTenantStatement(tenantId: string): SQL {
  assertTenantId(tenantId);
  return sql`select set_config('app.tenant_id', ${tenantId}, true)`;
}

/** True when the executor is already a transaction (Drizzle transactions expose `rollback`). */
export function isTransaction(executor: DbExecutor): executor is Transaction {
  return typeof (executor as Transaction).rollback === "function";
}

/**
 * Run `fn` inside a transaction pinned to `tenantId`, so every query in it is
 * subject to the tenant's RLS policies. Nested calls from inside an existing
 * transaction open a savepoint and re-pin (harmless, and it keeps the guarantee).
 */
export async function withTenantTx<T>(
  db: DbExecutor,
  tenantId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const statement = pinTenantStatement(tenantId);
  return db.transaction(async (tx) => {
    await tx.execute(statement);
    return fn(tx);
  });
}
