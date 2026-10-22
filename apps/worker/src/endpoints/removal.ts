/**
 * `endpoint-removal` (release 0.4.5, #65): delete the backups of a machine an admin removed
 * from Restow (@restow/db `EndpointRemoval`; the api accepts the removal, features/endpoints/
 * removal.ts). Due when `endpoints.removal_due_at` has come: at once for "delete", at the end of
 * the machine's retention for "expire". The scheduler hands every due one over each minute.
 *
 *   held       a legal hold over the whole tenant, or a suspicious restore point of the machine
 *              nobody resolved (suspicion/holds.ts), keeps everything: nothing is deleted, and
 *              the worker looks again a day later.
 *   deleting   every object under `endpoints/<id>/`, on every target of the tenant that may hold
 *              files of the repository: the primary, its copies and retired primaries a "keep"
 *              switch left (a machine that backed up before the switch has its old chain there).
 *              Never beside retention, the check or a restore test of the repository.
 *   deferred   objects the storage still locks (S3 Object Lock, a directory's deletion delay)
 *              stay; each is recorded like a refused prune (immutability_deferred_deletions), so
 *              the renewal leaves it to run out (handlers/immutability.ts skips removed
 *              machines), and the worker tries again once the latest lock has run out.
 *   done       nothing of the repository is left: the repository password, the stored samples
 *              and the snapshot marks go as well. The machine's row stays (a tombstone) with its
 *              runs and reports, for the history and the audit trail.
 *
 * Every step that changes the state is audited (`endpoint.removal.*`, actor `system`).
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  endpointPrefix,
  lockedErrorOf,
  resticCacheBase,
  type StorageBackend,
  type StorageTargets,
} from "@restow/core";
import {
  type Endpoint,
  type EndpointRemoval,
  endpointSamples,
  endpointSnapshotFlags,
  endpoints,
  legalHolds,
  secrets,
} from "@restow/db";
import { and, eq, isNull } from "drizzle-orm";
import { appendAuditEntry } from "../audit.js";
import { withTenantTx } from "../handlers/framework.js";
import { recordDeferredDeletion } from "../handlers/immutability.js";
import { loadRetentionHolds, retentionHeld, retentionHoldMode } from "../suspicion/holds.js";
import {
  type EndpointJobDeps,
  loadEndpoint,
  reportableMessage,
  withMaintenanceLock,
} from "./common.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** After the latest lock ran out, wait this long before trying again (clock skew of the storage). */
const AFTER_LOCK_MS = 60 * 60 * 1000;

export const ENDPOINT_REMOVAL_AUDIT_ACTIONS = {
  held: "endpoint.removal.held",
  deferred: "endpoint.removal.deferred",
  completed: "endpoint.removal.completed",
  failed: "endpoint.removal.failed",
} as const;

export type EndpointRemovalOutcome =
  | { state: "skipped" }
  | { state: "held"; heldBy: "legal_hold" | "suspicion" }
  | { state: "deferred"; deleted: number; locked: number; lockedUntil: Date | null }
  | { state: "done"; deleted: number };

/** Every target that may hold files of the tenant's restic repositories, each once. */
export function repositoryTargets(
  storage: StorageTargets & { readonly previous?: readonly StorageBackend[] },
): StorageBackend[] {
  const all = [storage.primary, ...storage.copies, ...(storage.previous ?? [])];
  return all.filter((backend, index) => all.indexOf(backend) === index);
}

/** The worker's restic cache of the repository; a missing one is fine. */
async function removeCache(endpointId: string): Promise<void> {
  await rm(join(resticCacheBase(), endpointId), { recursive: true, force: true }).catch(
    () => undefined,
  );
}

