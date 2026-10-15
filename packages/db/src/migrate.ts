/**
 * Apply database migrations: the generated Drizzle migrations first, then the
 * per-tenant RLS policies and append-only triggers (sql/rls.sql), then the
 * tenant, installation and auth roles with their grants (./roles.ts).
 *
 * Uses only runtime dependencies (drizzle-orm, pg) so it works inside the
 * production image, where drizzle-kit (a dev dependency) is absent. Idempotent:
 * the Drizzle migrator tracks what it has applied, and sql/rls.sql and the role
 * provisioning are written to be safe to run repeatedly, so this can run on
 * every deploy / api start.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  authLoginFromEnvironment,
  DatabaseRoleError,
  provisionRoles,
  ROLE_URL_VARIABLE,
  type RoleLogin,
  roleLoginFromUrl,
} from "./roles.js";

// Resolved relative to this module, so it works from both dist/ and src/. The
// db package ships the `drizzle` and `sql` folders (see package.json "files").
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const rlsFile = fileURLToPath(new URL("../sql/rls.sql", import.meta.url));

export interface MigrationOptions {
  /**
   * The login roles to create or update after the schema is current. Omitted
   * by test fixtures that run everything as the owner. Without `auth` the
   * auth role's login is derived from the other two (roles.ts `deriveAuthLogin`).
   */
  roles?: { tenant: RoleLogin; installation: RoleLogin; auth?: RoleLogin };
}

/** Migrate the database `ownerConnectionString` points at, as its owner. */
export async function runMigrations(
  ownerConnectionString: string,
  options: MigrationOptions = {},
): Promise<void> {
  const pool = new Pool({ connectionString: ownerConnectionString });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
    await pool.query(readFileSync(rlsFile, "utf8"));
    await reclaimLegacyManifestSpace(pool);
    if (options.roles) {
      const client = await pool.connect();
      try {
        await provisionRoles(client, options.roles);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

/** Below this, an empty legacy manifest table is not worth a lock. */
export const LEGACY_RECLAIM_MIN_BYTES = 8 * 1024 * 1024;

/** Anything that runs a query: a pool, a client, or the installation pool of a process. */
interface SizeQueryable {
  query<R extends Record<string, unknown>>(text: string): Promise<{ rows: R[] }>;
}

/**
 * The size on disk of the 0.3.4 manifest mirror (`manifest_objects`, indexes
 * included), or null when the table does not exist. Needs no privilege on the
 * table, so the installation pool can ask it; cheap at any size (it reads the
 * file sizes, not the rows).
 */
export async function legacyManifestBytes(db: SizeQueryable): Promise<number | null> {
  const { rows } = await db.query<{ bytes: string | null }>(
    "SELECT pg_total_relation_size(to_regclass('public.manifest_objects'))::text AS bytes",
  );
  const bytes = rows[0]?.bytes;
  return bytes === null || bytes === undefined ? null : Number(bytes);
}

/**
 * Give the disk space of the 0.3.4 manifest mirror (`manifest_objects`) back
 * once the worker has folded all of it into `manifest_versions`
 * (manifest-versions.ts): the conversion deletes the rows, but Postgres keeps
 * the pages until a VACUUM truncates them, and only the owner may TRUNCATE.
 * Runs on every migration (api start), and the running api tries it again now
 * and then until the space is back (apps/api lib/legacy-manifest-reclaim.ts),
 * so the conversion finishing needs no restart. Bounded to a few seconds and
 * skipped whenever the table still has rows, is in use, or the check takes too
 * long, so a start never waits on it.
 */
export async function reclaimLegacyManifestSpace(
  pool: Pool,
  minBytes = LEGACY_RECLAIM_MIN_BYTES,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'");
    // A table of deleted rows is scanned page by page until VACUUM has run; never wait long for it.
    await client.query("SET LOCAL statement_timeout = '5s'");
    const bytes = await legacyManifestBytes(client);
    if (bytes === null || bytes < minBytes) {
      await client.query("ROLLBACK");
      return false;
    }
    const empty = await client.query<{ empty: boolean }>(
      "SELECT NOT EXISTS (SELECT 1 FROM manifest_objects) AS empty",
    );
    if (empty.rows[0]?.empty !== true) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("TRUNCATE manifest_objects");
    await client.query("COMMIT");
    return true;
  } catch {
    // Busy or slow: the next attempt tries again (and autovacuum gets there as well).
    await client.query("ROLLBACK").catch(() => undefined);
    return false;
  } finally {
    client.release();
  }
}

/** Environment variable of the owner connection that runs the migrations. */
export const MIGRATION_URL_VARIABLE = "DATABASE_MIGRATION_URL";

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new DatabaseRoleError(`${name} is required to migrate the database (see .env.example).`);
  }
  return value;
}

/**
 * The migration step of the api container: migrate as the owner
 * (DATABASE_MIGRATION_URL), then provision the application role
 * (DATABASE_URL), the installation role (DATABASE_PROVIDER_URL) and the auth
 * role (DATABASE_AUTH_URL, else derived from the other two) with the logins
 * those connection strings carry.
 */
export async function migrateFromEnvironment(env: Env = process.env): Promise<void> {
  const owner = required(env, MIGRATION_URL_VARIABLE);
  const tenant = roleLoginFromUrl(
    required(env, ROLE_URL_VARIABLE.tenant),
    ROLE_URL_VARIABLE.tenant,
  );
  const installation = roleLoginFromUrl(
    required(env, ROLE_URL_VARIABLE.installation),
    ROLE_URL_VARIABLE.installation,
  );
  const auth = authLoginFromEnvironment(env);
  await runMigrations(owner, { roles: { tenant, installation, auth } });
}
