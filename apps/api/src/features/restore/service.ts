import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  type Database,
  type Job,
  type ProtectedObject,
  type RestoreJob,
  itemFailures,
  jobProgress,
  jobs,
  manifestObjects,
  protectedObjects,
  restoreJobs,
  snapshots,
  sources,
  user,
  users,
} from "@restow/db";
import { type SQL, and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { audit } from "../../lib/audit.js";
import {
  assertDemoJobNotInFlight,
  assertDemoRestoreBudgetOk,
  assertDemoRestoreSizeOk,
  recordDemoRestoreUsage,
} from "../../lib/demo-limits.js";
import { sanitizeRestoreInputForDemo } from "../../lib/demo.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { DEMO_READ_ONLY_PROBLEM } from "../../middleware/demo-guard.js";
import { isTenantAdmin } from "../../middleware/rbac.js";
import { ProblemError } from "../../problem.js";
import { type FailureDto, failureDto } from "../failures/dto.js";
import { type JobThrottleDto, runtimeThrottleOf } from "../jobs/dto.js";
import { sendJob } from "../jobs/queue.js";
import {
  type Viewer,
  canAccessObject,
  isImpersonation,
  normalizeEmail,
  visibleObjectsCondition,
} from "../snapshots/access.js";
import { loadObjectForViewer, loadSnapshotForViewer } from "../snapshots/service.js";
import {
  type RestoreItemsDto,
  type RestoreResultDto,
  downloadAvailability,
  downloadPrefix,
  itemsFromPayload,
  resultFromPayload,
} from "./results.js";
import {
  type CreateRestoreInput,
  type ListRestoresQuery,
  type RestoreTargetKind,
  isReplaceModeAllowedFor,
  normalizeStoredRestoreMode,
  pickRestoreTargetKind,
  storedRestoreOptions,
} from "./schemas.js";
import {
  type SelectionSummary,
  parseStoredSelection,
  requestedKeys,
  resolveSelection,
  summarizeSelection,
} from "./selection.js";
import { listInStorage, locateInStorage, resolveTenantStorage } from "./storage.js";

/**
 * Restore requests (docs/ARCHITECTURE.md, Restore).
 *
 * A request becomes three things in one transaction: the `restore_jobs` row
 * (what, where to, how, by whom), the `jobs` lifecycle row the worker drives,
 * and the pg-boss queue entry. The audit entry joins the same transaction, so
 * a restore that was never enqueued is never logged as requested either.
 *
 * Self-service rules: end users restore only
 * their own objects and only back into them or as a download; restoring into
 * another account needs a tenant admin. Whenever the actor is not the owner
 * the restore is an impersonation: a reason is mandatory and recorded.
 */

/** Audit actions written by this feature. */
export const RESTORE_AUDIT_ACTIONS = {
  requested: "restore.requested",
  cancelled: "restore.cancelled",
  downloaded: "restore.downloaded",
} as const;

export interface RestoreActor extends Viewer {
  ip: string | null;
}

export type RestoreStatus = Job["status"] | "unknown";

export interface RestoreProgressDto {
  total: number;
  done: number;
  failed: number;
  bytes: number;
  etaSeconds: number | null;
}

export interface RestoreFailureDto {
  itemRef: string;
  reason: string;
  attempts: number;
}

export interface RestoreDto {
  id: string;
  jobId: string | null;
  snapshotId: string | null;
  snapshotSequence: number | null;
  snapshotAt: string | null;
  object: {
    id: string;
    kind: ProtectedObject["kind"];
    externalId: string;
    displayName: string | null;
  } | null;
  target: { type: RestoreJob["targetType"]; ref: string | null };
  mode: RestoreJob["mode"];
  selection: SelectionSummary;
  reason: string | null;
  impersonated: boolean;
  actor: { userId: string | null; name: string | null; email: string | null };
  status: RestoreStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  /** The classified cause of a failed restore (features/failures), for a translated explanation; null without one. */
  failure: FailureDto | null;
  progress: RestoreProgressDto | null;
  /** The current (or last) wait Microsoft Graph imposed; only while the restore runs. */
  throttle: JobThrottleDto | null;
  result: RestoreResultDto | null;
  download: { available: boolean; expiresAt: string | null };
}

export interface RestoreDetailDto extends RestoreDto {
  /** Items the worker could not process (live while the job runs). */
  failures: RestoreFailureDto[];
  /** Per-item outcomes, once the job has finished. */
  items: RestoreItemsDto | null;
}

export interface RestoreCreatedDto {
  id: string;
  jobId: string;
  status: "queued";
  impersonated: boolean;
  selection: SelectionSummary;
}

/** An account a restore of an object may be written into. */
export interface RestoreTargetDto {
  id: string;
  kind: ProtectedObject["kind"];
  externalId: string;
  displayName: string | null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** Which requested paths exist only as parents of other rows in the snapshot. */
export async function implicitFolders(
  tx: DbExecutor,
  tenantId: string,
  snapshotId: string,
  paths: readonly string[],
): Promise<Set<string>> {
  if (paths.length === 0) {
    return new Set();
  }
  // One bound parameter per path (drizzle expands an interpolated array into a list).
  const candidates = sql.join(
    paths.map((path) => sql`(${path}::text)`),
    sql`, `,
  );
  const result = await tx.execute<{ path: string }>(sql`
    SELECT candidate.path
    FROM (VALUES ${candidates}) AS candidate(path)
    WHERE EXISTS (
      SELECT 1 FROM manifest_objects m
      WHERE m.tenant_id = ${tenantId}::uuid
        AND m.snapshot_id = ${snapshotId}::uuid
        AND (m.parent_path = candidate.path OR left(m.parent_path, length(candidate.path) + 1) = candidate.path || '/')
    )
  `);
  return new Set(result.rows.map((row) => row.path));
}

/**
 * An IMAP restore into another account needs that account's server and
 * credentials, which only a known account of the tenant has. Mailbox and
 * drive targets are resolved by Graph within the object's own M365 tenant.
 */
async function assertImapTargetKnown(
  tx: DbExecutor,
  tenantId: string,
  accountId: string,
): Promise<void> {
  if (!(await imapTargetExists(tx, tenantId, accountId))) {
    throw new ProblemError(422, "Unknown target account", {
      type: "urn:restow:problem:restore-target-unknown",
      detail:
        "IMAP restores can only go into accounts of this tenant, because the server and credentials come from their source.",
      extensions: { accountId },
    });
  }
}

/**
 * An IMAP account of the tenant with this login. Imported mailboxes (source
 * kind `import`) are protected objects of kind `imap` too, but they hold no
 * server and no credentials: nothing can be restored into them.
 */
async function imapTargetExists(
  tx: DbExecutor,
  tenantId: string,
  accountId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: protectedObjects.id })
    .from(protectedObjects)
    .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.kind, "imap"),
        ne(sources.kind, "import"),
        eq(sql`lower(${protectedObjects.externalId})`, normalizeEmail(accountId)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Whether the object belongs to the tenant's import source (an imported mailbox, docs/IMPORT.md). */
async function isImportedObject(tx: DbExecutor, object: ProtectedObject): Promise<boolean> {
  const [source] = await tx
    .select({ kind: sources.kind })
    .from(sources)
    .where(eq(sources.id, object.sourceId))
    .limit(1);
  return source?.kind === "import";
}

/**
 * Which kind of account an imported mailbox is restored into: an M365 mailbox
 * (matched by its address or its directory user's e-mail) or an IMAP account of
 * the tenant. Anything else is refused: the restore needs the target's source
 * for its credentials.
 */
async function importedTargetKind(
  tx: DbExecutor,
  tenantId: string,
  accountId: string,
): Promise<RestoreTargetKind> {
  const address = normalizeEmail(accountId);
  const [mailbox] = await tx
    .select({ id: protectedObjects.id })
    .from(protectedObjects)
    .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
    .leftJoin(users, eq(users.id, protectedObjects.userId))
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.kind, "mailbox"),
        ne(protectedObjects.status, "orphaned"),
        ne(sources.kind, "import"),
        or(
          eq(sql`lower(${protectedObjects.externalId})`, address),
          eq(sql`lower(${users.email})`, address),
        ),
      ),
    )
    .limit(1);
  const kind = pickRestoreTargetKind({
    mailbox: mailbox !== undefined,
    imap: mailbox === undefined && (await imapTargetExists(tx, tenantId, accountId)),
  });
  if (!kind) {
    throw new ProblemError(422, "Unknown target account", {
      type: "urn:restow:problem:restore-target-unknown",
      detail:
        "An imported mailbox can only be restored into a Microsoft 365 mailbox or an IMAP account of this tenant, because the server and credentials come from their source.",
      extensions: { accountId },
    });
  }
  return kind;
}

