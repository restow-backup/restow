/**
 * Restoring archived mail into its mailbox (docs/ARCHIVE.md "Aus dem Archiv im
 * Restore-Explorer", #48): the explorer's source "From the archive" lists the
 * mail that reached the archive after the newest backup
 * (features/archive/gap.ts); this puts chosen messages back into the mailbox
 * or IMAP account they belong to, through the same restore job, worker and
 * engines as a restore from a snapshot (apps/worker handlers/restore.ts reads
 * `source_selection.archiveItemIds` and hands the messages to the engines as
 * their source).
 *
 * The archive's rules hold: only tenant administrators may read the archive,
 * so only they may restore from it (the route's guard and the check below);
 * restoring another person's mail is an impersonation that needs a reason and
 * is audited on their behalf, as every restore; the archive itself is never
 * changed (a restore copies, retention and legal holds of the items stay as
 * they are). Every message lands in a restore folder of its own ("rename"):
 * archived mail knows no folder of the mailbox, and a restore never replaces
 * what is there. Only the original account is a target: the messages are that
 * mailbox's mail.
 */
import { randomUUID } from "node:crypto";
import {
  archiveItemOfMailbox,
  archiveItems,
  type Database,
  jobs,
  restoreJobs,
  sources,
} from "@restow/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { config } from "../../config.js";
import { audit } from "../../lib/audit.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { DEMO_READ_ONLY_PROBLEM } from "../../middleware/demo-guard.js";
import { isTenantAdmin } from "../../middleware/rbac.js";
import { ProblemError } from "../../problem.js";
import { loadArchiveMailbox } from "../archive/gap.js";
import { sendJob } from "../jobs/queue.js";
import { isImpersonation } from "../snapshots/access.js";
import { restoreOptionsSchema, storedRestoreOptions } from "./schemas.js";
import { RESTORE_AUDIT_ACTIONS, type RestoreActor, type RestoreCreatedDto } from "./service.js";

/** Archived mail goes back into the account it belongs to, never elsewhere. */
const ORIGINAL_TARGET = "original" as const;

/** The most archived messages one restore takes (the explorer selects within one page). */
export const MAX_ARCHIVE_RESTORE_ITEMS = 500;

export const createArchiveRestoreSchema = z.object({
  /** The mailbox or IMAP account the messages belong to, and the account they go back into. */
  objectId: z.string().uuid(),
  itemIds: z.array(z.string().uuid()).min(1).max(MAX_ARCHIVE_RESTORE_ITEMS),
  /** Required when the mailbox is not the administrator's own (impersonation). */
  reason: z.string().trim().min(3).max(2000).optional(),
  options: restoreOptionsSchema.pick({ restoreFolderName: true }).optional(),
});
export type CreateArchiveRestoreInput = z.infer<typeof createArchiveRestoreSchema>;

