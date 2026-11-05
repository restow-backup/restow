import { createDb, type Queryable, readRestoreMode } from "@restow/db";
import { appliedMigrationCount, shippedMigrationCount } from "@restow/db/migrate";
import { BEFORE_RESTORE_INFIX, SCRATCH_DATABASE } from "./report.js";

/**
 * Putting a prepared restore live (prepare.ts ran on the scratch database and the operator
 * confirmed): the live database is renamed to `<live>_before_restore_<stamp>` (the fresh,
 * empty database of this installation, kept so nothing is lost) and the scratch database takes
 * its name. Runs as the owner on the `postgres` maintenance database, with the api, the worker
 * and the scheduler stopped (the updater and install.sh stop them; open sessions of either
 * database are ended anyway).
 *
 * It refuses a scratch database that is not prepared: restore mode must be on with source
 * `setup` and the migrations must be this release's. Resumable: a swap cut off half way (the live
 * database renamed away, the scratch one not yet renamed) is finished on the next call, and a
 * restore that is live already answers `already_active`.
 */

export class ActivationRefusedError extends Error {
  constructor(
    readonly code: "not_prepared" | "nothing_to_activate",
    message: string,
  ) {
    super(message);
    this.name = "ActivationRefusedError";
  }
}

export interface ActivationResult {
  readonly status: "activated" | "already_active";
  /** The fresh database set aside (`<live>_before_restore_<stamp>`), when this call renamed one. */
  readonly previous: string | null;
}

const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function quoted(name: string): string {
  if (!DATABASE_NAME.test(name)) {
    throw new Error(`invalid database name "${name}"`);
  }
  return `"${name}"`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** The database a connection string names. */
export function databaseOf(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!DATABASE_NAME.test(name)) {
    throw new Error("The connection string names no usable database.");
  }
  return name;
}

/** The owner's connection string of another database on the same server. */
export function ownerUrlFor(ownerUrl: string, database: string): string {
  quoted(database);
  return withDatabase(ownerUrl, database);
}

function stampOf(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "z")
    .toLowerCase();
}

async function exists(admin: Queryable, name: string): Promise<boolean> {
  const { rows } = await admin.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [name],
  );
  return rows[0]?.exists === true;
}

async function endSessions(admin: Queryable, name: string): Promise<void> {
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [name],
  );
}

/** Restore mode with source `setup` is on and the migrations are this release's. */
async function prepared(url: string): Promise<{ ok: boolean; reason: string }> {
  const pool = createDb(url, { max: 1 }).$client;
  const client: Queryable = pool;
  try {
    const state = await readRestoreMode(client);
    if (!state.active || state.source !== "setup") {
      return { ok: false, reason: "restore mode of the restore is not on in it" };
    }
    const applied = await appliedMigrationCount(client);
    const shipped = shippedMigrationCount();
    if (applied !== shipped) {
      return {
        ok: false,
        reason: `it has ${applied ?? "no"} migrations, this release ${shipped}`,
      };
    }
    return { ok: true, reason: "" };
  } finally {
    await pool.end();
  }
}

export async function activateRestoredDatabase(options: {
  /** The owner's connection string of the live database (DATABASE_MIGRATION_URL). */
  readonly ownerUrl: string;
  readonly scratch?: string;
  readonly now?: () => Date;
}): Promise<ActivationResult> {
  const live = databaseOf(options.ownerUrl);
  const scratch = options.scratch ?? SCRATCH_DATABASE;
  quoted(scratch);
  const pool = createDb(withDatabase(options.ownerUrl, "postgres"), { max: 1 }).$client;
  const admin: Queryable = pool;
  try {
    const liveExists = await exists(admin, live);
    if (!(await exists(admin, scratch))) {
      if (liveExists) {
        const check = await prepared(options.ownerUrl);
        if (check.ok) {
          return { status: "already_active", previous: null };
        }
      }
      throw new ActivationRefusedError(
        "nothing_to_activate",
        `There is no prepared restore to activate (no database ${scratch}).`,
      );
    }
    const check = await prepared(withDatabase(options.ownerUrl, scratch));
    if (!check.ok) {
      throw new ActivationRefusedError(
        "not_prepared",
        `The restored database ${scratch} is not prepared (${check.reason}); run restow restore prepare first.`,
      );
    }
    let previous: string | null = null;
    if (liveExists) {
      previous = `${live}${BEFORE_RESTORE_INFIX}${stampOf((options.now ?? (() => new Date()))())}`;
      await admin.query(`ALTER DATABASE ${quoted(live)} WITH ALLOW_CONNECTIONS false`);
      await endSessions(admin, live);
      await admin.query(`ALTER DATABASE ${quoted(live)} RENAME TO ${quoted(previous)}`);
    }
    await endSessions(admin, scratch);
    await admin.query(`ALTER DATABASE ${quoted(scratch)} RENAME TO ${quoted(live)}`);
    await admin.query(`ALTER DATABASE ${quoted(live)} WITH ALLOW_CONNECTIONS true`);
    return { status: "activated", previous };
  } finally {
    await pool.end();
  }
}

/** Drop the scratch database (a refused or aborted restore). Missing is fine. */
export async function dropScratchDatabase(
  ownerUrl: string,
  scratch = SCRATCH_DATABASE,
): Promise<void> {
  const pool = createDb(withDatabase(ownerUrl, "postgres"), { max: 1 }).$client;
  try {
    await pool.query(`DROP DATABASE IF EXISTS ${quoted(scratch)} WITH (FORCE)`);
  } finally {
    await pool.end();
  }
}
