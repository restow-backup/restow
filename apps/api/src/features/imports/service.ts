import { createHash, randomUUID } from "node:crypto";
import { mailfiles } from "@restow/core";
import {
  type Database,
  type ImportUpload,
  type MailImportRequestFile,
  importUploadSegments,
  importUploads,
  itemFailures,
  jobProgress,
  jobs,
  mailImports,
  protectedObjects,
  sources,
  user,
} from "@restow/db";
import { and, asc, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { audit } from "../../lib/audit.js";
import { segmentStoreFor } from "../../lib/segment-store.js";
import { type DbExecutor, type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { type Role, isTenantAdmin } from "../../middleware/rbac.js";
import { ProblemError } from "../../problem.js";
import { cancelQueuedJob, sendJob } from "../jobs/queue.js";
import { resolveTenantStorage } from "../restore/storage.js";
import { SOURCE_AUDIT_ACTIONS } from "../sources/service.js";
import { assertDeclaredLength, readSegmentBody } from "./body.js";
import {
  type ImportConfigDto,
  type ImportCreatedDto,
  type ImportDetailDto,
  type ImportFailureDto,
  type ImportFolderDto,
  type ImportFolderEntryDto,
  type ImportRow,
  type ImportSummaryDto,
  type ImportUploadDto,
  REFUSED_IMPORT_FORMATS,
  SUPPORTED_IMPORT_FORMATS,
  expectedSegmentSize,
  isSupportedFormat,
  isUploadExpired,
  missingSegments,
  refusalFor,
  toDetailDto,
  toSummaryDto,
  toUploadDto,
} from "./dto.js";
import {
  effectiveSegmentSize,
  findOverlappingFolderEntries,
  mapWithConcurrency,
  storedFolderPath,
} from "./logic.js";
import {
  type CreateImportInput,
  type CreateUploadInput,
  type FolderQuery,
  type ListImportsQuery,
  normalizeFolderPath,
  segmentSha256Schema,
} from "./schemas.js";
import { type TenantFolder, openTenantFolder } from "./tenant-folder.js";

/**
 * Mail file import (docs/IMPORT.md).
 *
 * Files arrive as chunked, resumable uploads into the encrypted staging area
 * of the tenant's storage (one sealed segment per client chunk,
 * lib/segment-store.ts) or are picked from the server-side import folder. An
 * import request turns them into one job: the files are read into an
 * "imported mailbox", a protected object of kind `imap` under the tenant's
 * source of kind `import`, whose snapshots use the IMAP backup's manifest
 * format. Nothing is ever backed up from such a source.
 *
 * A request becomes four things in one transaction: the `mail_imports` row
 * (what, into which mailbox, by whom), the `jobs` lifecycle row the worker
 * drives, the pg-boss queue entry and the audit entry. Every upload step and
 * every request is audited.
 */

/** Audit actions written by this feature. */
export const IMPORT_AUDIT_ACTIONS = {
  uploadCreated: "import.upload.created",
  uploadCompleted: "import.upload.completed",
  uploadCancelled: "import.upload.cancelled",
  requested: "import.requested",
  cancelled: "import.cancelled",
} as const;

/** The name of the tenant's one import source. */
export const IMPORT_SOURCE_NAME = "Imported mail files";

/** Most uploads a tenant may have open (uploading or ready, not expired) at once. */
export const MAX_OPEN_UPLOADS = 20;
/**
 * Declared bytes of the tenant's uploads that still hold staged segments: the open uploads (not
 * expired) and the files of an import that has not ended yet (queued or running, so a retry can
 * still read them). What an import consumed and finished is deleted by the worker.
 */
export async function stagedBytesInUse(
  tx: DbExecutor,
  tenantId: string,
  now: Date,
): Promise<number> {
  const result = await tx.execute<{ bytes: string }>(sql`
    SELECT coalesce(sum(u.size), 0)::text AS bytes
    FROM ${importUploads} u
    WHERE u.tenant_id = ${tenantId}
      AND (
        (u.status IN ('uploading', 'ready') AND u.expires_at > ${now})
        OR (
          u.status = 'consumed'
          AND EXISTS (
            SELECT 1 FROM ${mailImports} i
            JOIN ${jobs} j ON j.id = i.job_id
            WHERE i.id = u.import_id AND j.status IN ('queued', 'active')
          )
        )
      )
  `);
  return Number(result.rows[0]?.bytes ?? 0);
}

/** Most entries the folder browser lists for one directory. */
export const MAX_FOLDER_ENTRIES = 2000;
/** Files sniffed at the same time while a folder is listed. */
const SNIFF_CONCURRENCY = 16;
/** Longest list of missing segment indexes an error carries. */
const MAX_LISTED_MISSING = 200;

export interface ImportActor {
  role: Role;
  userId: string | null;
  email: string;
  ip: string | null;
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

export const FORMAT_NOT_SUPPORTED_PROBLEM = "urn:restow:problem:import-format-not-supported";
export const SEGMENT_CORRUPT_PROBLEM = "urn:restow:problem:import-segment-corrupt";

function uploadNotFound(): ProblemError {
  return new ProblemError(404, "Upload not found");
}

function importNotFound(): ProblemError {
  return new ProblemError(404, "Import not found");
}

function uploadExpired(upload: Pick<ImportUpload, "expiresAt">): ProblemError {
  return new ProblemError(410, "Upload expired", {
    type: "urn:restow:problem:import-upload-expired",
    detail: "This upload was not finished or used in time and its data is removed. Start it again.",
    extensions: { expiresAt: upload.expiresAt.toISOString() },
  });
}

function uploadNotOpen(status: string): ProblemError {
  return new ProblemError(409, "Upload is not open", {
    type: "urn:restow:problem:import-upload-not-open",
    detail: "Segments can only be sent while the upload is being uploaded.",
    extensions: { status },
  });
}

function queueUnavailable(): ProblemError {
  return new ProblemError(503, "Job queue unavailable", {
    type: "urn:restow:problem:queue-unavailable",
    detail:
      "The import queue does not exist yet. Start the worker so it creates the queues, then try again.",
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function canUseUpload(actor: Pick<ImportActor, "role" | "userId">, upload: ImportUpload): boolean {
  return isTenantAdmin(actor.role) || (actor.userId !== null && upload.createdBy === actor.userId);
}

function stagingScope(tenantId: string, uploadId: string): mailfiles.SegmentScope {
  return { tenantId, kind: "staging", id: uploadId };
}

/** Delete staged segments after the database moved on; a failure only leaves data for the expiry cleanup. */
async function deleteStagedSegments(
  db: Database,
  tenantId: string,
  uploadIds: readonly string[],
): Promise<void> {
  if (uploadIds.length === 0) {
    return;
  }
  try {
    const store = await segmentStoreFor(db, tenantId);
    for (const uploadId of uploadIds) {
      await store.delete(stagingScope(tenantId, uploadId));
    }
  } catch {
    // The upload rows are terminal; the expiry cleanup removes what is left.
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export async function getImportConfig(
  db: Database,
  tenantId: string,
  tenantSlug: string,
): Promise<ImportConfigDto> {
  const [folder, storageReady] = await Promise.all([
    openTenantFolder(config.imports.dir, tenantSlug),
    config.demo.enabled
      ? Promise.resolve(false)
      : resolveTenantStorage(db, tenantId).then(
          () => true,
          () => false,
        ),
  ]);
  return {
    uploadEnabled: storageReady,
    maxFileBytes: config.imports.maxFileBytes,
    segmentSize: mailfiles.clampSegmentSize(config.imports.segmentBytes),
    uploadExpiresHours: config.imports.uploadTtlHours,
    folder: { enabled: folder.enabled, exists: folder.exists, path: folder.path },
    supportedFormats: SUPPORTED_IMPORT_FORMATS,
    refusedFormats: REFUSED_IMPORT_FORMATS,
  };
}

// ---------------------------------------------------------------------------
// Server-side import folder
// ---------------------------------------------------------------------------

function folderProblem(error: unknown, notFoundStatus: 404 | 422): ProblemError {
  if (error instanceof mailfiles.ImportFolderError) {
    switch (error.code) {
      case "not_found":
        return new ProblemError(notFoundStatus, "Import folder path not found", {
          type: "urn:restow:problem:import-folder-path-unknown",
          detail: error.message,
        });
      case "outside_root":
        return new ProblemError(422, "Import folder path not allowed", {
          type: "urn:restow:problem:import-folder-path-invalid",
          detail: error.message,
        });
      case "not_a_directory":
        return new ProblemError(422, "Not a directory", {
          type: "urn:restow:problem:import-folder-path-invalid",
          detail: error.message,
        });
      case "not_regular":
        return new ProblemError(422, "Not a regular file", {
          type: "urn:restow:problem:import-folder-path-invalid",
          detail: error.message,
        });
    }
  }
  return new ProblemError(422, "Import folder path could not be read", {
    type: "urn:restow:problem:import-folder-path-invalid",
    detail: "The entry could not be read from the import folder.",
  });
}

/** What a file's first bytes say it is; null when it could not be read. */
async function sniffFile(file: mailfiles.MailInputFile): Promise<mailfiles.MailFileFormat | null> {
  try {
    return mailfiles.detectMailFormat(await file.read(0, mailfiles.SNIFF_HEAD_BYTES)).format;
  } catch {
    return null;
  }
}

export async function listFolder(tenantSlug: string, query: FolderQuery): Promise<ImportFolderDto> {
  const tenantFolder = await openTenantFolder(config.imports.dir, tenantSlug);
  const folder = tenantFolder.folder;
  if (folder === null) {
    // The feature is off on this server, or the admin has not created the tenant's folder yet.
    return {
      enabled: tenantFolder.enabled,
      exists: false,
      path: tenantFolder.path,
      current: "",
      entries: [],
      truncated: false,
    };
  }
  let current: string;
  let listed: mailfiles.ImportFolderEntry[];
  try {
    current = mailfiles.splitRelativePath(query.path).join("/");
    listed = await folder.list(current, MAX_FOLDER_ENTRIES + 1);
  } catch (error) {
    throw folderProblem(error, 404);
  }
  const truncated = listed.length > MAX_FOLDER_ENTRIES;
  const entries = await mapWithConcurrency(
    truncated ? listed.slice(0, MAX_FOLDER_ENTRIES) : listed,
    SNIFF_CONCURRENCY,
    async (entry): Promise<ImportFolderEntryDto> => {
      const base = {
        name: entry.name,
        path: entry.path,
        type: entry.type,
        size: entry.size,
        modifiedAt: entry.modifiedAt.toISOString(),
      };
      if (entry.type === "directory") {
        // A directory can be selected as a whole; its files are judged when it is read.
        return { ...base, format: null, supported: true };
      }
      let format: mailfiles.MailFileFormat | null = null;
      try {
        format = await sniffFile(await folder.file(entry.path));
      } catch {
        // Vanished or unreadable since the listing: shown without a format, not selectable.
      }
      return { ...base, format, supported: isSupportedFormat(format) };
    },
  );
  return { enabled: true, exists: true, path: tenantFolder.path, current, entries, truncated };
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

async function loadUpload(
  tx: DbExecutor,
  tenantId: string,
  actor: ImportActor,
  id: string,
  lock?: "share" | "update",
): Promise<ImportUpload> {
  const query = tx
    .select()
    .from(importUploads)
    .where(and(eq(importUploads.tenantId, tenantId), eq(importUploads.id, id)))
    .limit(1);
  const [row] = lock ? await query.for(lock) : await query;
  if (!row || !canUseUpload(actor, row)) {
    throw uploadNotFound();
  }
  return row;
}

async function receivedIndexes(tx: DbExecutor, uploadId: string): Promise<number[]> {
  const rows = await tx
    .select({ index: importUploadSegments.segmentIndex })
    .from(importUploadSegments)
    .where(eq(importUploadSegments.uploadId, uploadId))
    .orderBy(asc(importUploadSegments.segmentIndex));
  return rows.map((row) => row.index);
}

export async function createUpload(
  db: Database,
  tenantId: string,
  actor: ImportActor,
  input: CreateUploadInput,
): Promise<ImportUploadDto> {
  if (input.size > config.imports.maxFileBytes) {
    throw new ProblemError(413, "File too large", {
      type: "urn:restow:problem:import-file-too-large",
      detail: `Files larger than ${config.imports.maxFileBytes} bytes cannot be uploaded. Put the file into the import folder on the server instead.`,
      extensions: { size: input.size, maxFileBytes: config.imports.maxFileBytes },
    });
  }
  const segmentSize = effectiveSegmentSize(input.segmentSize, config.imports.segmentBytes);
  const segmentCount = Math.ceil(input.size / segmentSize);

  return withTenantTx(db, tenantId, async (tx) => {
    // Serialises the count and the insert, so two requests cannot both take the last slot.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`import-uploads:${tenantId}`}))`);
    const now = new Date();
    const [open] = await tx
      .select({ n: count() })
      .from(importUploads)
      .where(
        and(
          eq(importUploads.tenantId, tenantId),
          inArray(importUploads.status, ["uploading", "ready"]),
          gt(importUploads.expiresAt, now),
        ),
      );
    if ((open?.n ?? 0) >= MAX_OPEN_UPLOADS) {
      throw new ProblemError(429, "Too many open uploads", {
        type: "urn:restow:problem:import-too-many-uploads",
        detail: `At most ${MAX_OPEN_UPLOADS} uploads can be open at once. Finish an import or cancel an upload first.`,
        extensions: { limit: MAX_OPEN_UPLOADS, open: open?.n ?? 0 },
      });
    }
    const staged = await stagedBytesInUse(tx, tenantId, now);
    if (staged + input.size > config.imports.maxStagingBytes) {
      throw new ProblemError(422, "Import staging area full", {
        type: "urn:restow:problem:import-staging-full",
        detail: `The files that are waiting for an import already take ${staged} of the ${config.imports.maxStagingBytes} bytes the staging area of this organization may use, so a file of ${input.size} bytes does not fit. Finish or cancel an upload, wait until an import has finished, or put the file into the import folder on the server instead.`,
        extensions: {
          stagedBytes: staged,
          limitBytes: config.imports.maxStagingBytes,
          size: input.size,
        },
      });
    }
    const expiresAt = new Date(now.getTime() + config.imports.uploadTtlHours * 3_600_000);
    const [row] = await tx
      .insert(importUploads)
      .values({
        tenantId,
        createdBy: actor.userId,
        fileName: input.fileName,
        size: input.size,
        segmentSize,
        segmentCount,
        status: "uploading",
        expiresAt,
      })
      .returning();
    if (!row) {
      throw new Error("upload insert returned no row");
    }
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: IMPORT_AUDIT_ACTIONS.uploadCreated,
      target: row.id,
      targetType: "import_upload",
      ip: actor.ip,
      details: {
        fileName: row.fileName,
        size: row.size,
        segmentSize: row.segmentSize,
        segmentCount: row.segmentCount,
      },
    });
    return toUploadDto(row, [], now);
  });
}

/** The tenant's uploads that can still be used or resumed (not expired), newest first. */
export async function listUploads(
  db: Database,
  tenantId: string,
  actor: ImportActor,
): Promise<ImportUploadDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const now = new Date();
    const rows = await tx
      .select()
      .from(importUploads)
      .where(
        and(
          eq(importUploads.tenantId, tenantId),
          inArray(importUploads.status, ["uploading", "ready"]),
          gt(importUploads.expiresAt, now),
        ),
      )
      .orderBy(desc(importUploads.createdAt))
      .limit(MAX_OPEN_UPLOADS * 2);
    const visible = rows.filter((row) => canUseUpload(actor, row));
    const received = new Map<string, number[]>();
    if (visible.length > 0) {
      const segments = await tx
        .select({
          uploadId: importUploadSegments.uploadId,
          index: importUploadSegments.segmentIndex,
        })
        .from(importUploadSegments)
        .where(
          inArray(
            importUploadSegments.uploadId,
            visible.map((row) => row.id),
          ),
        );
      for (const segment of segments) {
        const list = received.get(segment.uploadId) ?? [];
        list.push(segment.index);
        received.set(segment.uploadId, list);
      }
    }
    return visible.map((row) => toUploadDto(row, received.get(row.id) ?? [], now));
  });
}

export async function getUpload(
  db: Database,
  tenantId: string,
  actor: ImportActor,
  id: string,
): Promise<ImportUploadDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const row = await loadUpload(tx, tenantId, actor, id);
    return toUploadDto(row, await receivedIndexes(tx, row.id), new Date());
  });
}

export interface SegmentRequest {
  /** The request body; read with a hard cap of exactly the expected segment size. */
  body: ReadableStream<Uint8Array> | null;
  contentLength: string | undefined;
  sha256: string | undefined;
}

export interface SegmentReceipt {
  index: number;
  size: number;
  sha256: string;
  receivedCount: number;
}

/**
 * Store one segment. The database is not held open while the body streams in:
 * the upload is checked first, the bytes are read (at most one segment in
 * memory), sealed and stored, and only then is the segment recorded, after
 * the upload was checked once more (it may have been cancelled meanwhile).
 * Sending an index again replaces it, so a retry is harmless.
 */
export async function putSegment(
  db: Database,
  tenantId: string,
  actor: ImportActor,
  id: string,
  index: number,
  request: SegmentRequest,
): Promise<SegmentReceipt> {
  const expectedHash =
    request.sha256 === undefined ? null : segmentSha256Schema.safeParse(request.sha256);
  if (expectedHash !== null && !expectedHash.success) {
    throw new ProblemError(422, "Validation failed", {
      detail: "X-Segment-Sha256 must be 64 hexadecimal digits.",
      extensions: { header: "X-Segment-Sha256" },
    });
  }

  const upload = await withTenantTx(db, tenantId, async (tx) => {
    const row = await loadUpload(tx, tenantId, actor, id);
    if (isUploadExpired(row, new Date())) {
      throw uploadExpired(row);
    }
    if (row.status !== "uploading") {
      throw uploadNotOpen(row.status);
    }
    return row;
  });
  if (index >= upload.segmentCount) {
    throw new ProblemError(422, "Segment index out of range", {
      type: "urn:restow:problem:import-segment-out-of-range",
      detail: `This upload has ${upload.segmentCount} segments (0 to ${upload.segmentCount - 1}).`,
      extensions: { segmentCount: upload.segmentCount },
    });
  }

  const expected = expectedSegmentSize(upload, index);
  assertDeclaredLength(request.contentLength, expected);
  const store = await segmentStoreFor(db, tenantId);
  const data = await readSegmentBody(request.body, expected);

  const actualHash = createHash("sha256").update(data).digest("hex");
  if (expectedHash?.success && expectedHash.data.toLowerCase() !== actualHash) {
    throw new ProblemError(422, "Segment corrupt", {
      type: SEGMENT_CORRUPT_PROBLEM,
      detail: "The segment does not match its SHA-256 checksum. Send it again.",
      extensions: { index },
    });
  }

  const scope = stagingScope(tenantId, id);
  const stored = await store.put(scope, index, data);

  const receipt = await withTenantTx(db, tenantId, async (tx) => {
    // Shared lock: a cancel (which updates the row) waits for this record, or is seen here.
    const fresh = await loadUpload(tx, tenantId, actor, id, "share");
    if (fresh.status !== "uploading") {
      return null;
    }
    await tx
      .insert(importUploadSegments)
      .values({
        uploadId: id,
        tenantId,
        segmentIndex: index,
        size: stored.size,
        sha256: stored.sha256,
      })
      .onConflictDoUpdate({
        target: [importUploadSegments.uploadId, importUploadSegments.segmentIndex],
        set: { size: stored.size, sha256: stored.sha256, createdAt: new Date() },
      });
    const [received] = await tx
      .select({ n: count() })
      .from(importUploadSegments)
      .where(eq(importUploadSegments.uploadId, id));
    return received?.n ?? 0;
  });
  if (receipt === null) {
    // The upload was cancelled while this segment was on its way: do not leave it behind.
    await deleteStagedSegments(db, tenantId, [id]);
    throw uploadNotOpen("cancelled");
  }
  return { index, size: stored.size, sha256: stored.sha256, receivedCount: receipt };
}

/**
 * Finish an upload: every segment must be there and the sizes must add up to
 * the declared size. The first 64 KiB of the reassembled file decide its
 * format. A PST or an unrecognised file still becomes `ready` (the person sees
 * why it is refused and can cancel it); an import request refuses it.
 */
export async function completeUpload(
  db: Database,
  tenantId: string,
  actor: ImportActor,
  id: string,
): Promise<ImportUploadDto> {
  const { upload, segments } = await withTenantTx(db, tenantId, async (tx) => {
    const row = await loadUpload(tx, tenantId, actor, id);
    if (isUploadExpired(row, new Date())) {
      throw uploadExpired(row);
    }
    const rows = await tx
      .select({
        index: importUploadSegments.segmentIndex,
        size: importUploadSegments.size,
      })
      .from(importUploadSegments)
      .where(eq(importUploadSegments.uploadId, id))
      .orderBy(asc(importUploadSegments.segmentIndex));
    return { upload: row, segments: rows };
  });
  if (upload.status === "ready") {
    // Completing twice (a lost response, a retry) returns the same answer.
    return toUploadDto(
      upload,
      segments.map((segment) => segment.index),
      new Date(),
    );
  }
  if (upload.status !== "uploading") {
    throw uploadNotOpen(upload.status);
  }

  const store = await segmentStoreFor(db, tenantId);
  const scope = stagingScope(tenantId, id);
  // The database says what was received, the storage target is the truth about what is still there.
  const inStorage = new Set(await store.indexes(scope));
  const present = segments.filter((segment) => inStorage.has(segment.index));
  const missing = missingSegments(
    upload.segmentCount,
    present.map((segment) => segment.index),
  );
  if (missing.length > 0) {
    throw new ProblemError(409, "Segments missing", {
      type: "urn:restow:problem:import-segments-missing",
      detail: `${missing.length} of ${upload.segmentCount} segments have not arrived. Send them, then complete the upload again.`,
      extensions: {
        missing: missing.slice(0, MAX_LISTED_MISSING),
        missingCount: missing.length,
        segmentCount: upload.segmentCount,
      },
    });
  }
  const wrongSize = present.find(
    (segment) => segment.size !== expectedSegmentSize(upload, segment.index),
  );
  const total = present.reduce((sum, segment) => sum + segment.size, 0);
  if (wrongSize || total !== upload.size) {
    throw new ProblemError(422, "Segment sizes do not add up", {
      type: SEGMENT_CORRUPT_PROBLEM,
      detail: `The segments hold ${total} bytes, the upload declared ${upload.size}. Cancel it and upload the file again.`,
      extensions: { declaredBytes: upload.size, receivedBytes: total },
    });
  }

  let format: mailfiles.MailFileFormat;
  try {
    const file = store.file(
      scope,
      { size: upload.size, segmentSize: upload.segmentSize },
      upload.fileName,
    );
    format = mailfiles.detectMailFormat(await file.read(0, mailfiles.SNIFF_HEAD_BYTES)).format;
  } catch (error) {
    if (error instanceof mailfiles.SegmentError) {
      throw new ProblemError(422, "Segment corrupt", {
        type: SEGMENT_CORRUPT_PROBLEM,
        detail: "A stored segment could not be read back. Send it again.",
        extensions: { index: error.index },
      });
    }
    throw error;
  }

  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .update(importUploads)
      .set({ status: "ready", detectedFormat: format })
      .where(
        and(
          eq(importUploads.tenantId, tenantId),
          eq(importUploads.id, id),
          eq(importUploads.status, "uploading"),
        ),
      )
      .returning();
    if (!row) {
      // Cancelled between the check above and now.
      throw uploadNotOpen("cancelled");
    }
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: IMPORT_AUDIT_ACTIONS.uploadCompleted,
      target: id,
      targetType: "import_upload",
      ip: actor.ip,
      details: {
        fileName: row.fileName,
        size: row.size,
        detectedFormat: format,
        refusal: refusalFor(format)?.code ?? null,
      },
    });
    return toUploadDto(
      row,
      segments.map((segment) => segment.index),
      new Date(),
    );
  });
}

