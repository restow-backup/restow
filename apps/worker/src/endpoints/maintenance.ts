/**
 * What every maintenance run on an endpoint's repository does around restic
 * (docs/AGENT.md, "Sperren", "Restore ohne Restow"):
 *
 *   - Locks. Before retention or a check, stale lock files (stored more than
 *     30 minutes ago) and, when no run of the agent is in progress, every
 *     lock the agent wrote are removed (@restow/core `locksToRemove`). The
 *     agent itself can delete only its own locks, so it can neither lift the
 *     server's exclusive lock nor keep one of its own in place for good
 *     without a run that the monitor closes after six hours of silence.
 *   - A repository that is still locked is counted: six attempts in a row over
 *     at least twelve hours raise `endpoint.repository_locked` once; the next
 *     run that gets the lock resets the count.
 *   - The repository password is kept sealed next to the repository, so the
 *     master key and the storage are enough to restore without the database.
 */
import {
  type RepositoryAccess,
  ensureEndpointPasswordFile,
  listLockFiles,
  locksToRemove,
  removeLockFiles,
} from "@restow/core";
import { endpointRepositoryLocks, endpointRuns, endpoints } from "@restow/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";
import { raiseEvents } from "../reporting.js";
import type { EndpointJobDeps } from "./common.js";
import { endpointName } from "./monitor.js";

/** How old a lock record must be before a missing file means the lock is gone. */
const RECORD_SETTLE_MS = 5 * 60 * 1000;

/** Locked maintenance attempts in a row before the alert, and the least time they must span. */
export const LOCKED_ALERT_ATTEMPTS = 6;
export const LOCKED_ALERT_MIN_MS = 12 * 60 * 60 * 1000;

/** The records of the lock files the client side of a repository wrote (agent, runner). */
export interface ClientLockRecords {
  /** The recorded locks and when each was recorded. */
  list(): Promise<{ name: string; createdAt: Date }[]>;
  /** Whether a run of the client is in progress (its locks are then left alone). */
  active(): Promise<boolean>;
  /** Forget the records of these locks. */
  forget(names: readonly string[]): Promise<void>;
}

/**
 * Remove the lock files that would hold maintenance up for no reason: stale ones, and every lock
 * the client wrote when no run of it is in progress (@restow/core `locksToRemove`); forget the
 * records of client locks that are gone. Shared by endpoints and file shares
 * (docs/FILESHARES.md 8.4). Returns the names of the lock files removed.
 */
export async function clearClientLocks(
  access: Pick<RepositoryAccess, "storage" | "prefix">,
  records: ClientLockRecords,
  now: Date,
): Promise<{ removed: string[]; clientActive: boolean }> {
  const rows = await records.list();
  const clientActive = await records.active();
  const clientLocks = new Set(rows.map((row) => row.name));
  // A record younger than this may belong to a lock whose upload is still on its way.
  const settled = new Set(
    rows
      .filter((row) => now.getTime() - row.createdAt.getTime() > RECORD_SETTLE_MS)
      .map((row) => row.name),
  );
  const present = await listLockFiles(access.storage, access.prefix);
  const removed = locksToRemove(present, {
    agentLocks: clientLocks,
    agentActive: clientActive,
    now,
  });
  await removeLockFiles(access.storage, access.prefix, removed);
  const stillThere = new Set(
    present.map((lock) => lock.name).filter((name) => !removed.includes(name)),
  );
  const forget = [...clientLocks].filter(
    (name) => removed.includes(name) || (!stillThere.has(name) && settled.has(name)),
  );
  if (forget.length > 0) {
    await records.forget(forget);
  }
  return { removed, clientActive };
}

/**
 * Remove the lock files that would hold maintenance up for no reason (see the
 * module comment) and forget the records of agent locks that are gone.
 * Returns how many lock files were removed.
 */
