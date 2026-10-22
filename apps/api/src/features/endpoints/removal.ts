import {
  DEFAULT_ENDPOINT_RETENTION,
  ENDPOINT_QUEUES,
  type EndpointJobPayload,
  endpointSingletonKey,
  retentionExpiry,
} from "@restow/core";
import {
  backupJobMembers,
  type Database,
  type Endpoint,
  type EndpointRemoval,
  type EndpointRemovalMode,
  endpoints,
  legalHolds,
  suspicionHolds,
} from "@restow/db";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { pgBossExecutor } from "../jobs/pg-boss-tx.js";
import { jobQueue } from "../jobs/queue.js";
import { auditEndpoint, ENDPOINT_AUDIT_ACTIONS, type EndpointActor } from "./audit.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";

/**
 * Removing a machine from Restow (release 0.4.5, #65; @restow/db `EndpointRemoval` has the
 * states). Only a revoked machine is removed, with its hostname typed and a recent sign-in
 * (routes.ts): from then on it is left out of every list, picker, dashboard and counter, while its
 * runs, reports and audit entries stay. Its backups are deleted by the worker
 * (`endpoint-removal`), at once (`delete`) or when the machine's retention lets the newest one go
 * (`expire`). Nothing is deleted here.
 *
 * Deleting at once is refused while something holds the backups: a legal hold over the whole
 * tenant (a machine is no protected object, so only such a hold covers it), or a suspicious
 * restore point of the machine nobody resolved (docs/RANSOMWARE.md, "Retention hold"). Keeping
 * the backups until they expire is accepted: the worker waits for the hold when the day comes.
 * Objects the storage still locks (S3 Object Lock, a directory's deletion delay) cannot be
 * refused here, the storage tells only when asked to delete: the worker defers them until their
 * lock runs out, and the list of removals says until when.
 */

export interface RemoveEndpointInput {
  mode: EndpointRemovalMode;
  /** The machine's hostname, typed by the admin. */
  confirmHostname: string;
}

export interface EndpointRemovalDto {
  id: string;
  hostname: string;
  displayName: string | null;
  mode: EndpointRemovalMode;
  state: EndpointRemoval["state"];
  requestedAt: string;
  requestedBy: string;
  /** When the worker deletes the backups next; null once nothing is left to do. */
  dueAt: string | null;
  /** `expire`: when the retention lets the newest backup go. */
  expiresAt: string | null;
  heldBy: EndpointRemoval["heldBy"] | null;
  /** `deferred`: until when the storage still locks objects of the repository. */
  lockedUntil: string | null;
  lockedObjects: number;
  deletedObjects: number;
  /** Bytes the repository took when last measured; null when unknown or deleted. */
  repositoryBytes: number | null;
  lastError: string | null;
}

export interface RemovalOptions {
  /** The installation lets suspicion hold deletions (`retentionHold.enabled`, default on). */
  suspicionHoldsApply?: boolean;
  now?: Date;
}

export function toRemovalDto(endpoint: Endpoint): EndpointRemovalDto | null {
  const removal = endpoint.removal;
  if (!removal || !endpoint.removedAt) {
    return null;
  }
  return {
    id: endpoint.id,
    hostname: endpoint.hostname,
    displayName: endpoint.displayName,
    mode: removal.mode,
    state: removal.state,
    requestedAt: removal.requestedAt,
    requestedBy: removal.requestedBy,
    dueAt: endpoint.removalDueAt?.toISOString() ?? null,
    expiresAt: removal.expiresAt ?? null,
    heldBy: removal.heldBy ?? null,
    lockedUntil: removal.lockedUntil ?? null,
    lockedObjects: removal.lockedObjects ?? 0,
    deletedObjects: removal.deletedObjects ?? 0,
    repositoryBytes: removal.state === "done" ? null : endpoint.repositoryBytes,
    lastError: removal.lastError ?? null,
  };
}

