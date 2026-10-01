/**
 * Apply database migrations: the generated Drizzle migrations first, then the
 * per-tenant RLS policies and append-only triggers (sql/rls.sql), then the
 * tenant and installation roles with their grants (./roles.ts).
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
  DatabaseRoleError,
  ROLE_URL_VARIABLE,
  type RoleLogin,
  provisionRoles,
  roleLoginFromUrl,
} from "./roles.js";

// Resolved relative to this module, so it works from both dist/ and src/. The
// db package ships the `drizzle` and `sql` folders (see package.json "files").
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const rlsFile = fileURLToPath(new URL("../sql/rls.sql", import.meta.url));

export interface MigrationOptions {
  /**
   * The login roles to create or update after the schema is current. Omitted
   * by test fixtures that run everything as the owner.
   */
  roles?: { tenant: RoleLogin; installation: RoleLogin };
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
 * (DATABASE_URL) and the installation role (DATABASE_PROVIDER_URL) with the
 * logins those connection strings carry.
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
  await runMigrations(owner, { roles: { tenant, installation } });
}
