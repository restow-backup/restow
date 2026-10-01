import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { mailfiles } from "@restow/core";
import {
  type Database,
  type ExportFormat,
  archiveItems,
  itemFailures,
  jobProgress,
  jobs,
  mailExports,
  manifestObjects,
  protectedObjects,
  user,
  users,
} from "@restow/db";
import { type SQL, and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { audit } from "../../lib/audit.js";
import { segmentStoreFor } from "../../lib/segment-store.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { isTenantAdmin } from "../../middleware/rbac.js";
import { ProblemError } from "../../problem.js";
import { archiveSearchConditions } from "../archive/service.js";
import { sendJob } from "../jobs/queue.js";
import type { SelectionEntry } from "../restore/schemas.js";
import { type ResolvedSelection, requestedKeys, resolveSelection } from "../restore/selection.js";
import { implicitFolders } from "../restore/service.js";
import { type Viewer, isImpersonation, onBehalfOfOwner } from "../snapshots/access.js";
import { loadSnapshotForViewer } from "../snapshots/service.js";
import {
  type ExportCreatedDto,
  type ExportDetailDto,
  type ExportDto,
  type ExportFormatDto,
  type ExportRow,
  exportAvailability,
  fallbackContentType,
  hasEverySegment,
  reportFromJson,
  toExportDto,
  toFormatDtos,
} from "./dto.js";
import type {
  ArchiveExportInput,
  CreateExportInput,
  ListExportsQuery,
  SnapshotExportInput,
} from "./schemas.js";
import { toStoredArchiveFilter } from "./schemas.js";

/**
 * Mail exports (docs/IMPORT.md).
 *
 * A request becomes three things in one transaction: the `mail_exports` row
 * (what, in which format, by whom), the `jobs` lifecycle row the worker
 * drives, and the pg-boss queue entry; the audit entry joins the same
 * transaction, so an export that was never enqueued is never logged as
 * requested either. The worker writes the finished file as sealed segments
 * under `tenants/<tid>/exports/<id>/` and sets `expires_at`; the API streams
 * it back decrypted and never keeps a copy.
 *
 * Access follows the restore rules: end users export only their own mailboxes
 * and see only their own requests, an admin exporting another person's data
 * (an impersonation) must give a reason that is recorded, and exports from the
 * archive are for tenant admins.
 */

/** Audit actions written by this feature. */
export const EXPORT_AUDIT_ACTIONS = {
  requested: "export.requested",
  cancelled: "export.cancelled",
  downloaded: "export.downloaded",
} as const;

/** The most matches counted for an archive filter; the count is a capped estimate beyond it. */
export const ARCHIVE_MATCH_COUNT_CAP = 100_000;

/**
 * Bytes the tenant's export files take in storage: every finished export that was not purged
 * yet, also one whose download time ran out but that the cleanup has not deleted.
 */
export async function exportBytesInUse(tx: DbExecutor, tenantId: string): Promise<number> {
  const result = await tx.execute<{ bytes: string }>(sql`
    SELECT coalesce(sum(file_size), 0)::text AS bytes
    FROM ${mailExports}
    WHERE tenant_id = ${tenantId} AND purged_at IS NULL AND file_size IS NOT NULL
  `);
  return Number(result.rows[0]?.bytes ?? 0);
}

/**
 * Refuse a new export while the tenant has no room left for exports. Queued exports hold no
 * storage; the worker enforces the limit on what a running one writes (apps/worker export handler),
 * and at most a few run at the same time per tenant.
 */
async function assertExportBudget(tx: DbExecutor, tenantId: string): Promise<void> {
  const used = await exportBytesInUse(tx, tenantId);
  const limit = config.exports.maxTenantBytes;
  if (used >= limit) {
    throw new ProblemError(422, "Export storage full", {
      type: "urn:restow:problem:export-quota-exceeded",
      detail: `The finished exports of this organization take ${used} of the ${limit} bytes that may be used for exports. Exports are deleted ${config.exports.ttlHours} hours after they finished; request this export again after that.`,
      extensions: { usedBytes: used, limitBytes: limit, ttlHours: config.exports.ttlHours },
    });
  }
}

/** The most unknown ids or paths a problem response lists. */
const MAX_LISTED_UNKNOWN = 20;

export interface ExportActor extends Viewer {
  ip: string | null;
}

export interface ExportServiceOptions {
  /** The formats on offer (default: core's `EXPORT_FORMATS`). */
  formats?: readonly mailfiles.ExportFormatInfo[];
  /** Most matches of an archive filter that are counted (default {@link ARCHIVE_MATCH_COUNT_CAP}). */
  archiveMatchCap?: number;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

export function listFormats(
  formats: readonly mailfiles.ExportFormatInfo[] = mailfiles.EXPORT_FORMATS,
): ExportFormatDto[] {
  return toFormatDtos(formats);
}

/** The database enum has no `pst`; a format that cannot be stored cannot be requested. */
function isStorableFormat(format: string): format is ExportFormat {
  return format === "eml_zip" || format === "mbox" || format === "msg_zip";
}

function assertFormatAvailable(
  format: CreateExportInput["format"],
  formats: readonly mailfiles.ExportFormatInfo[],
): ExportFormat {
  const info = formats.find((candidate) => candidate.id === format);
  if (info?.available && isStorableFormat(format)) {
    return format;
  }
  const planned = info?.planned === true || !info;
  throw new ProblemError(422, "Export format unavailable", {
    type: "urn:restow:problem:export-format-unavailable",
    detail: planned
      ? `The ${format} format is planned for a later release. Choose another format.`
      : `The ${format} format is not available in this installation. Choose another format.`,
    extensions: { format, planned, reason: info?.reason ?? null },
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** What resolving a request's selection produced, before anything is written. */
interface ResolvedExportSource {
  protectedObjectId: string | null;
  snapshotId: string | null;
  /** Stored in `mail_exports.selection` (the worker reads it). */
  selection: Record<string, unknown>;
  impersonated: boolean;
  onBehalfOf: string | null;
  /** The parts of the audit entry that differ by origin. */
  auditDetails: Record<string, unknown>;
}

async function resolveSnapshotSelection(
  tx: DbExecutor,
  tenantId: string,
  snapshotId: string,
  entries: readonly SelectionEntry[],
): Promise<ResolvedSelection> {
  const keys = requestedKeys(entries);
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
              eq(manifestObjects.snapshotId, snapshotId),
              or(...matches),
            ),
          )
      : [];
  const kindByPath = new Map(rows.map((row) => [row.path, row.kind] as const));
  const knownItemIds = new Set(
    rows.map((row) => row.itemId).filter((id): id is string => id !== null),
  );
  const missingPaths = keys.paths.filter((path) => !kindByPath.has(path));
  return resolveSelection(entries, {
    kindByPath,
    knownItemIds,
    implicitFolders: await implicitFolders(tx, tenantId, snapshotId, missingPaths),
  });
}

async function resolveSnapshotSource(
  tx: DbExecutor,
  tenantId: string,
  actor: ExportActor,
  input: SnapshotExportInput,
): Promise<ResolvedExportSource> {
  const { snapshot, object, ownerEmail } = await loadSnapshotForViewer(
    tx,
    tenantId,
    actor,
    input.snapshotId,
  );

  // Snapshot exports are mail only (EML/MBOX/MSG); a OneDrive is restored as a download.
  if (object.kind === "onedrive") {
    throw new ProblemError(422, "Not a mail object", {
      type: "urn:restow:problem:export-not-mail",
      detail:
        "Only mailboxes and IMAP accounts can be exported as mail files. Restore a OneDrive as a download instead.",
      extensions: { objectKind: object.kind },
    });
  }

  const owned = { externalId: object.externalId, ownerEmail };
  const impersonated = isImpersonation(actor, owned);
  if (impersonated && !input.reason) {
    throw new ProblemError(422, "Reason required", {
      type: "urn:restow:problem:export-reason-required",
      detail: "Exporting another person's data requires a reason; it is written to the audit log.",
    });
  }

  const resolved = await resolveSnapshotSelection(tx, tenantId, snapshot.id, input.selection);
  if (!resolved.ok) {
    throw new ProblemError(422, "Selection not in snapshot", {
      type: "urn:restow:problem:export-selection-unknown",
      detail:
        "Some selected entries do not exist in this snapshot. Reload the explorer and select again.",
      extensions: { unknown: resolved.unknown.slice(0, MAX_LISTED_UNKNOWN) },
    });
  }

  return {
    protectedObjectId: object.id,
    snapshotId: snapshot.id,
    selection: { ...resolved.selection },
    impersonated,
    onBehalfOf: impersonated ? onBehalfOfOwner(actor, owned) : null,
    auditDetails: {
      snapshotId: snapshot.id,
      snapshotSequence: snapshot.sequence,
      protectedObjectId: object.id,
      objectKind: object.kind,
      externalId: object.externalId,
      selection: resolved.summary,
    },
  };
}

/** How many archive items match the filter, up to `cap` plus one (which shows the cap was hit). */
async function countArchiveMatches(
  tx: DbExecutor,
  where: SQL | undefined,
  cap: number,
): Promise<number> {
  const result = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count
    FROM (
      SELECT 1 FROM ${archiveItems} WHERE ${where} LIMIT ${cap + 1}
    ) AS matched
  `);
  return result.rows[0]?.count ?? 0;
}

async function resolveArchiveSource(
  tx: DbExecutor,
  tenantId: string,
  input: ArchiveExportInput,
  cap: number,
): Promise<ResolvedExportSource> {
  const selection = input.selection;

  if ("itemIds" in selection) {
    const ids = [...new Set(selection.itemIds)].sort();
    const found = await tx
      .select({ id: archiveItems.id })
      .from(archiveItems)
      .where(and(eq(archiveItems.tenantId, tenantId), inArray(archiveItems.id, ids)));
    const known = new Set(found.map((row) => row.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ProblemError(422, "Selection not in archive", {
        type: "urn:restow:problem:export-selection-unknown",
        detail:
          "Some selected archive items do not exist in this archive. Search again and select.",
        extensions: {
          unknown: unknown.slice(0, MAX_LISTED_UNKNOWN).map((id) => `itemId:${id}`),
          unknownCount: unknown.length,
        },
      });
    }
    return {
      protectedObjectId: null,
      snapshotId: null,
      selection: { itemIds: ids },
      impersonated: false,
      onBehalfOf: null,
      auditDetails: { selection: { kind: "itemIds", items: ids.length } },
    };
  }

  const filter = toStoredArchiveFilter(selection.filter);
  const counted = await countArchiveMatches(
    tx,
    and(...archiveSearchConditions(tenantId, selection.filter)),
    cap,
  );
  if (counted === 0) {
    throw new ProblemError(422, "Nothing to export", {
      type: "urn:restow:problem:export-selection-empty",
      detail: "No archived message matches this search, so there is nothing to export.",
    });
  }
  const capped = counted > cap;
  const matched = Math.min(counted, cap);
  return {
    protectedObjectId: null,
    snapshotId: null,
    selection: { filter, matched, ...(capped ? { capped: true } : {}) },
    impersonated: false,
    onBehalfOf: null,
    auditDetails: {
      selection: { kind: "filter", items: matched, capped, filter },
    },
  };
}

export async function createExport(
  db: Database,
  tenantId: string,
  actor: ExportActor,
  input: CreateExportInput,
  options: ExportServiceOptions = {},
): Promise<ExportCreatedDto> {
  const format = assertFormatAvailable(input.format, options.formats ?? mailfiles.EXPORT_FORMATS);
  if (input.origin === "archive" && !isTenantAdmin(actor.role)) {
    throw new ProblemError(403, "Insufficient role", {
      detail: "Exporting from the archive requires the tenant_admin role.",
      extensions: { requiredRole: "tenant_admin", role: actor.role },
    });
  }

  return withTenantTx(db, tenantId, async (tx) => {
    await assertExportBudget(tx, tenantId);
    const source =
      input.origin === "snapshot"
        ? await resolveSnapshotSource(tx, tenantId, actor, input)
        : await resolveArchiveSource(
            tx,
            tenantId,
            input,
            options.archiveMatchCap ?? ARCHIVE_MATCH_COUNT_CAP,
          );

    const exportId = randomUUID();
    const jobId = randomUUID();
    const payload = {
      jobId,
      tenantId,
      exportId,
      ...(source.protectedObjectId ? { protectedObjectId: source.protectedObjectId } : {}),
    };
    // The file name is a request from the person; the worker reduces it to a storage-safe name.
    const storedSelection: Record<string, unknown> = {
      ...source.selection,
      ...(input.fileName ? { options: { fileName: input.fileName } } : {}),
    };

    await tx.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "export",
      status: "queued",
      protectedObjectId: source.protectedObjectId,
      payload,
    });
    await tx.insert(mailExports).values({
      id: exportId,
      tenantId,
      jobId,
      origin: input.origin,
      format,
      snapshotId: source.snapshotId,
      protectedObjectId: source.protectedObjectId,
      selection: storedSelection,
      actorUserId: actor.userId,
      impersonated: source.impersonated,
      reason: input.reason ?? null,
    });
    const pgBossJobId = await sendJob(tx, "export", payload);
    if (!pgBossJobId) {
      // Exports carry no singleton key, so the only way to get no id is a
      // queue that does not exist yet: no worker ever started on this database.
      throw new ProblemError(503, "Job queue unavailable", {
        type: "urn:restow:problem:queue-unavailable",
        detail:
          "The export queue does not exist yet. Start the worker so it creates the queues, then try again.",
      });
    }
    await tx.update(jobs).set({ pgBossJobId }).where(eq(jobs.id, jobId));

    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: EXPORT_AUDIT_ACTIONS.requested,
      target: exportId,
      targetType: "export_job",
      onBehalfOf: source.onBehalfOf,
      ip: actor.ip,
      details: {
        jobId,
        origin: input.origin,
        format,
        ...source.auditDetails,
        fileName: input.fileName ?? null,
        reason: input.reason ?? null,
        onBehalfOf: source.onBehalfOf,
      },
    });

    return { id: exportId, jobId, status: "queued" };
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const exportColumns = {
  export: mailExports,
  job: jobs,
  progress: jobProgress,
  object: protectedObjects,
  ownerEmail: users.email,
  actorName: user.name,
  actorEmail: user.email,
};

function exportQuery(tx: DbExecutor) {
  return tx
    .select(exportColumns)
    .from(mailExports)
    .leftJoin(jobs, eq(jobs.id, mailExports.jobId))
    .leftJoin(jobProgress, eq(jobProgress.jobId, jobs.id))
    .leftJoin(protectedObjects, eq(protectedObjects.id, mailExports.protectedObjectId))
    .leftJoin(users, eq(users.id, protectedObjects.userId))
    .leftJoin(user, eq(user.id, mailExports.actorUserId));
}

/** SQL filter for the exports a viewer may see: admins all of the tenant, everybody else their own requests. */
function visibleExportsCondition(viewer: Viewer): SQL | null {
  if (isTenantAdmin(viewer.role)) {
    return null;
  }
  return viewer.userId === null ? sql`false` : eq(mailExports.actorUserId, viewer.userId);
}

function isVisibleTo(viewer: Viewer, row: ExportRow): boolean {
  return (
    isTenantAdmin(viewer.role) ||
    (viewer.userId !== null && row.export.actorUserId === viewer.userId)
  );
}

async function loadExportRow(
  tx: DbExecutor,
  tenantId: string,
  viewer: Viewer,
  id: string,
): Promise<ExportRow> {
  const [row] = await exportQuery(tx)
    .where(and(eq(mailExports.tenantId, tenantId), eq(mailExports.id, id)))
    .limit(1);
  if (!row || !isVisibleTo(viewer, row)) {
    throw new ProblemError(404, "Export not found");
  }
  return row;
}

export async function listExports(
  db: Database,
  tenantId: string,
  viewer: Viewer,
  query: ListExportsQuery,
  options: ExportServiceOptions = {},
): Promise<ExportDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const visible = visibleExportsCondition(viewer);
    const rows = await exportQuery(tx)
      .where(and(eq(mailExports.tenantId, tenantId), ...(visible ? [visible] : [])))
      .orderBy(desc(mailExports.createdAt))
      .limit(query.limit);
    const at = (options.now ?? (() => new Date()))();
    return rows.map((row) => toExportDto(row, at, config.exports.ttlHours));
  });
}

export async function getExport(
  db: Database,
  tenantId: string,
  viewer: Viewer,
  id: string,
  options: ExportServiceOptions = {},
): Promise<ExportDetailDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const row = await loadExportRow(tx, tenantId, viewer, id);
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
    const at = (options.now ?? (() => new Date()))();
    return {
      ...toExportDto(row, at, config.exports.ttlHours),
      reason: row.export.reason,
      errorMessage: row.job?.errorMessage ?? null,
      report: reportFromJson(row.export.report),
      failures,
    };
  });
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export async function cancelExport(
  db: Database,
  tenantId: string,
  actor: ExportActor,
  id: string,
  options: ExportServiceOptions = {},
): Promise<ExportDetailDto> {
  await withTenantTx(db, tenantId, async (tx) => {
    const row = await loadExportRow(tx, tenantId, actor, id);
    if (!row.job || (row.job.status !== "queued" && row.job.status !== "active")) {
      throw new ProblemError(409, "Export not cancellable", {
        detail: "Only queued or running exports can be cancelled.",
        // Not `status`: an extension member of that name would overwrite the problem's own.
        extensions: { jobStatus: row.job?.status ?? "unknown" },
      });
    }
    // The worker checks the row: a queued job never starts, a running one
    // aborts at its next checkpoint (apps/worker framework).
    await tx.update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, row.job.id));
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: EXPORT_AUDIT_ACTIONS.cancelled,
      target: id,
      targetType: "export_job",
      ip: actor.ip,
      details: { jobId: row.job.id, previousStatus: row.job.status },
    });
  });
  return getExport(db, tenantId, actor, id, options);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export interface ExportDownload {
  stream: Readable;
  size: number;
  fileName: string;
  contentType: string;
}

/**
 * Open the finished file for streaming. Every refusal happens before the audit
 * entry and before the first byte; the entry is written before streaming
 * starts, so a download that begins is always on record.
 */
export async function openDownload(
  db: Database,
  tenantId: string,
  actor: ExportActor,
  id: string,
  options: ExportServiceOptions = {},
): Promise<ExportDownload> {
  const row = await withTenantTx(db, tenantId, (tx) => loadExportRow(tx, tenantId, actor, id));
  const now = (options.now ?? (() => new Date()))();
  const status = row.job?.status ?? "unknown";
  if (status !== "completed") {
    throw new ProblemError(409, "Export not ready", {
      type: "urn:restow:problem:export-not-ready",
      detail: "The export has not completed yet.",
      extensions: { jobStatus: status },
    });
  }
  const availability = exportAvailability(
    {
      status,
      completedAt: row.job?.completedAt ?? null,
      expiresAt: row.export.expiresAt,
      purgedAt: row.export.purgedAt,
    },
    now,
    config.exports.ttlHours,
  );
  if (availability.expired) {
    throw new ProblemError(410, "Export expired", {
      type: "urn:restow:problem:export-expired",
      detail:
        "Exports are kept for a limited time after they completed and then deleted. Request the export again.",
      extensions: { expiresAt: availability.expiresAt?.toISOString() ?? null },
    });
  }

  const { fileName, fileSize, segmentSize } = row.export;
  if (fileName === null || fileSize === null || segmentSize === null) {
    throw new ProblemError(404, "Export file not found", {
      detail: "The export finished without a file. Request the export again.",
    });
  }

  const store = await segmentStoreFor(db, tenantId);
  const scope: mailfiles.SegmentScope = { tenantId, kind: "export", id };
  const layout: mailfiles.SegmentLayout = { size: fileSize, segmentSize };
  // Refuse before the first byte when the sealed segments are gone (deleted early, storage
  // restored from an older copy): a download that starts must be able to finish.
  if (!hasEverySegment(await store.indexes(scope), mailfiles.segmentCount(layout))) {
    throw new ProblemError(410, "Export file gone", {
      type: "urn:restow:problem:export-file-missing",
      detail: "The export file is no longer present in storage. Request the export again.",
    });
  }

  await audit(db, {
    tenantId,
    actor: actor.email,
    actorUserId: actor.userId,
    action: EXPORT_AUDIT_ACTIONS.downloaded,
    target: id,
    targetType: "export_job",
    onBehalfOf: row.object
      ? onBehalfOfOwner(actor, { externalId: row.object.externalId, ownerEmail: row.ownerEmail })
      : null,
    ip: actor.ip,
    details: {
      origin: row.export.origin,
      format: row.export.format,
      snapshotId: row.export.snapshotId,
      protectedObjectId: row.export.protectedObjectId,
      fileName,
      size: fileSize,
      sha256: row.export.sha256,
    },
  });

  return {
    stream: store.readStream(scope, layout),
    size: fileSize,
    fileName,
    contentType: row.export.contentType ?? fallbackContentType(row.export.format),
  };
}
