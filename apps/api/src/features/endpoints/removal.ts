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
  type InstallationZoneInput,
  legalHolds,
  raiseReportEvents,
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
 * (routes.ts). Its backups are deleted by the worker (`endpoint-removal`), never here:
 *
 *   expire   (tenant admins) the machine leaves every list, picker, dashboard and counter at
 *            once, its runs, reports and audit entries stay; the backups go when the machine's
 *            retention lets the newest one go.
 *   delete   (provider owners only, with a reason; 0.5.0) the backups go
 *            {@link BACKUP_DELETION_DELAY_DAYS} days after the request. Until the worker starts,
 *            the machine stays listed as revoked with the date, the request can be cancelled
 *            ({@link cancelRemoval}), and the provider's mandatory recipients are alerted at once
 *            (`endpoint.backups_deletion_scheduled`, a critical event). Once the worker starts it
 *            removes the machine like `expire` does and can no longer be cancelled.
 *
 * Deleting at once is refused while something holds the backups: a legal hold over the whole
 * tenant (a machine is no protected object, so only such a hold covers it), or a suspicious
 * restore point of the machine nobody resolved (docs/RANSOMWARE.md, "Retention hold"). Keeping
 * the backups until they expire is accepted: the worker waits for the hold when the day comes.
 * Objects the storage still locks (S3 Object Lock, a directory's deletion delay) cannot be
 * refused here, the storage tells only when asked to delete: the worker defers them until their
 * lock runs out, and the list of removals says until when.
 */

/**
 * How long a requested deletion of a machine's backups waits before the worker starts (0.5.0):
 * time for the provider's mandatory recipients, alerted at once, to cancel a deletion nobody
 * wanted. docs/AGENT.md, "Rechner entfernen".
 */
export const BACKUP_DELETION_DELAY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RemoveEndpointInput {
  mode: EndpointRemovalMode;
  /** The machine's hostname, typed by the admin. */
  confirmHostname: string;
  /** `delete`: why (required, kept in the audit entry and on the removal). */
  reason?: string;
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
  /** `delete`: why, as the requester gave it. */
  reason: string | null;
  /** `delete`: the worker has not started yet, so the deletion can still be cancelled. */
  cancellable: boolean;
}

export interface RemovalOptions {
  /** The installation lets suspicion hold deletions (`retentionHold.enabled`, default on). */
  suspicionHoldsApply?: boolean;
  /** For the digest hour of the alert (packages/db raiseReportEvents). */
  installationTimeZone?: InstallationZoneInput;
  now?: Date;
}

/**
 * A requested deletion of the backups that has not started yet (`delete` before the worker
 * started): the machine is still listed, and the deletion can be cancelled.
 */
export function isCancellableRemoval(endpoint: Endpoint): boolean {
  const removal = endpoint.removal;
  return (
    removal?.mode === "delete" &&
    endpoint.removedAt === null &&
    !removal.startedAt &&
    (removal.state === "scheduled" || removal.state === "held")
  );
}

/** What the machine page and File restore show of a pending deletion (null for none). */
export interface PendingBackupDeletionDto {
  dueAt: string;
  requestedAt: string;
  requestedBy: string;
  reason: string | null;
  state: "scheduled" | "held";
  heldBy: "legal_hold" | "suspicion" | null;
}

export function pendingBackupDeletion(endpoint: Endpoint): PendingBackupDeletionDto | null {
  const removal = endpoint.removal;
  if (!removal || !endpoint.removalDueAt || !isCancellableRemoval(endpoint)) {
    return null;
  }
  return {
    dueAt: endpoint.removalDueAt.toISOString(),
    requestedAt: removal.requestedAt,
    requestedBy: removal.requestedBy,
    reason: removal.reason ?? null,
    state: removal.state === "held" ? "held" : "scheduled",
    heldBy: removal.heldBy ?? null,
  };
}

export function toRemovalDto(endpoint: Endpoint): EndpointRemovalDto | null {
  const removal = endpoint.removal;
  if (!removal) {
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
    reason: removal.reason ?? null,
    cancellable: isCancellableRemoval(endpoint),
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
    if (endpoint.removal) {
      throw new ProblemError(409, "Deletion already scheduled", {
        type: ENDPOINT_PROBLEMS.removalScheduled,
        detail:
          "The backups of this machine are already scheduled for deletion. Cancel that first to choose differently.",
      });
    }
    if (input.confirmHostname.trim() !== endpoint.hostname) {
      throw confirmMismatch();
    }
    const reason = input.reason?.trim() ?? "";
    if (input.mode === "delete" && reason.length === 0) {
      throw new ProblemError(422, "Reason required", {
        type: ENDPOINT_PROBLEMS.removalReasonRequired,
        detail: "Say why the backups of this machine are to be deleted.",
        extensions: { field: "reason" },
      });
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
    // `delete` waits BACKUP_DELETION_DELAY_DAYS (0.5.0); see the file comment.
    let dueAt = new Date(now.getTime() + BACKUP_DELETION_DELAY_DAYS * DAY_MS);
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
      ...(input.mode === "delete" ? { reason } : {}),
      deletedObjects: 0,
    };
    const [updated] = await tx
      .update(endpoints)
      // `delete` keeps the machine listed (as revoked) until the worker starts.
      .set({ removedAt: input.mode === "expire" ? now : null, removal, removalDueAt: dueAt })
      .where(eq(endpoints.id, id))
      .returning();
    // Out of its backup job: the job's machines are listed from its members. A revoked machine
    // is never backed up again, so a cancelled deletion does not put it back.
    const left = await tx
      .delete(backupJobMembers)
      .where(and(eq(backupJobMembers.tenantId, tenantId), eq(backupJobMembers.endpointId, id)))
      .returning({ jobId: backupJobMembers.jobId });
    let queued = false;
    if (input.mode === "expire" && dueAt <= now) {
      queued = await queueRemoval(database, tx, tenantId, id);
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action:
        input.mode === "delete"
          ? ENDPOINT_AUDIT_ACTIONS.removalScheduled
          : ENDPOINT_AUDIT_ACTIONS.removed,
      endpointId: id,
      details: {
        hostname: endpoint.hostname,
        mode: input.mode,
        expiresAt: removal.expiresAt,
        dueAt: dueAt.toISOString(),
        ...(input.mode === "delete" ? { reason } : {}),
        repositoryBytes: endpoint.repositoryBytes,
        leftJobs: left.map((row) => row.jobId),
        queued,
      },
    });
    if (input.mode === "delete") {
      const name = endpoint.displayName ?? endpoint.hostname;
      await raiseReportEvents(
        tx,
        [
          {
            tenantId,
            level: "warning",
            event: "endpoint.backups_deletion_scheduled",
            message: `${actor.label} scheduled every backup of the revoked machine ${name} for deletion on ${dueAt.toISOString()}. Reason: ${reason}. It can be cancelled on the machine's page until then.`,
            details: {
              endpointId: id,
              objectName: name,
              dueAt: dueAt.toISOString(),
              requestedBy: actor.label,
              reason,
              repositoryBytes: endpoint.repositoryBytes,
            },
            createdAt: now,
          },
        ],
        now,
        { installationTimeZone: options.installationTimeZone },
      );
    }
    const dto = updated ? toRemovalDto(updated) : null;
    if (!dto) {
      throw new Error("endpoint update returned no row");
    }
    return dto;
  });
}