export async function cancelUpload(
  db: Database,
  tenantId: string,
  actor: ImportActor,
  id: string,
): Promise<void> {
  const removed = await withTenantTx(db, tenantId, async (tx) => {
    const row = await loadUpload(tx, tenantId, actor, id, "update");
    if (row.status === "cancelled") {
      return false;
    }
    if (row.status === "consumed") {
      throw new ProblemError(409, "Upload already used", {
        type: "urn:restow:problem:import-upload-in-use",
        detail: "An import took this file over. Cancel the import instead.",
        extensions: { importId: row.importId },
      });
    }
    await tx
      .update(importUploads)
      .set({ status: "cancelled" })
      .where(and(eq(importUploads.tenantId, tenantId), eq(importUploads.id, id)));
    await tx.delete(importUploadSegments).where(eq(importUploadSegments.uploadId, id));
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: IMPORT_AUDIT_ACTIONS.uploadCancelled,
      target: id,
      targetType: "import_upload",
      ip: actor.ip,
      details: { fileName: row.fileName, size: row.size, previousStatus: row.status },
    });
    return true;
  });
  if (removed) {
    await deleteStagedSegments(db, tenantId, [id]);
  }
}

// ---------------------------------------------------------------------------
// Create an import
// ---------------------------------------------------------------------------

