/**
 * Work that writes to or deletes from a tenant's restic repositories on the primary runs under the
 * tenant's repository-copy lock, shared (docs/STORAGE.md, "Promoting a copy"): the copy pass, a
 * machine's retention and removal, a file share's retention and purge, the retention of
 * containers. A promotion of a copy target takes the lock exclusively while it switches the
 * primary, so none of them runs beside the switch or goes on deleting on a primary the promotion
 * just retired; each resolves its storage after it has the lock.
 */
import {
  acquireEndpointRepositoryLock,
  type Database,
  EndpointRepositoryBusyError,
  repositoryCopiesLockKey,
  withEndpointRepositoryLock,
} from "@restow/db";

/**
 * How long a queued job waits for a promotion to end before it gives up and pg-boss tries it
 * again. A promotion holds the lock while it lists the tenant's repositories (each listing at most
 * five minutes, four at a time) and switches; half an hour covers that for a tenant of usual size,
 * and the retries (5, 10, 20 minutes later) a larger one, so a normal promotion never uses up a
 * job's attempts.
 */
export const PROMOTION_WAIT_MS = 30 * 60 * 1000;
const PROMOTION_POLL_MS = 5_000;

/** Run `work` under the lock, waiting for a promotion; busy past the wait: `EndpointRepositoryBusyError`. */
export function besidePromotion<T>(
  db: Pick<Database, "$client">,
  tenantId: string,
  work: () => Promise<T>,
  waitMs: number = PROMOTION_WAIT_MS,
): Promise<T> {
  return withEndpointRepositoryLock(
    db.$client,
    repositoryCopiesLockKey(tenantId),
    { mode: "shared", waitMs, pollMs: Math.min(PROMOTION_POLL_MS, Math.max(1, waitMs)) },
    work,
  );
}

/**
 * Run `work` under the lock if no promotion holds it now, else leave it for a later pass (`null`):
 * for the periodic passes, which come round again by themselves.
 */
export async function unlessPromoting<T>(
  db: Pick<Database, "$client">,
  tenantId: string,
  work: () => Promise<T>,
): Promise<T | null> {
  let release: () => Promise<void>;
  try {
    release = await acquireEndpointRepositoryLock(db.$client, repositoryCopiesLockKey(tenantId), {
      mode: "shared",
      waitMs: 0,
    });
  } catch (error) {
    if (error instanceof EndpointRepositoryBusyError) {
      return null;
    }
    throw error;
  }
  try {
    return await work();
  } finally {
    await release();
  }
}