async function tenantLegalHold(deps: EndpointJobDeps, tenantId: string): Promise<boolean> {
  const rows = await withTenantTx(deps.db, tenantId, (tx) =>
    tx
      .select({ id: legalHolds.id })
      .from(legalHolds)
      .where(
        and(
          eq(legalHolds.tenantId, tenantId),
          eq(legalHolds.active, true),
          isNull(legalHolds.protectedObjectId),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

async function saveRemoval(
  deps: EndpointJobDeps,
  endpoint: Endpoint,
  removal: EndpointRemoval,
  dueAt: Date | null,
  audit: { action: string; details: Record<string, unknown> } | null,
  extra: Partial<Pick<Endpoint, "repositorySecretId" | "repositoryBytes" | "lastSnapshotId">> = {},
): Promise<void> {
  await withTenantTx(deps.db, endpoint.tenantId, async (tx) => {
    await tx
      .update(endpoints)
      .set({ removal, removalDueAt: dueAt, ...extra })
      .where(eq(endpoints.id, endpoint.id));
    if (audit) {
      await appendAuditEntry(tx, {
        tenantId: endpoint.tenantId,
        actor: "system",
        action: audit.action,
        target: endpoint.id,
        targetType: "endpoint",
        details: { hostname: endpoint.hostname, ...audit.details },
      });
    }
  });
}

/** Delete every object under `prefix` on `backend`; what the storage still locks is counted. */
async function deleteUnder(
  deps: EndpointJobDeps,
  tenantId: string,
  backend: StorageBackend,
  prefix: string,
): Promise<{ deleted: number; locked: number; lockedUntil: Date | null; unknownUntil: boolean }> {
  let deleted = 0;
  let locked = 0;
  let lockedUntil: Date | null = null;
  let unknownUntil = false;
  for (const key of await backend.list(prefix)) {
    deps.runtime.shutdownSignal?.throwIfAborted();
    try {
      await backend.delete(key);
      deleted++;
    } catch (error) {
      const refusal = lockedErrorOf(error);
      if (!refusal) {
        throw error;
      }
      locked++;
      await recordDeferredDeletion(deps.db, tenantId, backend, key, refusal.retainUntil);
      if (!refusal.retainUntil) {
        unknownUntil = true;
      } else if (!lockedUntil || refusal.retainUntil > lockedUntil) {
        lockedUntil = refusal.retainUntil;
      }
    }
  }
  return { deleted, locked, lockedUntil, unknownUntil };
}

export async function endpointRemoval(
  deps: EndpointJobDeps,
  payload: { tenantId: string; endpointId: string },
): Promise<EndpointRemovalOutcome> {
  const { tenantId, endpointId } = payload;
  const endpoint = await loadEndpoint(deps, tenantId, endpointId);
  const now = deps.runtime.now();
  if (
    !endpoint?.removedAt ||
    !endpoint.removal ||
    endpoint.removal.state === "done" ||
    !endpoint.removalDueAt ||
    endpoint.removalDueAt > now
  ) {
    return { state: "skipped" };
  }
  const removal: EndpointRemoval = { ...endpoint.removal, attemptedAt: now.toISOString() };

  // Holds: nothing is deleted while one stands; looked at again a day later.
  let heldBy: "legal_hold" | "suspicion" | null = null;
  if (await tenantLegalHold(deps, tenantId)) {
    heldBy = "legal_hold";
  } else {
    const mode = await retentionHoldMode(deps.providerDb);
    const holds = await withTenantTx(deps.db, tenantId, (tx) =>
      loadRetentionHolds(tx, { tenantId, kind: "endpoint", objectIds: [endpointId], now, mode }),
    );
    if (retentionHeld(holds, endpointId)) {
      heldBy = "suspicion";
    }
  }
  if (heldBy) {
    const changed = removal.state !== "held" || removal.heldBy !== heldBy;
    await saveRemoval(
      deps,
      endpoint,
      { ...removal, state: "held", heldBy, lastError: null },
      new Date(now.getTime() + DAY_MS),
      changed ? { action: ENDPOINT_REMOVAL_AUDIT_ACTIONS.held, details: { heldBy } } : null,
    );
    deps.runtime.logger.info("removed machine's backups held", { tenantId, endpointId, heldBy });
    return { state: "held", heldBy };
  }

  const targets = repositoryTargets(await deps.runtime.storage.get(tenantId));
  const prefix = endpointPrefix(endpointId);
  let result: Awaited<ReturnType<typeof deleteUnder>>;
  try {
    result = await withMaintenanceLock(deps, endpointId, "exclusive", async () => {
      const total = {
        deleted: 0,
        locked: 0,
        lockedUntil: null as Date | null,
        unknownUntil: false,
      };
      for (const backend of targets) {
        const part = await deleteUnder(deps, tenantId, backend, prefix);
        total.deleted += part.deleted;
        total.locked += part.locked;
        total.unknownUntil ||= part.unknownUntil;
        if (part.lockedUntil && (!total.lockedUntil || part.lockedUntil > total.lockedUntil)) {
          total.lockedUntil = part.lockedUntil;
        }
      }
      return total;
    });
  } catch (error) {
    // Recorded for the list of removals; pg-boss and the scheduler try again.
    await saveRemoval(
      deps,
      endpoint,
      { ...removal, lastError: reportableMessage(error) },
      endpoint.removalDueAt,
      removal.lastError
        ? null
        : {
            action: ENDPOINT_REMOVAL_AUDIT_ACTIONS.failed,
            details: { errorMessage: reportableMessage(error) },
          },
    ).catch(() => undefined);
    throw error;
  }
  const deletedObjects = (removal.deletedObjects ?? 0) + result.deleted;

  if (result.locked > 0) {
    // Without a known retain-until, look again in a day.
    const dueAt =
      result.lockedUntil && !result.unknownUntil
        ? new Date(result.lockedUntil.getTime() + AFTER_LOCK_MS)
        : new Date(now.getTime() + DAY_MS);
    const lockedUntil = result.lockedUntil?.toISOString() ?? null;
    const changed = removal.state !== "deferred" || removal.lockedUntil !== lockedUntil;
    await saveRemoval(
      deps,
      endpoint,
      {
        ...removal,
        state: "deferred",
        heldBy: null,
        lockedUntil,
        lockedObjects: result.locked,
        deletedObjects,
        lastError: null,
      },
      dueAt,
      changed
        ? {
            action: ENDPOINT_REMOVAL_AUDIT_ACTIONS.deferred,
            details: { lockedObjects: result.locked, lockedUntil, deletedObjects },
          }
        : null,
    );
    deps.runtime.logger.info("removed machine's backups partly locked, deletion deferred", {
      tenantId,
      endpointId,
      locked: result.locked,
      lockedUntil,
    });
    return {
      state: "deferred",
      deleted: result.deleted,
      locked: result.locked,
      lockedUntil: result.lockedUntil,
    };
  }

  await withTenantTx(deps.db, tenantId, async (tx) => {
    await tx.delete(endpointSamples).where(eq(endpointSamples.endpointId, endpointId));
    await tx.delete(endpointSnapshotFlags).where(eq(endpointSnapshotFlags.endpointId, endpointId));
    await tx
      .update(endpoints)
      .set({
        removal: {
          ...removal,
          state: "done",
          heldBy: null,
          lockedUntil: null,
          lockedObjects: 0,
          deletedObjects,
          lastError: null,
          completedAt: now.toISOString(),
        },
        removalDueAt: null,
        repositorySecretId: null,
        repositoryBytes: null,
        repositoryMeasuredAt: now,
        lastSnapshotId: null,
      })
      .where(eq(endpoints.id, endpointId));
    if (endpoint.repositorySecretId) {
      await tx.delete(secrets).where(eq(secrets.id, endpoint.repositorySecretId));
    }
    await appendAuditEntry(tx, {
      tenantId,
      actor: "system",
      action: ENDPOINT_REMOVAL_AUDIT_ACTIONS.completed,
      target: endpointId,
      targetType: "endpoint",
      details: {
        hostname: endpoint.hostname,
        mode: removal.mode,
        deletedObjects,
        repositoryBytes: endpoint.repositoryBytes,
      },
    });
  });
  await removeCache(endpointId);
  deps.runtime.logger.info("removed machine's backups deleted", {
    tenantId,
    endpointId,
    deleted: deletedObjects,
  });
  return { state: "done", deleted: result.deleted };
}