interface Refusal {
  code: "pst_not_supported" | "unrecognised" | "not_ready";
  /** Upload file name or folder path. */
  name: string;
  uploadId?: string;
  format?: string | null;
  message: string;
}

function formatRefused(refusals: readonly Refusal[]): ProblemError {
  const first = refusals[0] as Refusal;
  return new ProblemError(
    422,
    first.code === "not_ready" ? "Upload not ready" : "File not supported",
    {
      type: FORMAT_NOT_SUPPORTED_PROBLEM,
      detail:
        refusals.length === 1
          ? `${first.name}: ${first.message}`
          : `${refusals.length} files cannot be imported. ${first.name}: ${first.message}`,
      extensions: { code: first.code, entries: refusals },
    },
  );
}

function uploadRefusal(upload: ImportUpload, now: Date): Refusal | null {
  const base = { name: upload.fileName, uploadId: upload.id, format: upload.detectedFormat };
  if (upload.status !== "ready" || isUploadExpired(upload, now)) {
    return {
      ...base,
      code: "not_ready",
      message:
        upload.status === "consumed"
          ? "This file was already used by another import."
          : "The upload is not complete, was cancelled or has expired.",
    };
  }
  const refusal = refusalFor(upload.detectedFormat);
  if (refusal) {
    return { ...base, code: refusal.code, message: refusal.message };
  }
  if (!isSupportedFormat(upload.detectedFormat)) {
    return {
      ...base,
      code: "unrecognised",
      message: "The file was not checked for its format. Complete the upload first.",
    };
  }
  return null;
}