export async function createRestore(
  db: Database,
  tenantId: string,
  actor: RestoreActor,
  rawInput: CreateRestoreInput,
): Promise<RestoreCreatedDto> {
  // Security review finding 6: a visitor's own text in `reason`,
  // `restoreFolderName` and `archiveName` would otherwise be visible to
  // every other visitor of the same shared demo mailbox and audit log.
  const input = config.demo.enabled ? sanitizeRestoreInputForDemo(rawInput) : rawInput;
  let demoBytes = 0;

  return withTenantTx(db, tenantId, async (tx) => {
    if (config.demo.enabled) {
      // Finding 3: one restore in flight per tenant, and download only — a
      // restore into the demo mailbox would grow what the next backup picks
      // up, which the next restore could grow further, without bound.
      await assertDemoJobNotInFlight(tx, tenantId, "restore");
      if (input.target.type !== "download") {
        throw new ProblemError(403, "Demo installation is read-only", {
          type: DEMO_READ_ONLY_PROBLEM,
          detail:
            "This demo only offers restore as a download. Restoring back into the mailbox is disabled.",
        });
      }
    }

    const { snapshot, object, ownerEmail } = await loadSnapshotForViewer(
      tx,
      tenantId,
      actor,
      input.snapshotId,
    );

    // A restore never replaces what is in the target account
    // (docs/ARCHITECTURE.md, Restore); replacing OneDrive files is planned for
    // a later release. The restore_mode database enum keeps the value for
    // history. Mode has no effect on a "download" target, so it is exempt
    // (isReplaceModeAllowedFor).
    if (!isReplaceModeAllowedFor(input.mode, input.target.type)) {
      throw new ProblemError(422, "Replace not allowed for this target", {
        type: "urn:restow:problem:restore-replace-not-allowed",
        detail:
          "A restore never replaces an existing item. Use 'rename' (keep both) or 'skip' instead.",
        extensions: { objectKind: object.kind },
      });
    }

    // An imported mailbox has no original account to restore back into (docs/IMPORT.md).
    const imported = await isImportedObject(tx, object);
    if (imported && input.target.type === "original") {
      throw new ProblemError(422, "Original not available", {
        type: "urn:restow:problem:restore-original-not-available",
        detail:
          "An imported mailbox has no original account. Restore into a Microsoft 365 mailbox or an IMAP account of this tenant, or download the data.",
        extensions: { objectKind: object.kind },
      });
    }

    if (input.target.type === "other" && !isTenantAdmin(actor.role)) {
      throw new ProblemError(403, "Insufficient role", {
        detail: "Restoring into another account requires the tenant_admin role.",
        extensions: { requiredRole: "tenant_admin", role: actor.role },
      });
    }
    if (input.target.type === "original" && object.status === "orphaned") {
      throw new ProblemError(409, "Original account gone", {
        type: "urn:restow:problem:restore-original-gone",
        detail:
          "The original account no longer exists in the source. Restore into another account or download the data.",
      });
    }
    // The worker routes an imported mailbox on the target's kind (options.targetKind).
    let importedTarget: RestoreTargetKind | null = null;
    if (input.target.type === "other" && imported) {
      importedTarget = await importedTargetKind(tx, tenantId, input.target.accountId);
    } else if (input.target.type === "other" && object.kind === "imap") {
      await assertImapTargetKnown(tx, tenantId, input.target.accountId);
    }

    const impersonated = isImpersonation(actor, { externalId: object.externalId, ownerEmail });
    if (impersonated && !input.reason) {
      throw new ProblemError(422, "Reason required", {
        type: "urn:restow:problem:restore-reason-required",
        detail:
          "Restoring another person's data requires a reason; it is written to the audit log.",
      });
    }

    const keys = requestedKeys(input.selection);
    const matches: SQL[] = [
      ...(keys.paths.length > 0 ? [inArray(manifestObjects.path, keys.paths)] : []),
      ...(keys.itemIds.length > 0 ? [inArray(manifestObjects.itemId, keys.itemIds)] : []),
    ];
    const rows =
      matches.length > 0
        ? await tx
            .select({
              path: manifestObjects.path,
              kind: manifestObjects.kind,
              itemId: manifestObjects.itemId,
            })
            .from(manifestObjects)
            .where(
              and(
                eq(manifestObjects.tenantId, tenantId),
                eq(manifestObjects.snapshotId, snapshot.id),
                or(...matches),
              ),
            )
        : [];
    const kindByPath = new Map(rows.map((row) => [row.path, row.kind] as const));
    const knownItemIds = new Set(
      rows.map((row) => row.itemId).filter((id): id is string => id !== null),
    );
    const missingPaths = keys.paths.filter((path) => !kindByPath.has(path));
    const resolved = resolveSelection(input.selection, {
      kindByPath,
      knownItemIds,
      implicitFolders: await implicitFolders(tx, tenantId, snapshot.id, missingPaths),
    });
    if (!resolved.ok) {
      throw new ProblemError(422, "Selection not in snapshot", {
        type: "urn:restow:problem:restore-selection-unknown",
        detail:
          "Some selected entries do not exist in this snapshot. Reload the explorer and select again.",
        extensions: { unknown: resolved.unknown },
      });
    }

    if (config.demo.enabled) {
      // An approximation (the whole snapshot's manifest, not just the
      // selection): cheap, and the demo's own corpus is small and fixed, so
      // it is a real backstop without needing to reimplement the selection's
      // exact path/folder resolution just to size it.
      const [total] = await tx
        .select({ bytes: sql<string>`coalesce(sum(${manifestObjects.size}), 0)::text` })
        .from(manifestObjects)
        .where(
          and(eq(manifestObjects.tenantId, tenantId), eq(manifestObjects.snapshotId, snapshot.id)),
        );
      demoBytes = Number(total?.bytes ?? "0");
      assertDemoRestoreSizeOk(demoBytes);
      assertDemoRestoreBudgetOk(demoBytes, resolved.summary.items);
    }

    const restoreJobId = randomUUID();
    const jobId = randomUUID();
    const targetRef = input.target.type === "other" ? input.target.accountId : null;
    // "replace" is meaningless for a download (mode has no effect on a ZIP
    // archive, isReplaceModeAllowedFor) — stored and audited as "rename" so
    // a mailbox or IMAP object's history never reads as a replaced original.
    const storedMode = normalizeStoredRestoreMode(input.mode, input.target.type);
    const payload = { jobId, tenantId, restoreJobId, protectedObjectId: object.id };
    // The engines read presentation options next to the selection
    // (packages/core restore/common.ts, restoreRequestOptions).
    const storedOptions = storedRestoreOptions(input.options, importedTarget);
    const sourceSelection: Record<string, unknown> = {
      ...resolved.selection,
      ...(storedOptions ? { options: storedOptions } : {}),
    };

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
      snapshotId: snapshot.id,
      sourceSelection,
      targetType: input.target.type,
      targetRef,
      mode: storedMode,
      actorUserId: actor.userId,
      impersonated,
      reason: input.reason ?? null,
    });
    const pgBossJobId = await sendJob(tx, "restore", payload);
    if (!pgBossJobId) {
      // Restores carry no singleton key, so the only way to get no id is a
      // queue that does not exist yet: no worker ever started on this database.
      throw new ProblemError(503, "Job queue unavailable", {
        type: "urn:restow:problem:queue-unavailable",
        detail:
          "The restore queue does not exist yet. Start the worker so it creates the queues, then try again.",
      });
    }
    await tx.update(jobs).set({ pgBossJobId }).where(eq(jobs.id, jobId));

    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: RESTORE_AUDIT_ACTIONS.requested,
      target: restoreJobId,
      targetType: "restore_job",
      onBehalfOf: impersonated ? (ownerEmail ?? object.externalId) : null,
      ip: actor.ip,
      details: {
        jobId,
        snapshotId: snapshot.id,
        snapshotSequence: snapshot.sequence,
        protectedObjectId: object.id,
        objectKind: object.kind,
        externalId: object.externalId,
        target: input.target.type,
        targetRef,
        mode: storedMode,
        reason: input.reason ?? null,
        selection: resolved.summary,
      },
    });

    if (config.demo.enabled) {
      recordDemoRestoreUsage(demoBytes, resolved.summary.items);
    }

    return {
      id: restoreJobId,
      jobId,
      status: "queued",
      impersonated,
      selection: resolved.summary,
    };
  });
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * Accounts a restore of `objectId` may be written into, for the dialog's
 * suggestions: other protected objects of the same kind. Mailboxes and
 * drives are limited to the same source, because Graph writes within the
 * object's own M365 tenant. An imported mailbox has no source of its own to
 * write within: it lists the active M365 mailboxes and IMAP accounts of the
 * tenant's other sources, and no object of an import source is ever offered.
 */
