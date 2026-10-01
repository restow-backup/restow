/**
 * One lock per endpoint repository across every process of the installation
 * (api and worker), held in Postgres as a session-level advisory lock
 * (docs/AGENT.md, "Aufbewahrung, Prüfung, Restore-Test").
 *
 * restic locks its repositories itself, but two restic processes started at
 * the same moment can both miss each other's lock, and a restore test that
 * reads while a prune rewrites packs reports sound data as damaged. So the
 * server never lets its own work on one repository overlap:
 *
 *   exclusive   retention (forget and prune) and the repository check;
 *   shared      the restore test and the API's reads (snapshot list,
 *               browsing, downloads), which may run side by side.
 *
 * A caller that does not get the lock within `waitMs` gets an
 * {@link EndpointRepositoryBusyError}: a job is retried later, a request is
 * answered with "repository busy". The lock lives on one pooled connection
 * for as long as it is held and is released on that same connection.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";

/** The first key of every repository lock (an arbitrary constant: "RSTR"). */
const LOCK_CLASS = 0x52535452;

export type RepositoryLockMode = "exclusive" | "shared";

export interface RepositoryLockOptions {
  mode: RepositoryLockMode;
  /** How long to keep trying before giving up; 0 tries once. */
  waitMs?: number;
  /** Pause between two attempts while waiting. */
  pollMs?: number;
}

/** Another holder had the repository for longer than the caller was willing to wait. */
export class EndpointRepositoryBusyError extends Error {
  constructor(readonly endpointId: string) {
    super(`the repository of endpoint ${endpointId} is busy with other work of the server`);
    this.name = "EndpointRepositoryBusyError";
  }
}

const TRY = {
  exclusive: "pg_try_advisory_lock",
  shared: "pg_try_advisory_lock_shared",
} as const;
const UNLOCK = {
  exclusive: "pg_advisory_unlock",
  shared: "pg_advisory_unlock_shared",
} as const;

/**
 * Take the lock of an endpoint's repository. Resolves with the function that
 * releases it (call it exactly once; later calls do nothing).
 */
export async function acquireEndpointRepositoryLock(
  pool: Pool,
  endpointId: string,
  options: RepositoryLockOptions,
): Promise<() => Promise<void>> {
  const client: PoolClient = await pool.connect();
  const deadline = Date.now() + (options.waitMs ?? 0);
  try {
    for (;;) {
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT ${TRY[options.mode]}($1, hashtext($2)) AS ok`,
        [LOCK_CLASS, endpointId],
      );
      if (rows[0]?.ok) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new EndpointRepositoryBusyError(endpointId);
      }
      await sleep(Math.min(options.pollMs ?? 1000, Math.max(1, deadline - Date.now())));
    }
  } catch (error) {
    client.release();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    try {
      await client.query(`SELECT ${UNLOCK[options.mode]}($1, hashtext($2))`, [
        LOCK_CLASS,
        endpointId,
      ]);
      client.release();
    } catch (error) {
      // A connection whose lock could not be released must not go back into the pool.
      client.release(error instanceof Error ? error : true);
    }
  };
}

/** Run `work` while holding the lock of an endpoint's repository. */
export async function withEndpointRepositoryLock<T>(
  pool: Pool,
  endpointId: string,
  options: RepositoryLockOptions,
  work: () => Promise<T>,
): Promise<T> {
  const release = await acquireEndpointRepositoryLock(pool, endpointId, options);
  try {
    return await work();
  } finally {
    await release();
  }
}