export async function clearLocksBeforeMaintenance(
  deps: EndpointJobDeps,
  tenantId: string,
  endpointId: string,
  access: Pick<RepositoryAccess, "storage" | "prefix">,
  now: Date,
): Promise<number> {
  const { removed, clientActive } = await clearClientLocks(
    access,
    {
      list: () =>
        withTenantTx(deps.db, tenantId, (tx) =>
          tx
            .select({
              name: endpointRepositoryLocks.name,
              createdAt: endpointRepositoryLocks.createdAt,
            })
            .from(endpointRepositoryLocks)
            .where(eq(endpointRepositoryLocks.endpointId, endpointId)),
        ),
      active: async () => {
        const [running] = await withTenantTx(deps.db, tenantId, (tx) =>
          tx
            .select({ id: endpointRuns.id })
            .from(endpointRuns)
            .where(and(eq(endpointRuns.endpointId, endpointId), eq(endpointRuns.status, "running")))
            .limit(1),
        );
        return running !== undefined;
      },
      forget: async (names) => {
        await withTenantTx(deps.db, tenantId, (tx) =>
          tx
            .delete(endpointRepositoryLocks)
            .where(
              and(
                eq(endpointRepositoryLocks.endpointId, endpointId),
                inArray(endpointRepositoryLocks.name, [...names]),
              ),
            ),
        );
      },
    },
    now,
  );
  if (removed.length > 0) {
    deps.runtime.logger.info("removed repository locks before maintenance", {
      tenantId,
      endpointId,
      locks: removed.length,
      agentActive: clientActive,
    });
  }
  return removed.length;
}

/**
 * Count a maintenance run that found the repository locked; raise
 * `endpoint.repository_locked` once when it has gone on long enough.
 */
export async function recordMaintenanceLocked(
  deps: EndpointJobDeps,
  tenantId: string,
  endpointId: string,
  kind: "retention" | "check",
  now: Date,
): Promise<void> {
  await withTenantTx(deps.db, tenantId, async (tx) => {
    const [endpoint] = await tx
      .update(endpoints)
      .set({
        maintenanceLockedCount: sql`${endpoints.maintenanceLockedCount} + 1`,
        maintenanceLockedSince: sql`coalesce(${endpoints.maintenanceLockedSince}, ${now})`,
      })
      .where(eq(endpoints.id, endpointId))
      .returning();
    if (
      !endpoint ||
      endpoint.lockedAlertedAt !== null ||
      endpoint.maintenanceLockedCount < LOCKED_ALERT_ATTEMPTS ||
      !endpoint.maintenanceLockedSince ||
      now.getTime() - endpoint.maintenanceLockedSince.getTime() < LOCKED_ALERT_MIN_MS
    ) {
      return;
    }
    const name = endpointName(endpoint);
    const hours = Math.floor(
      (now.getTime() - endpoint.maintenanceLockedSince.getTime()) / (60 * 60 * 1000),
    );
    await raiseEvents(
      tx,
      [
        {
          tenantId,
          level: "warning",
          event: "endpoint.repository_locked",
          message: `Retention and checks of ${name} have found its repository locked ${endpoint.maintenanceLockedCount} times in a row for ${hours} hours. A backup may be hanging, or a lock was left behind.`,
          details: {
            endpointId,
            objectName: name,
            attempts: endpoint.maintenanceLockedCount,
            lockedSince: endpoint.maintenanceLockedSince.toISOString(),
            lastAttempt: kind,
          },
        },
      ],
      now,
    );
    await tx.update(endpoints).set({ lockedAlertedAt: now }).where(eq(endpoints.id, endpointId));
  });
  deps.runtime.logger.warn("endpoint repository locked, maintenance will retry", {
    tenantId,
    endpointId,
    kind,
  });
}

/** A maintenance run got the lock: the count of locked attempts starts again. */
export async function recordMaintenanceUnlocked(
  deps: EndpointJobDeps,
  tenantId: string,
  endpointId: string,
): Promise<void> {
  await withTenantTx(deps.db, tenantId, (tx) =>
    tx
      .update(endpoints)
      .set({ maintenanceLockedCount: 0, maintenanceLockedSince: null, lockedAlertedAt: null })
      .where(
        and(
          eq(endpoints.id, endpointId),
          sql`(${endpoints.maintenanceLockedCount} > 0 OR ${endpoints.lockedAlertedAt} IS NOT NULL)`,
        ),
      ),
  );
}

/**
 * Keep the repository password sealed next to the repository (written at
 * enrollment; this backfills endpoints enrolled before, and repairs a damaged
 * copy). A failure is logged, never fatal for the job.
 */
export async function keepRepositoryPasswordFile(
  deps: EndpointJobDeps,
  tenantId: string,
  endpointId: string,
  access: Pick<RepositoryAccess, "storage" | "repositoryPassword">,
): Promise<void> {
  try {
    const keys = await deps.runtime.keyrings.get(tenantId);
    const outcome = await ensureEndpointPasswordFile(access.storage, {
      tenantId,
      endpointId,
      password: access.repositoryPassword,
      keys,
    });
    if (outcome === "written") {
      deps.runtime.logger.info("stored the sealed repository password next to the repository", {
        tenantId,
        endpointId,
      });
    }
  } catch (error) {
    deps.runtime.logger.warn("could not store the sealed repository password", {
      tenantId,
      endpointId,
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error),
    });
  }
}