/** POST /restore/archive */
export async function createArchiveRestore(
  db: Database,
  tenantId: string,
  actor: RestoreActor,
  input: CreateArchiveRestoreInput,
): Promise<RestoreCreatedDto> {
  if (!isTenantAdmin(actor.role)) {
    throw new ProblemError(403, "Insufficient role", {
      detail: "The archive is open to tenant administrators only; so is a restore from it.",
      extensions: { requiredRole: "tenant_admin", role: actor.role },
    });
  }
  if (config.demo.enabled) {
    // The demo only restores as a download (features/restore/service.ts); archived mail is
    // downloaded from the archive itself.
    throw new ProblemError(403, "Demo installation is read-only", {
      type: DEMO_READ_ONLY_PROBLEM,
      detail: "This demo does not restore into a mailbox. Download the message instead.",
    });
  }
  return withTenantTx(db, tenantId, async (tx) => {
    const object = await loadArchiveMailbox(tx, tenantId, input.objectId);
    const [source] = await tx
      .select({ kind: sources.kind })
      .from(sources)
      .where(eq(sources.id, object.sourceId))
      .limit(1);
    if (source?.kind === "import") {
      throw new ProblemError(422, "Original not available", {
        type: "urn:restow:problem:restore-original-not-available",
        detail: "An imported mailbox has no account to restore archived mail into.",
        extensions: { objectKind: object.kind },
      });
    }
    if (object.status === "orphaned") {
      throw new ProblemError(409, "Original account gone", {
        type: "urn:restow:problem:restore-original-gone",
        detail:
          "The account is not available at its source (gone, disabled, unlicensed or shut down). Download the messages from the archive instead.",
        ...(object.statusReason ? { extensions: { statusReason: object.statusReason } } : {}),
      });
    }

    const owned = { externalId: object.externalId, ownerEmail: object.ownerEmail };
    const impersonated = isImpersonation(actor, { ...owned, kind: object.kind });
    if (impersonated && !input.reason) {
      throw new ProblemError(422, "Reason required", {
        type: "urn:restow:problem:restore-reason-required",
        detail:
          "Restoring another person's mail requires a reason; it is written to the audit log.",
      });
    }

    const requested = [...new Set(input.itemIds)].sort();
    const rows = await tx
      .select({
        id: archiveItems.id,
        sizeBytes: archiveItems.sizeBytes,
        chunks: archiveItems.chunks,
      })
      .from(archiveItems)
      .where(
        and(
          eq(archiveItems.tenantId, tenantId),
          inArray(archiveItems.id, requested),
          archiveItemOfMailbox(object.id),
        ),
      );
    const found = new Map(rows.map((row) => [row.id, row]));
    const unknown = requested.filter((id) => !found.has(id));
    if (unknown.length > 0) {
      throw new ProblemError(422, "Messages not in this mailbox's archive", {
        type: "urn:restow:problem:restore-selection-unknown",
        detail:
          "Some selected messages are not archived for this mailbox. Reload the list and select again.",
        extensions: { unknown: unknown.map((id) => `archiveItem:${id}`) },
      });
    }
    const notRecorded = rows
      .filter((row) => row.sizeBytes === null || row.chunks === null)
      .map((row) => row.id);
    if (notRecorded.length > 0) {
      throw new ProblemError(422, "Archived content not readable", {
        type: "urn:restow:problem:archive-content-unavailable",
        detail:
          "Some selected messages were archived before their content reference was recorded; they can only be exported.",
        extensions: { problem: "not_recorded", itemIds: notRecorded },
      });
    }

    const restoreJobId = randomUUID();
    const jobId = randomUUID();
    const payload = { jobId, tenantId, restoreJobId, protectedObjectId: object.id };
    const storedOptions = storedRestoreOptions(input.options, null);
    await tx.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "restore",
      status: "queued",
      protectedObjectId: object.id,
      payload,
    });
    await tx.insert(restoreJobs).values({
      id: restoreJobId,
      tenantId,
      jobId,
      snapshotId: null,
      sourceSelection: {
        archiveItemIds: requested,
        ...(storedOptions ? { options: storedOptions } : {}),
      },
      // The restore target, not an audit target type: always the account the mail belongs to.
      targetType: ORIGINAL_TARGET,
      targetRef: null,
      mode: "rename",
      actorUserId: actor.userId,
      impersonated,
      reason: input.reason ?? null,
    });
    const pgBossJobId = await sendJob(tx, "restore", payload);
    if (!pgBossJobId) {
      throw new ProblemError(503, "Job queue unavailable", {
        type: "urn:restow:problem:queue-unavailable",
        detail:
          "The restore queue does not exist yet. Start the worker so it creates the queues, then try again.",
      });
    }
    await tx.update(jobs).set({ pgBossJobId }).where(eq(jobs.id, jobId));

    const summary = { all: false, folders: 0, items: requested.length };
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: RESTORE_AUDIT_ACTIONS.requested,
      target: restoreJobId,
      targetType: "restore_job",
      onBehalfOf: impersonated ? (object.ownerEmail ?? object.externalId) : null,
      ip: actor.ip,
      details: {
        jobId,
        source: "archive",
        snapshotId: null,
        protectedObjectId: object.id,
        objectKind: object.kind,
        externalId: object.externalId,
        target: "original",
        targetRef: null,
        mode: "rename",
        reason: input.reason ?? null,
        selection: summary,
        archiveItemIds: requested,
      },
    });

    return { id: restoreJobId, jobId, status: "queued", impersonated, selection: summary };
  });
}