export async function listTargets(
  db: Database,
  tenantId: string,
  viewer: Viewer,
  objectId: string,
): Promise<RestoreTargetDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const { object } = await loadObjectForViewer(tx, tenantId, viewer, objectId);
    const imported = await isImportedObject(tx, object);
    return tx
      .select({
        id: protectedObjects.id,
        kind: protectedObjects.kind,
        externalId: protectedObjects.externalId,
        displayName: protectedObjects.displayName,
      })
      .from(protectedObjects)
      .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
      .where(
        and(
          eq(protectedObjects.tenantId, tenantId),
          imported
            ? inArray(protectedObjects.kind, ["mailbox", "imap"])
            : eq(protectedObjects.kind, object.kind),
          eq(protectedObjects.status, "active"),
          ne(protectedObjects.id, object.id),
          ne(sources.kind, "import"),
          ...(imported || object.kind === "imap"
            ? []
            : [eq(protectedObjects.sourceId, object.sourceId)]),
        ),
      )
      .orderBy(
        asc(sql`lower(coalesce(${protectedObjects.displayName}, ${protectedObjects.externalId}))`),
      )
      .limit(1000);
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const restoreColumns = {
  restore: restoreJobs,
  job: jobs,
  progress: jobProgress,
  snapshot: snapshots,
  object: protectedObjects,
  ownerEmail: users.email,
  actorName: user.name,
  actorEmail: user.email,
};