/**
 * Cancel a requested deletion of a machine's backups (`delete`, 0.5.0) before the worker starts:
 * the machine is as it was before the request (revoked, its backups kept), except that it stays
 * out of its backup job. Audited as `endpoint.removal.cancelled`. Refused (409) once the worker
 * started, and for `expire`, which keeps the backups until they expire anyway.
 */
export async function cancelRemoval(
  database: Database,
  tenantId: string,
  id: string,
  actor: EndpointActor,
): Promise<void> {
  await withTenantTx(database, tenantId, async (tx) => {
    // The worker claims the removal on the same row (FOR UPDATE) before it deletes anything:
    // whichever comes first wins, never both.
    const [endpoint] = await tx
      .select()
      .from(endpoints)
      .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.id, id)))
      .limit(1)
      .for("update");
    if (!endpoint || (endpoint.removedAt && endpoint.removal?.state === "done")) {
      throw new ProblemError(404, "Endpoint not found");
    }
    if (!endpoint.removal || !isCancellableRemoval(endpoint)) {
      throw new ProblemError(409, "Deletion not cancellable", {
        type: ENDPOINT_PROBLEMS.removalNotCancellable,
        detail: endpoint.removal
          ? "The deletion of this machine's backups has started, or is no deletion that can be cancelled."
          : "No deletion of this machine's backups is scheduled.",
      });
    }
    await tx
      .update(endpoints)
      .set({ removal: null, removalDueAt: null })
      .where(eq(endpoints.id, id));
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.removalCancelled,
      endpointId: id,
      details: {
        hostname: endpoint.hostname,
        requestedBy: endpoint.removal.requestedBy,
        requestedAt: endpoint.removal.requestedAt,
        dueAt: endpoint.removalDueAt?.toISOString() ?? null,
        reason: endpoint.removal.reason ?? null,
      },
    });
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