async function resolveUploadFiles(
  tx: DbExecutor,
  tenantId: string,
  actor: ImportActor,
  uploadIds: readonly string[],
): Promise<{ uploads: ImportUpload[]; entries: MailImportRequestFile[] }> {
  if (uploadIds.length === 0) {
    return { uploads: [], entries: [] };
  }
  // Locked: two requests cannot both take the same upload.
  const rows = await tx
    .select()
    .from(importUploads)
    .where(and(eq(importUploads.tenantId, tenantId), inArray(importUploads.id, [...uploadIds])))
    .for("update");
  const byId = new Map(rows.filter((row) => canUseUpload(actor, row)).map((row) => [row.id, row]));
  const unknown = uploadIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new ProblemError(422, "Unknown upload", {
      type: "urn:restow:problem:import-upload-unknown",
      detail: "Some uploads do not exist. Upload the files again.",
      extensions: { uploadIds: unknown },
    });
  }
  const now = new Date();
  const uploads = uploadIds.map((id) => byId.get(id) as ImportUpload);
  const refusals = uploads
    .map((upload) => uploadRefusal(upload, now))
    .filter((refusal): refusal is Refusal => refusal !== null);
  if (refusals.length > 0) {
    // A format problem is more useful to the person than a state problem.
    throw formatRefused([
      ...refusals.filter((refusal) => refusal.code !== "not_ready"),
      ...refusals.filter((refusal) => refusal.code === "not_ready"),
    ]);
  }
  return {
    uploads,
    entries: uploads.map((upload) => ({
      origin: "upload" as const,
      uploadId: upload.id,
      kind: "file" as const,
      path: upload.fileName,
      size: upload.size,
      format: upload.detectedFormat,
    })),
  };
}

