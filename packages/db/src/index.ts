import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

const { Pool } = pg;

/**
 * Create a Drizzle database handle backed by a node-postgres connection pool.
 *
 * Tenant isolation is enforced by Postgres Row Level Security, and it only
 * holds on a pool whose role is subject to it (./roles.ts): the application
 * pool (DATABASE_URL) scopes every tenant transaction with
 * `set_config('app.tenant_id', <uuid>, true)` (see sql/rls.sql), the
 * installation pool (DATABASE_PROVIDER_URL) is kept for the lookups made before
 * a tenant is known. The connection string is supplied by the caller (from the
 * environment, never hardcoded). `options.max` sizes the pool (pool-size.ts);
 * without it node-postgres's default of 10 applies.
 */
export function createDb(connectionString: string, options: { readonly max?: number } = {}) {
  const pool = new Pool({
    connectionString,
    ...(options.max === undefined ? {} : { max: options.max }),
  });
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;

// Appending to a tenant's archive chain (@restow/core archive/append.ts), and mailbox assignment.
export * from "./archive-append.js";
// The mail objects' capture kinds and the capture ways a mail job asks for (0.4.4).
export * from "./archive-capture.js";
// How the archive is filtered and held by mailbox, journal assignments included (#32).
export * from "./archive-mailboxes.js";
export {
  type ConcurrentSetupOptions,
  isConcurrentSetupConflict,
  retryConcurrentSetup,
} from "./concurrent-setup.js";
// Reporting a failed query without its SQL text and bound parameters.
export { reportableError, safeErrorMessage, withoutQueryText } from "./errors.js";

// Process liveness: heartbeat writer and the status /readyz reports.
export * from "./heartbeat.js";
// Installation-level secrets (read on the installation pool).
export * from "./installation-secrets.js";
// New job starts paused for an update (#46): what the scheduler, the worker and the PVE heartbeat ask.
export * from "./job-start-pause.js";
// The manifest index as versions: mirroring a snapshot, retention, the 0.3.5 conversion, reading.
export * from "./manifest-versions.js";
// How many connections each pool may open (RESTOW_DB_POOL_MAX and its siblings).
export * from "./pool-size.js";
// The lock that keeps the server's own work on one endpoint repository from overlapping.
export * from "./repository-lock.js";
// Services that need a manual restart, and why (the Updates tab shows them).
export * from "./restart-requests.js";
// The database roles and the startup check of the pools.
export * from "./roles.js";
// The throughput history of runs (sparklines and the run drawer's charts).
export * from "./run-samples.js";
// Re-export the full schema (tables, enums, and inferred row types).
export * from "./schema/index.js";
// The retention hold on suspicion: objects with a suspicious restore point nobody resolved.
export * from "./suspicion-holds.js";
export { schema };