/** An active legal hold over the whole tenant (one without a protected object). */
export async function tenantLegalHold(tx: Transaction, tenantId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: legalHolds.id })
    .from(legalHolds)
    .where(
      and(
        eq(legalHolds.tenantId, tenantId),
        eq(legalHolds.active, true),
        isNull(legalHolds.protectedObjectId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * When the backups of a removed machine expire: its retention, from its newest backup (or now,
 * for a machine that never delivered one). Null when the retention keeps everything.
 */
export function removalExpiry(endpoint: Endpoint, now: Date): Date | null {
  const rules = endpoint.settings.retention ?? DEFAULT_ENDPOINT_RETENTION;
  const newest = endpoint.lastSuccessAt ?? endpoint.lastBackupAt;
  if (!newest) {
    return now;
  }
  const expiry = retentionExpiry(newest, rules);
  if (!expiry) {
    return null;
  }
  return expiry < now ? now : expiry;
}

function confirmMismatch(): ProblemError {
  return new ProblemError(422, "Hostname does not match", {
    type: ENDPOINT_PROBLEMS.confirmHostname,
    detail: "Type the hostname of the machine exactly to remove it.",
    extensions: { field: "confirmHostname" },
  });
}

/** Remove a revoked machine (see the file comment). */
export async function removeEndpoint(
  database: Database,
  tenantId: string,
  id: string,
  input: RemoveEndpointInput,
  actor: EndpointActor,
  options: RemovalOptions = {},
): Promise<EndpointRemovalDto> {
  const now = options.now ?? new Date();
  return withTenantTx(database, tenantId, async (tx) => {
    const [endpoint] = await tx
      .select()
      .from(endpoints)
      .where(
        and(eq(endpoints.tenantId, tenantId), eq(endpoints.id, id), isNull(endpoints.removedAt)),
      )
      .limit(1)
      .for("update");
    if (!endpoint) {
      throw new ProblemError(404, "Endpoint not found");
    }
    if (endpoint.status !== "revoked") {
      throw new ProblemError(409, "Endpoint not revoked", {
        type: ENDPOINT_PROBLEMS.notRevoked,
        detail:
          "Only a revoked machine can be removed. Revoke it first (or wait until its agent uninstalled itself).",
      });
    }
    if (input.confirmHostname.trim() !== endpoint.hostname) {
      throw confirmMismatch();
    }
    if (input.mode === "delete") {
      if (await tenantLegalHold(tx, tenantId)) {
        throw new ProblemError(409, "Legal hold", {
          type: ENDPOINT_PROBLEMS.removalLegalHold,
          detail:
            "A legal hold covers every backup of this tenant, so the backups of this machine cannot be deleted now. Keep them until they expire instead, or release the hold first.",
        });
      }
      if (options.suspicionHoldsApply !== false) {
        const held = await suspicionHolds(tx, { tenantId, kind: "endpoint", objectIds: [id] });
        if (held.has(id)) {
          throw new ProblemError(409, "Suspicion hold", {
            type: ENDPOINT_PROBLEMS.removalSuspicionHold,
            detail:
              "This machine has a suspicious restore point nobody resolved, which holds its backups. Resolve it on the machine's ransomware page first, or keep the backups until they expire.",
          });
        }
      }
    }
    let dueAt = now;
    let expiresAt: Date | null = null;
    if (input.mode === "expire") {
      expiresAt = removalExpiry(endpoint, now);
      if (!expiresAt) {
        throw new ProblemError(409, "Retention keeps everything", {
          type: ENDPOINT_PROBLEMS.removalNeverExpires,
          detail:
            "The retention of this machine keeps every backup, so they would never expire. Delete them instead, or set a retention first.",
        });
      }
      dueAt = expiresAt;
    }
    const removal: EndpointRemoval = {
      mode: input.mode,
      state: "scheduled",
      requestedBy: actor.label,
      requestedAt: now.toISOString(),
      expiresAt: expiresAt?.toISOString() ?? null,
      deletedObjects: 0,
    };
    const [updated] = await tx
      .update(endpoints)
      .set({ removedAt: now, removal, removalDueAt: dueAt })
      .where(eq(endpoints.id, id))
      .returning();
    // Out of its backup job: the job's machines are listed from its members.
    const left = await tx
      .delete(backupJobMembers)
      .where(and(eq(backupJobMembers.tenantId, tenantId), eq(backupJobMembers.endpointId, id)))
      .returning({ jobId: backupJobMembers.jobId });
    let queued = false;
    if (input.mode === "delete") {
      queued = await queueRemoval(database, tx, tenantId, id);
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.removed,
      endpointId: id,
      details: {
        hostname: endpoint.hostname,
        mode: input.mode,
        expiresAt: removal.expiresAt,
        repositoryBytes: endpoint.repositoryBytes,
        leftJobs: left.map((row) => row.jobId),
        queued,
      },
    });
    const dto = updated ? toRemovalDto(updated) : null;
    if (!dto) {
      throw new Error("endpoint update returned no row");
    }
    return dto;
  });
}

/**
 * Hand the deletion to the worker now. Without the job queue (the worker has not started yet)
 * the scheduler hands it over within a minute anyway, from `removal_due_at`, so no failure to
 * queue fails the removal.
 */
async function queueRemoval(
  database: Database,
  tx: Transaction,
  tenantId: string,
  endpointId: string,
): Promise<boolean> {
  const payload: EndpointJobPayload = { tenantId, endpointId };
  try {
    // In a savepoint: a queue that is not there yet must not abort the removal's transaction.
    return await tx.transaction(async (savepoint) => {
      const jobId = await jobQueue(database).send(ENDPOINT_QUEUES.removal, payload, {
        singletonKey: endpointSingletonKey(ENDPOINT_QUEUES.removal, endpointId),
        db: pgBossExecutor(savepoint),
      });
      return jobId !== null && jobId !== undefined;
    });
  } catch {
    // The queue is not there yet (the worker or the scheduler creates it at start), or pg-boss
    // refused: the removal stands, and the scheduler hands it over from `removal_due_at`.
    return false;
  }
}

/** The removed machines whose backups are not deleted yet, the next deletion first. */
export async function listRemovals(
  database: Database,
  tenantId: string,
): Promise<{ items: EndpointRemovalDto[] }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(endpoints)
      .where(
        and(
          eq(endpoints.tenantId, tenantId),
          isNotNull(endpoints.removedAt),
          isNotNull(endpoints.removalDueAt),
        ),
      )
      .orderBy(asc(endpoints.removalDueAt), asc(endpoints.hostname))
      .limit(500);
    return {
      items: rows.flatMap((row) => {
        const dto = toRemovalDto(row);
        return dto ? [dto] : [];
      }),
    };
  });
}