/** Entries are tenant-relative here; createImport stores them with the `<slug>/` prefix. */
async function resolveFolderFiles(
  tenantFolder: TenantFolder,
  paths: readonly string[],
): Promise<MailImportRequestFile[]> {
  if (paths.length === 0) {
    return [];
  }
  const folder = tenantFolder.folder;
  if (folder === null) {
    throw new ProblemError(422, "Import folder not available", {
      type: "urn:restow:problem:import-folder-unavailable",
      detail: tenantFolder.enabled
        ? "The import folder of this tenant does not exist on the server. Create it inside the import folder, or upload the files instead."
        : "The server-side import folder does not exist or cannot be read. Upload the files instead.",
      extensions: { path: tenantFolder.path, enabled: tenantFolder.enabled },
    });
  }
  const entries: MailImportRequestFile[] = [];
  const refusals: Refusal[] = [];
  for (const rawPath of paths) {
    let path: string;
    try {
      path = mailfiles.splitRelativePath(rawPath).join("/");
    } catch (error) {
      throw folderProblem(error, 422);
    }
    let file: mailfiles.MailInputFile | null = null;
    try {
      file = await folder.file(path);
    } catch (error) {
      if (!(error instanceof mailfiles.ImportFolderError) || error.code !== "not_regular") {
        throw folderProblem(error, 422);
      }
    }
    if (file === null) {
      // Not a regular file: a directory selects the whole tree, anything else is an error.
      try {
        await folder.list(path, 0);
      } catch (error) {
        throw folderProblem(error, 422);
      }
      entries.push({ origin: "folder", kind: "directory", path, size: 0, format: null });
      continue;
    }
    const format = await sniffFile(file);
    const refusal = refusalFor(format);
    if (refusal) {
      refusals.push({ code: refusal.code, name: path, format, message: refusal.message });
    } else if (!isSupportedFormat(format)) {
      refusals.push({
        code: "unrecognised",
        name: path,
        format,
        message:
          "The file could not be read or is not a recognised mail file (EML, MSG, MBOX or ZIP).",
      });
    }
    entries.push({ origin: "folder", kind: "file", path, size: file.size, format });
  }
  if (refusals.length > 0) {
    throw formatRefused(refusals);
  }
  return entries;
}