type RestoreRow = {
  restore: RestoreJob;
  job: Job | null;
  progress: typeof jobProgress.$inferSelect | null;
  snapshot: typeof snapshots.$inferSelect | null;
  object: ProtectedObject | null;
  ownerEmail: string | null;
  actorName: string | null;
  actorEmail: string | null;
};

function restoreQuery(tx: DbExecutor) {
  return tx
    .select(restoreColumns)
    .from(restoreJobs)
    .leftJoin(jobs, eq(jobs.id, restoreJobs.jobId))
    .leftJoin(jobProgress, eq(jobProgress.jobId, jobs.id))
    .leftJoin(snapshots, eq(snapshots.id, restoreJobs.snapshotId))
    .leftJoin(protectedObjects, eq(protectedObjects.id, jobs.protectedObjectId))
    .leftJoin(users, eq(users.id, protectedObjects.userId))
    .leftJoin(user, eq(user.id, restoreJobs.actorUserId));
}

/**
 * SQL filter for the restores a viewer may see: admins all of the tenant,
 * end users the ones they requested and the ones of their own objects.
 */
function visibleRestoresCondition(viewer: Viewer): SQL | null {
  const ownObjects = visibleObjectsCondition(viewer);
  if (!ownObjects) {
    return null;
  }
  if (viewer.userId === null) {
    return ownObjects;
  }
  return or(eq(restoreJobs.actorUserId, viewer.userId), ownObjects) as SQL;
}

