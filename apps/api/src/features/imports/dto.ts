import type { mailfiles } from "@restow/core";
import type {
  ImportUpload,
  ImportUploadStatus,
  Job,
  JobProgress,
  MailImport,
  MailImportRequestFile,
} from "@restow/db";
import { type FailureDto, failureDto } from "../failures/dto.js";
import { runtimePhaseOf } from "../jobs/dto.js";
import { tenantRelativeFolderPath } from "./logic.js";

/**
 * Response shapes of the mail file import and the pure mapping from rows to
 * them (docs/IMPORT.md). Everything here is free of I/O, so it is unit tested
 * without a database.
 */

/** Formats an import reads. */
export const SUPPORTED_IMPORT_FORMATS = ["eml", "msg", "mbox", "zip"] as const;
/** Formats that are recognised and refused. */
export const REFUSED_IMPORT_FORMATS = ["pst"] as const;

export type SupportedImportFormat = (typeof SUPPORTED_IMPORT_FORMATS)[number];

export function isSupportedFormat(format: string | null | undefined): boolean {
  return (SUPPORTED_IMPORT_FORMATS as readonly string[]).includes(format ?? "");
}

export type RefusalCode = "pst_not_supported" | "unrecognised";

export const PST_REFUSAL_MESSAGE =
  "PST and OST import is planned for a later release. Export the mailbox from Outlook as .msg or .eml files (or convert it to MBOX) and import those.";
export const UNRECOGNISED_REFUSAL_MESSAGE =
  "The file is not a recognised mail file (EML, MSG, MBOX or ZIP).";

export interface ImportRefusal {
  code: RefusalCode;
  message: string;
}