async function importSourceFor(
  tx: Transaction,
  tenantId: string,
  actor: ImportActor,
): Promise<string> {
  const [existing] = await tx
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.kind, "import")))
    .orderBy(asc(sources.createdAt))
    .limit(1);
  if (existing) {
    return existing.id;
  }
  // The name is unique per tenant: an admin's own source may already carry it.
  const taken = new Set(
    (
      await tx.select({ name: sources.name }).from(sources).where(eq(sources.tenantId, tenantId))
    ).map((row) => row.name),
  );
  let name: string = IMPORT_SOURCE_NAME;
  for (let suffix = 2; taken.has(name); suffix++) {
    name = `${IMPORT_SOURCE_NAME} ${suffix}`;
  }
  const [created] = await tx
    .insert(sources)
    .values({ tenantId, kind: "import", name, status: "active", config: {} })
    .returning();
  if (!created) {
    throw new Error("import source insert returned no row");
  }
  await audit(tx, {
    tenantId,
    actor: actor.email,
    actorUserId: actor.userId,
    action: SOURCE_AUDIT_ACTIONS.created,
    target: created.id,
    targetType: "source",
    ip: actor.ip,
    details: { kind: "import", name },
  });
  return created.id;
}

export const IMPORT_ALREADY_QUEUED_PROBLEM = "urn:restow:problem:import-already-queued";

/**
 * One import waits per imported mailbox (the queue's singleton key is the
 * mailbox): a second one may queue behind a running one, but not behind one that
 * has not started yet.
 */
function importAlreadyQueued(jobId?: string): ProblemError {
  return new ProblemError(409, "Import already queued", {
    type: IMPORT_ALREADY_QUEUED_PROBLEM,
    detail:
      "An import into this mailbox is already waiting. It starts when the running one has finished.",
    ...(jobId ? { extensions: { jobId } } : {}),
  });
}