function isVisibleTo(viewer: Viewer, row: RestoreRow): boolean {
  const ownRequest = viewer.userId !== null && row.restore.actorUserId === viewer.userId;
  if (isTenantAdmin(viewer.role) || ownRequest) {
    return true;
  }
  return row.object
    ? canAccessObject(viewer, { externalId: row.object.externalId, ownerEmail: row.ownerEmail })
    : false;
}

function toRestoreDto(row: RestoreRow, now: Date): RestoreDto {
  const status: RestoreStatus = row.job?.status ?? "unknown";
  const completedAt = row.job?.completedAt ?? null;
  return {
    id: row.restore.id,
    jobId: row.restore.jobId,
    snapshotId: row.restore.snapshotId,
    snapshotSequence: row.snapshot?.sequence ?? null,
    snapshotAt: iso(row.snapshot?.completedAt),
    object: row.object
      ? {
          id: row.object.id,
          kind: row.object.kind,
          externalId: row.object.externalId,
          displayName: row.object.displayName,
        }
      : null,
    target: { type: row.restore.targetType, ref: row.restore.targetRef },
    mode: row.restore.mode,
    selection: summarizeSelection(parseStoredSelection(row.restore.sourceSelection)),
    reason: row.restore.reason,
    impersonated: row.restore.impersonated,
    actor: {
      userId: row.restore.actorUserId,
      name: row.actorName,
      email: row.actorEmail,
    },
    status,
    createdAt: row.restore.createdAt.toISOString(),
    startedAt: iso(row.job?.startedAt),
    completedAt: iso(completedAt),
    errorMessage: row.job?.errorMessage ?? null,
    failure: failureDto(row.job?.failure ?? null),
    progress: row.progress
      ? {
          total: row.progress.total,
          done: row.progress.done,
          failed: row.progress.failed,
          bytes: row.progress.bytes,
          etaSeconds: row.progress.etaSeconds,
        }
      : null,
    // Only a running restore has a wait; a stale one must not linger.
    throttle: status === "active" ? runtimeThrottleOf(row.job?.payload ?? null) : null,
    result: resultFromPayload(row.job?.payload ?? null),
    download: downloadAvailability(row.restore.targetType, status, completedAt, now),
  };
}

