/**
 * How many connections each Postgres pool of a process may open.
 *
 * node-postgres opens at most 10 connections per pool; that stays the default of
 * every pool, so an installation that sets nothing changes nothing. A large
 * installation raises them (docs/SIZING.md): the worker runs many jobs at once,
 * and each one needs the application pool for its short transactions.
 *
 * - `RESTOW_DB_POOL_MAX`: the application pool (DATABASE_URL), in api, worker and scheduler.
 * - `RESTOW_DB_PROVIDER_POOL_MAX`: the installation pool (DATABASE_PROVIDER_URL).
 * - `RESTOW_DB_BOSS_POOL_MAX`: the pool pg-boss opens for itself in worker and scheduler.
 *
 * The api's auth pool (DATABASE_AUTH_URL) stays at the default: it only serves sign-in.
 * Postgres `max_connections` must exceed the sum of all pools of all processes.
 */

export type PoolEnv = Readonly<Record<string, string | undefined>>;

/** What node-postgres and pg-boss use when nothing is set. */
export const DEFAULT_DB_POOL_MAX = 10;

/** Upper bound: a typo (`1000000`) is refused instead of exhausting Postgres. */
export const MAX_DB_POOL_MAX = 500;

export const DB_POOL_ENV = {
  app: "RESTOW_DB_POOL_MAX",
  installation: "RESTOW_DB_PROVIDER_POOL_MAX",
  queue: "RESTOW_DB_BOSS_POOL_MAX",
} as const;

export interface DbPoolSizes {
  /** The application pool (DATABASE_URL). */
  readonly app: number;
  /** The installation pool (DATABASE_PROVIDER_URL). */
  readonly installation: number;
  /** pg-boss's own pool (worker and scheduler). */
  readonly queue: number;
}

/**
 * One pool size from the environment: unset or empty gives the default, anything else
 * must be a whole number from 1 to {@link MAX_DB_POOL_MAX}. A wrong value stops the
 * process with a message naming the variable (a silent fallback would hide a typo
 * until the pool runs dry under load).
 */
export function parseDbPoolMax(
  env: PoolEnv,
  name: string,
  fallback: number = DEFAULT_DB_POOL_MAX,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DB_POOL_MAX) {
    throw new Error(`${name} must be a whole number from 1 to ${MAX_DB_POOL_MAX}, got "${raw}"`);
  }
  return value;
}

/** The three pool sizes of a process; throws on the first invalid value. */
export function dbPoolSizesFromEnv(env: PoolEnv = process.env): DbPoolSizes {
  return {
    app: parseDbPoolMax(env, DB_POOL_ENV.app),
    installation: parseDbPoolMax(env, DB_POOL_ENV.installation),
    queue: parseDbPoolMax(env, DB_POOL_ENV.queue),
  };
}

/**
 * The warning for a worker whose application pool is smaller than its jobs need, or null.
 * Every running job uses a connection for its short transactions (progress, chunk index,
 * refcounts at commit) and the process keeps a few for itself (heartbeat, cancel checks),
 * so `WORKER_CONCURRENCY` jobs plus {@link WORKER_POOL_HEADROOM} should fit.
 */
export const WORKER_POOL_HEADROOM = 2;

export function workerPoolWarning(input: {
  readonly concurrency: number;
  readonly poolMax: number;
}): string | null {
  const needed = input.concurrency + WORKER_POOL_HEADROOM;
  if (input.poolMax >= needed) {
    return null;
  }
  return (
    `${DB_POOL_ENV.app}=${input.poolMax} is smaller than WORKER_CONCURRENCY=${input.concurrency} ` +
    `plus ${WORKER_POOL_HEADROOM}: jobs will wait for a database connection. ` +
    `Set ${DB_POOL_ENV.app} to at least ${needed} (and keep Postgres max_connections above ` +
    "the sum of all pools, docs/SIZING.md)."
  );
}