async function assertNoImportWaiting(
  tx: DbExecutor,
  tenantId: string,
  objectId: string,
): Promise<void> {
  const [waiting] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.queue, "import"),
        eq(jobs.protectedObjectId, objectId),
        eq(jobs.status, "queued"),
      ),
    )
    .limit(1);
  if (waiting) {
    throw importAlreadyQueued(waiting.id);
  }
}

export async function createImport(
  db: Database,
  tenantId: string,
  tenantSlug: string,
  actor: ImportActor,
  input: CreateImportInput,
): Promise<ImportCreatedDto> {
  // Read before the transaction: the disk is not part of it.
  const folderPaths = input.files.flatMap((file) => (file.origin === "folder" ? [file.path] : []));
  const overlap = findOverlappingFolderEntries(folderPaths);
  if (overlap) {
    throw new ProblemError(422, "Overlapping selection", {
      type: "urn:restow:problem:import-files-overlap",
      detail: `"${overlap[1] || "(import folder)"}" lies inside "${overlap[0] || "(import folder)"}", which is selected as a whole.`,
      extensions: { outer: overlap[0], inner: overlap[1] },
    });
  }
  const folderEntries = await resolveFolderFiles(
    await openTenantFolder(config.imports.dir, tenantSlug),
    folderPaths,
  );
  const uploadIds = input.files.flatMap((file) =>
    file.origin === "upload" ? [file.uploadId] : [],
  );

  return withTenantTx(db, tenantId, async (tx) => {
    // One import request at a time per tenant: the source, the name check and the in-flight check
    // below must not race another request.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`imports:${tenantId}`}))`);

    const { uploads, entries: uploadEntries } = await resolveUploadFiles(
      tx,
      tenantId,
      actor,
      uploadIds,
    );
    // Keep the order the person gave.
    const byKey = new Map<string, MailImportRequestFile>();
    for (const entry of [...uploadEntries, ...folderEntries]) {
      byKey.set(entry.origin === "upload" ? `u:${entry.uploadId}` : `f:${entry.path}`, entry);
    }
    const files = input.files.map((file) => {
      const key =
        file.origin === "upload" ? `u:${file.uploadId}` : `f:${normalizeFolderPath(file.path)}`;
      const entry = byKey.get(key) as MailImportRequestFile;
      // A server-folder path is stored relative to IMPORT_DIR, below the tenant's own `<slug>/`.
      return entry.origin === "folder"
        ? { ...entry, path: storedFolderPath(tenantSlug, entry.path) }
        : entry;
    });

    const sourceId = await importSourceFor(tx, tenantId, actor);

    let objectId: string;
    let name: string;
    let newMailbox: boolean;
    if (input.objectId !== undefined) {
      const [existing] = await tx
        .select({
          id: protectedObjects.id,
          kind: protectedObjects.kind,
          sourceId: protectedObjects.sourceId,
          displayName: protectedObjects.displayName,
          externalId: protectedObjects.externalId,
        })
        .from(protectedObjects)
        .where(
          and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.id, input.objectId)),
        )
        .limit(1);
      if (!existing) {
        throw new ProblemError(404, "Imported mailbox not found");
      }
      if (existing.sourceId !== sourceId || existing.kind !== "imap") {
        throw new ProblemError(422, "Not an imported mailbox", {
          type: "urn:restow:problem:import-object-not-imported",
          detail: "Files can only be added to a mailbox that was created by an import.",
        });
      }
      await assertNoImportWaiting(tx, tenantId, existing.id);
      objectId = existing.id;
      name = existing.displayName ?? existing.externalId;
      newMailbox = false;
    } else {
      name = input.name as string;
      const [sameName] = await tx
        .select({ id: protectedObjects.id })
        .from(protectedObjects)
        .where(
          and(
            eq(protectedObjects.tenantId, tenantId),
            eq(protectedObjects.sourceId, sourceId),
            sql`lower(${protectedObjects.displayName}) = lower(${name})`,
          ),
        )
        .limit(1);
      if (sameName) {
        throw new ProblemError(409, "Imported mailbox name in use", {
          type: "urn:restow:problem:import-name-taken",
          detail: `An imported mailbox named '${name}' already exists. Add the files to it, or choose another name.`,
          extensions: { name, objectId: sameName.id },
        });
      }
      objectId = randomUUID();
      const now = new Date();
      await tx.insert(protectedObjects).values({
        id: objectId,
        tenantId,
        sourceId,
        kind: "imap",
        origin: "manual",
        status: "active",
        externalId: `import-${objectId}`,
        displayName: name,
        activeSince: now,
      });
      newMailbox = true;
    }

    const importId = randomUUID();
    const jobId = randomUUID();
    const payload = { jobId, tenantId, importId, protectedObjectId: objectId };

    if (uploads.length > 0) {
      const consumed = await tx
        .update(importUploads)
        .set({ status: "consumed", importId })
        .where(
          and(
            eq(importUploads.tenantId, tenantId),
            inArray(
              importUploads.id,
              uploads.map((upload) => upload.id),
            ),
            eq(importUploads.status, "ready"),
          ),
        )
        .returning({ id: importUploads.id });
      if (consumed.length !== uploads.length) {
        throw new ProblemError(409, "Upload already used", {
          type: "urn:restow:problem:import-upload-in-use",
          detail: "One of the files was used by another import in the meantime.",
        });
      }
    }

    await tx.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "import",
      status: "queued",
      protectedObjectId: objectId,
      payload,
    });
    await tx.insert(mailImports).values({
      id: importId,
      tenantId,
      sourceId,
      protectedObjectId: objectId,
      jobId,
      name,
      files,
      options: { archive: input.archive },
      createdBy: actor.userId,
    });
    const pgBossJobId = await sendJob(tx, "import", payload);
    if (!pgBossJobId) {
      // The queue refuses a second waiting job with the same singleton key (the mailbox). For a new
      // mailbox nothing can be waiting, so no id means the queue does not exist yet.
      throw newMailbox ? queueUnavailable() : importAlreadyQueued();
    }
    await tx.update(jobs).set({ pgBossJobId }).where(eq(jobs.id, jobId));

    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: IMPORT_AUDIT_ACTIONS.requested,
      target: importId,
      targetType: "mail_import",
      ip: actor.ip,
      details: {
        jobId,
        protectedObjectId: objectId,
        sourceId,
        name,
        newMailbox,
        archive: input.archive,
        fileCount: files.length,
        files: files.map((file) => ({
          origin: file.origin,
          kind: file.kind,
          path: file.path,
          size: file.size,
          format: file.format,
        })),
      },
    });

    return { id: importId, jobId, objectId, sourceId };
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function importQuery(tx: DbExecutor) {
  return tx
    .select({
      mailImport: mailImports,
      job: jobs,
      progress: jobProgress,
      actorName: user.name,
      actorEmail: user.email,
    })
    .from(mailImports)
    .leftJoin(jobs, eq(jobs.id, mailImports.jobId))
    .leftJoin(jobProgress, eq(jobProgress.jobId, jobs.id))
    .leftJoin(user, eq(user.id, mailImports.createdBy));
}