async function loadRestoreRow(
  tx: DbExecutor,
  tenantId: string,
  viewer: Viewer,
  id: string,
): Promise<RestoreRow> {
  const [row] = await restoreQuery(tx)
    .where(and(eq(restoreJobs.tenantId, tenantId), eq(restoreJobs.id, id)))
    .limit(1);
  if (!row || !isVisibleTo(viewer, row)) {
    throw new ProblemError(404, "Restore not found");
  }
  return row;
}

export async function listRestores(
  db: Database,
  tenantId: string,
  viewer: Viewer,
  query: ListRestoresQuery,
  now: () => Date = () => new Date(),
): Promise<RestoreDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const visible = visibleRestoresCondition(viewer);
    const rows = await restoreQuery(tx)
      .where(
        and(
          eq(restoreJobs.tenantId, tenantId),
          ...(query.objectId ? [eq(jobs.protectedObjectId, query.objectId)] : []),
          ...(visible ? [visible] : []),
        ),
      )
      .orderBy(desc(restoreJobs.createdAt), desc(restoreJobs.id))
      .limit(query.limit)
      .offset(query.offset ?? 0);
    const at = now();
    return rows.map((row) => toRestoreDto(row, at));
  });
}

export async function getRestore(
  db: Database,
  tenantId: string,
  viewer: Viewer,
  id: string,
  now: () => Date = () => new Date(),
): Promise<RestoreDetailDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const row = await loadRestoreRow(tx, tenantId, viewer, id);
    const failures = row.job
      ? await tx
          .select({
            itemRef: itemFailures.itemRef,
            reason: itemFailures.reason,
            attempts: itemFailures.attempts,
          })
          .from(itemFailures)
          .where(and(eq(itemFailures.tenantId, tenantId), eq(itemFailures.jobId, row.job.id)))
          .orderBy(desc(itemFailures.createdAt))
          .limit(500)
      : [];
    return {
      ...toRestoreDto(row, now()),
      failures,
      items: itemsFromPayload(row.job?.payload ?? null),
    };
  });
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export async function cancelRestore(
  db: Database,
  tenantId: string,
  actor: RestoreActor,
  id: string,
): Promise<RestoreDetailDto> {
  await withTenantTx(db, tenantId, async (tx) => {
    const row = await loadRestoreRow(tx, tenantId, actor, id);
    if (!row.job || (row.job.status !== "queued" && row.job.status !== "active")) {
      throw new ProblemError(409, "Restore not cancellable", {
        detail: "Only queued or running restores can be cancelled.",
        extensions: { status: row.job?.status ?? "unknown" },
      });
    }
    // The worker checks the row: a queued job never starts, a running one
    // aborts at its next checkpoint (apps/worker framework).
    await tx.update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, row.job.id));
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: RESTORE_AUDIT_ACTIONS.cancelled,
      target: id,
      targetType: "restore_job",
      ip: actor.ip,
      details: { jobId: row.job.id, previousStatus: row.job.status },
    });
  });
  return getRestore(db, tenantId, actor, id);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export interface DownloadStream {
  stream: Readable;
  size: number;
  fileName: string;
}