/** Why a detected format is refused; null for a supported format and for a file not looked at yet. */
export function refusalFor(format: string | null | undefined): ImportRefusal | null {
  if (format === "pst") {
    return { code: "pst_not_supported", message: PST_REFUSAL_MESSAGE };
  }
  if (format === "unknown") {
    return { code: "unrecognised", message: UNRECOGNISED_REFUSAL_MESSAGE };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Configuration and folder
// ---------------------------------------------------------------------------

export interface ImportConfigDto {
  uploadEnabled: boolean;
  maxFileBytes: number;
  segmentSize: number;
  uploadExpiresHours: number;
  /**
   * The tenant's own server-side folder: `path` is `<IMPORT_DIR>/<tenant slug>` (for display),
   * `enabled` means IMPORT_DIR is a readable directory, `exists` that the tenant's
   * subdirectory is there (while it is not, the listing is empty and the admin creates it).
   */
  folder: { enabled: boolean; exists: boolean; path: string };
  supportedFormats: readonly SupportedImportFormat[];
  refusedFormats: readonly "pst"[];
}

export interface ImportFolderEntryDto {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
  modifiedAt: string;
  format: mailfiles.MailFileFormat | null;
  supported: boolean;
}

export interface ImportFolderDto {
  enabled: boolean;
  /** The tenant's folder on the server, `<IMPORT_DIR>/<tenant slug>`. */
  exists: boolean;
  path: string;
  /** The listed directory relative to the tenant's folder ("" for the folder itself). */
  current: string;
  entries: ImportFolderEntryDto[];
  /** True when the directory holds more entries than are listed. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/** The stored status, with `expired` derived for an upload nobody finished or used in time. */
export type ImportUploadStatusDto = ImportUploadStatus;

export interface ImportUploadDto {
  id: string;
  fileName: string;
  size: number;
  segmentSize: number;
  segmentCount: number;
  status: ImportUploadStatusDto;
  receivedSegments: number[];
  detectedFormat: mailfiles.MailFileFormat | null;
  refusal: ImportRefusal | null;
  expiresAt: string;
}

export function isUploadExpired(
  row: Pick<ImportUpload, "status" | "expiresAt">,
  now: Date,
): boolean {
  return (row.status === "uploading" || row.status === "ready") && row.expiresAt <= now;
}

const FORMATS: ReadonlySet<string> = new Set(["eml", "msg", "mbox", "zip", "pst", "unknown"]);

function asFormat(value: string | null | undefined): mailfiles.MailFileFormat | null {
  return value !== null && value !== undefined && FORMATS.has(value)
    ? (value as mailfiles.MailFileFormat)
    : null;
}

export function toUploadDto(
  row: ImportUpload,
  receivedSegments: readonly number[],
  now: Date,
): ImportUploadDto {
  const detectedFormat = asFormat(row.detectedFormat);
  return {
    id: row.id,
    fileName: row.fileName,
    size: row.size,
    segmentSize: row.segmentSize,
    segmentCount: row.segmentCount,
    status: isUploadExpired(row, now) ? "expired" : row.status,
    receivedSegments: [...receivedSegments].sort((a, b) => a - b),
    detectedFormat,
    refusal: refusalFor(detectedFormat),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** Plaintext bytes segment `index` of an upload must have (the last one carries the remainder). */
export function expectedSegmentSize(
  layout: { size: number; segmentSize: number; segmentCount: number },
  index: number,
): number {
  return index < layout.segmentCount - 1
    ? layout.segmentSize
    : layout.size - layout.segmentSize * (layout.segmentCount - 1);
}

/** Segment indexes 0..count-1 that are not in `received`. */
export function missingSegments(segmentCount: number, received: Iterable<number>): number[] {
  const have = new Set(received);
  const missing: number[] = [];
  for (let index = 0; index < segmentCount; index++) {
    if (!have.has(index)) {
      missing.push(index);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export type ImportStatus = Job["status"] | "unknown";

/**
 * The import worker's progress row: `total` and `done` are SOURCE bytes (the
 * sum of the selected files' sizes and the part consumed so far, percent =
 * done / total), `bytes` the plaintext bytes of the stored messages, `failed`
 * the number of failed items.
 */
export interface ImportProgressDto {
  total: number;
  done: number;
  failed: number;
  bytes: number;
  etaSeconds: number | null;
}

/** Live counters of a running import (`jobs.payload.importLive`, written about once a second). */
export interface ImportLiveDto {
  messages: number;
  duplicates: number;
  skipped: number;
  failed: number;
  /** Files and folders of the selection that were finished. */
  filesDone: number;
  /** Files and folders of the selection, folders of a tree counted too. */
  filesTotal: number;
}

export interface ImportFailureDto {
  itemRef: string;
  reason: string;
  attempts: number;
}

export interface ImportSummaryDto {
  id: string;
  name: string;
  objectId: string;
  sourceId: string;
  jobId: string | null;
  status: ImportStatus;
  fileCount: number;
  archive: boolean;
  createdAt: string;
  completedAt: string | null;
  messages: number | null;
  failed: number | null;
  /** Live counters while the import runs; null otherwise. */
  live: ImportLiveDto | null;
}

export interface ImportActorDto {
  userId: string | null;
  name: string | null;
  email: string | null;
}

export interface ImportDetailDto extends ImportSummaryDto {
  files: {
    origin: MailImportRequestFile["origin"];
    kind: MailImportRequestFile["kind"];
    path: string;
    size: number;
    format: string | null;
  }[];
  startedAt: string | null;
  errorMessage: string | null;
  /** The classified cause of a failed import (features/failures), for a translated explanation; null without one. */
  failure: FailureDto | null;
  actor: ImportActorDto;
  progress: ImportProgressDto | null;
  /** starting, prepare, import, manifest or archive while the import runs; null otherwise. */
  phase: string | null;
  /** The final report, whenever the worker stored one (also for an import that found nothing readable). */
  report: mailfiles.ImportReport | null;
  failures: ImportFailureDto[];
}

export interface ImportCreatedDto {
  id: string;
  jobId: string;
  objectId: string;
  sourceId: string;
}

export interface ImportRow {
  mailImport: MailImport;
  job: Job | null;
  progress: JobProgress | null;
  actorName: string | null;
  actorEmail: string | null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The report the worker stored, when it is the version this API understands.
 * It is shown as written; a malformed document yields null, never a broken response.
 */
export function reportOf(value: Record<string, unknown> | null): mailfiles.ImportReport | null {
  const report = record(value);
  if (!report || report.version !== 1 || record(report.totals) === null) {
    return null;
  }
  return report as unknown as mailfiles.ImportReport;
}

/** The live counters the worker stored under `payload.importLive`, if well-formed. */
export function importLiveOf(payload: Record<string, unknown> | null): ImportLiveDto | null {
  const live = record(payload?.importLive);
  if (!live) {
    return null;
  }
  const messages = count(live.messages);
  const duplicates = count(live.duplicates);
  const skipped = count(live.skipped);
  const failed = count(live.failed);
  const filesDone = count(live.unitsDone);
  const filesTotal = count(live.unitsTotal);
  if (
    messages === null ||
    duplicates === null ||
    skipped === null ||
    failed === null ||
    filesDone === null ||
    filesTotal === null
  ) {
    return null;
  }
  return { messages, duplicates, skipped, failed, filesDone, filesTotal };
}

/**
 * How many messages were stored and how many items failed: from the report
 * once the import finished, else from the live counters, else (failures only)
 * from the progress row, else unknown. The progress row counts source bytes,
 * so it cannot tell the messages.
 */
export function outcomeCounts(
  report: mailfiles.ImportReport | null,
  live: ImportLiveDto | null,
  progress: Pick<JobProgress, "failed"> | null,
): { messages: number | null; failed: number | null } {
  if (report) {
    const totals = record(report.totals);
    return { messages: count(totals?.messages), failed: count(totals?.failed) };
  }
  if (live) {
    return { messages: live.messages, failed: live.failed };
  }
  if (progress) {
    return { messages: null, failed: progress.failed };
  }
  return { messages: null, failed: null };
}

export function toSummaryDto(row: ImportRow): ImportSummaryDto {
  const report = reportOf(row.mailImport.report);
  const status = row.job?.status ?? "unknown";
  const live = importLiveOf(row.job?.payload ?? null);
  const { messages, failed } = outcomeCounts(report, live, row.progress);
  return {
    id: row.mailImport.id,
    name: row.mailImport.name,
    objectId: row.mailImport.protectedObjectId,
    sourceId: row.mailImport.sourceId,
    jobId: row.mailImport.jobId,
    status,
    fileCount: row.mailImport.files.length,
    archive: row.mailImport.options?.archive === true,
    createdAt: row.mailImport.createdAt.toISOString(),
    completedAt: iso(row.job?.completedAt),
    messages,
    failed,
    live: status === "active" ? live : null,
  };
}

/**
 * `tenantSlug` turns the stored server-folder paths (relative to IMPORT_DIR, with the tenant's
 * `<slug>/` prefix) back into the tenant-relative form the folder browser uses.
 */
export function toDetailDto(
  row: ImportRow,
  failures: ImportFailureDto[],
  tenantSlug: string,
): ImportDetailDto {
  const status = row.job?.status ?? "unknown";
  return {
    ...toSummaryDto(row),
    // The last counters stay meaningful after the run, so the detail keeps them.
    live: importLiveOf(row.job?.payload ?? null),
    files: row.mailImport.files.map((file) => ({
      origin: file.origin,
      kind: file.kind,
      path: file.origin === "folder" ? tenantRelativeFolderPath(tenantSlug, file.path) : file.path,
      size: file.size,
      format: file.format,
    })),
    startedAt: iso(row.job?.startedAt),
    errorMessage: row.job?.errorMessage ?? null,
    failure: failureDto(row.job?.failure ?? null),
    actor: {
      userId: row.mailImport.createdBy,
      name: row.actorName,
      email: row.actorEmail,
    },
    progress: row.progress
      ? {
          total: row.progress.total,
          done: row.progress.done,
          failed: row.progress.failed,
          bytes: row.progress.bytes,
          etaSeconds: row.progress.etaSeconds,
        }
      : null,
    // A finished import has no phase; a stale one must not linger.
    phase: status === "active" ? (runtimePhaseOf(row.job?.payload ?? null)?.name ?? null) : null,
    report: reportOf(row.mailImport.report),
    failures,
  };
}