async function loadImportRow(tx: DbExecutor, tenantId: string, id: string): Promise<ImportRow> {
  const [row] = await importQuery(tx)
    .where(and(eq(mailImports.tenantId, tenantId), eq(mailImports.id, id)))
    .limit(1);
  if (!row) {
    throw importNotFound();
  }
  return row;
}

export async function listImports(
  db: Database,
  tenantId: string,
  query: ListImportsQuery,
): Promise<ImportSummaryDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await importQuery(tx)
      .where(eq(mailImports.tenantId, tenantId))
      .orderBy(desc(mailImports.createdAt), desc(mailImports.id))
      .limit(query.limit)
      .offset(query.offset ?? 0);
    return rows.map(toSummaryDto);
  });
}

/** How many live item failures a detail response carries. */
export const MAX_FAILURES_IN_DETAIL = 500;

async function loadDetail(
  tx: DbExecutor,
  tenantId: string,
  tenantSlug: string,
  id: string,
): Promise<ImportDetailDto> {
  const row = await loadImportRow(tx, tenantId, id);
  const failures: ImportFailureDto[] = row.job
    ? await tx
        .select({
          itemRef: itemFailures.itemRef,
          reason: itemFailures.reason,
          attempts: itemFailures.attempts,
        })
        .from(itemFailures)
        .where(and(eq(itemFailures.tenantId, tenantId), eq(itemFailures.jobId, row.job.id)))
        .orderBy(desc(itemFailures.createdAt))
        .limit(MAX_FAILURES_IN_DETAIL)
    : [];
  return toDetailDto(row, failures, tenantSlug);
}

export async function getImport(
  db: Database,
  tenantId: string,
  tenantSlug: string,
  id: string,
): Promise<ImportDetailDto> {
  return withTenantTx(db, tenantId, (tx) => loadDetail(tx, tenantId, tenantSlug, id));
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export async function cancelImport(
  db: Database,
  tenantId: string,
  tenantSlug: string,
  actor: ImportActor,
  id: string,
): Promise<ImportDetailDto> {
  const { detail, pgBossJobId, stagedUploads } = await withTenantTx(db, tenantId, async (tx) => {
    const row = await loadImportRow(tx, tenantId, id);
    // Locked: the worker cannot move the job on while it is being cancelled.
    const [job] = row.job
      ? await tx.select().from(jobs).where(eq(jobs.id, row.job.id)).limit(1).for("update")
      : [];
    if (!job || (job.status !== "queued" && job.status !== "active")) {
      throw new ProblemError(409, "Import not cancellable", {
        detail: "Only queued or running imports can be cancelled.",
        extensions: { status: job?.status ?? "unknown" },
      });
    }
    // The worker checks the row: a queued job never starts, a running one
    // aborts at its next checkpoint (apps/worker framework).
    await tx
      .update(jobs)
      .set(
        job.status === "queued"
          ? { status: "cancelled", completedAt: new Date(), cursor: null }
          : { status: "cancelled" },
      )
      .where(eq(jobs.id, job.id));
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: IMPORT_AUDIT_ACTIONS.cancelled,
      target: id,
      targetType: "mail_import",
      ip: actor.ip,
      details: { jobId: job.id, previousStatus: job.status, name: row.mailImport.name },
    });
    // A queued import never runs, so nothing else will clean up its staged files.
    const staged =
      job.status === "queued"
        ? await tx
            .select({ id: importUploads.id })
            .from(importUploads)
            .where(and(eq(importUploads.tenantId, tenantId), eq(importUploads.importId, id)))
        : [];
    return {
      detail: await loadDetail(tx, tenantId, tenantSlug, id),
      pgBossJobId: job.status === "queued" ? job.pgBossJobId : null,
      stagedUploads: staged.map((upload) => upload.id),
    };
  });
  if (pgBossJobId) {
    // Best effort: the row already says cancelled, and the worker checks that before it starts a delivered job.
    await cancelQueuedJob("import", pgBossJobId, db).catch(() => undefined);
  }
  await deleteStagedSegments(db, tenantId, stagedUploads);
  return detail;
}