function fileNameOf(key: string): string {
  const name = key.slice(key.lastIndexOf("/") + 1);
  return name.length > 0 ? name : "restore.zip";
}

export async function openDownload(
  db: Database,
  tenantId: string,
  actor: RestoreActor,
  id: string,
  now: () => Date = () => new Date(),
): Promise<DownloadStream> {
  const detail = await getRestore(db, tenantId, actor, id, now);
  if (detail.target.type !== "download") {
    throw new ProblemError(409, "Not a download restore", {
      detail: "This restore was written to a mailbox or drive; there is nothing to download.",
    });
  }
  if (detail.status !== "completed") {
    throw new ProblemError(409, "Download not ready", {
      detail: "The restore has not completed yet.",
      extensions: { status: detail.status },
    });
  }
  if (!detail.download.available) {
    throw new ProblemError(410, "Download expired", {
      detail:
        "Download links are valid for 24 hours after the restore completed. Request the restore again.",
      extensions: { expiresAt: detail.download.expiresAt },
    });
  }

  const storage = await resolveTenantStorage(db, tenantId);
  const key =
    detail.result?.downloadKey ??
    (await listInStorage(storage, downloadPrefix(tenantId, id)))[0] ??
    null;
  const located = key ? await locateInStorage(storage, key) : null;
  if (!key || !located) {
    throw new ProblemError(404, "Download not found", {
      detail: "The archive is no longer present in storage.",
    });
  }

  await audit(db, {
    tenantId,
    actor: actor.email,
    actorUserId: actor.userId,
    action: RESTORE_AUDIT_ACTIONS.downloaded,
    target: id,
    targetType: "restore_job",
    onBehalfOf: detail.impersonated ? detail.object?.externalId : null,
    ip: actor.ip,
    details: { key, size: located.size },
  });

  return {
    stream: await located.backend.getStream(key),
    size: located.size,
    fileName: fileNameOf(key),
  };
}
