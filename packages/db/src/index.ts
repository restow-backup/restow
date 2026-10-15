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
 * environment, never hardcoded).
 */
export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;

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
// The manifest index as versions: mirroring a snapshot, retention, the 0.3.5 conversion, reading.
export * from "./manifest-versions.js";
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
export { schema };
