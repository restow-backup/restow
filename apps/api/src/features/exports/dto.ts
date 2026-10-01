import type { mailfiles } from "@restow/core";
import type {
  ExportFormat,
  ExportOrigin,
  Job,
  JobProgress,
  MailExport,
  ProtectedObject,
} from "@restow/db";
import { runtimePhaseOf } from "../jobs/dto.js";
import { parseStoredSelection } from "../restore/selection.js";

/**
 * Response shapes of the mail export API and the pure mapping from rows to
 * them (docs/IMPORT.md). The worker leaves three things behind that are read
 * here defensively, because the columns are free-form jsonb and older or newer
 * rows must never break a response: the finished file (`file_name`,
 * `file_size`, `sha256`, `expires_at`), the `report` and the job's `payload`.
 */

export type ExportStatus = Job["status"] | "unknown";

export interface ExportObjectDto {
  id: string;
  kind: ProtectedObject["kind"];
  externalId: string;
  displayName: string | null;
}

export interface ExportProgressDto {
  total: number;
  done: number;
  failed: number;
  bytes: number;
  etaSeconds: number | null;
}

export interface ExportDto {
  id: string;
  jobId: string | null;
  origin: ExportOrigin;
  format: ExportFormat;
  status: ExportStatus;
  object: ExportObjectDto | null;
  snapshotId: string | null;
  /**
   * What was asked for; a count is null when the request selected everything or the size is
   * unknown. `capped` is set when an archive search matched more items than were counted, so
   * `items` reads "at least".
   */
  selection: { items: number | null; folders: number | null; capped?: true };
  fileName: string | null;
  fileSize: number | null;
  sha256: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  /** Completed, not expired and not purged: the file can be downloaded now. */
  available: boolean;
  progress: ExportProgressDto | null;
  /** The engine phase, only while the export runs. */
  phase: string | null;
  actor: { userId: string | null; name: string | null; email: string | null };
  impersonated: boolean;
}

export interface ExportReportDto {
  messages: number;
  folders: number;
  bytes: number;
  failed: number;
  skipped: { calendar: number; contacts: number; other: number };
  items: { ref: string; reason: string }[];
}

export interface ExportFailureDto {
  itemRef: string;
  reason: string;
  attempts: number;
}

export interface ExportDetailDto extends ExportDto {
  reason: string | null;
  errorMessage: string | null;
  report: ExportReportDto | null;
  failures: ExportFailureDto[];
}

export interface ExportCreatedDto {
  id: string;
  jobId: string;
  status: "queued";
}

export interface ExportFormatDto {
  id: mailfiles.ExportFormatId;
  available: boolean;
  planned?: boolean;
  reason?: string;
}

/** The `mail_exports` row with everything the DTO needs from its neighbours. */
export interface ExportRow {
  export: MailExport;
  job: Job | null;
  progress: JobProgress | null;
  object: ProtectedObject | null;
  ownerEmail: string | null;
  actorName: string | null;
  actorEmail: string | null;
}

/** The most report items a response carries. */
export const MAX_REPORT_ITEMS = 500;

const HOUR_MS = 60 * 60 * 1000;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The formats as the API lists them (core's `EXPORT_FORMATS`, optional keys omitted when unset). */
export function toFormatDtos(formats: readonly mailfiles.ExportFormatInfo[]): ExportFormatDto[] {
  return formats.map((format) => ({
    id: format.id,
    available: format.available,
    ...(format.planned ? { planned: true } : {}),
    ...(format.reason ? { reason: format.reason } : {}),
  }));
}

/** Content type of an export file when the worker did not record one. */
export function fallbackContentType(format: ExportFormat): string {
  switch (format) {
    case "mbox":
      return "application/mbox";
    case "eml_zip":
    case "msg_zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

export interface ExportAvailability {
  available: boolean;
  /** The file is gone or past its time: the download answers 410. */
  expired: boolean;
  expiresAt: Date | null;
}

/**
 * Whether a finished export can still be fetched. The worker sets `expires_at`
 * when the file is complete; a completed export without one (the worker has not
 * written it yet, or an older row) falls back to completion time plus the
 * configured lifetime. A purged file is expired whatever its date says.
 */
export function exportAvailability(
  input: {
    status: ExportStatus;
    completedAt: Date | null;
    expiresAt: Date | null;
    purgedAt: Date | null;
  },
  now: Date,
  ttlHours: number,
): ExportAvailability {
  if (input.status !== "completed") {
    return { available: false, expired: false, expiresAt: input.expiresAt };
  }
  const expiresAt =
    input.expiresAt ??
    (input.completedAt ? new Date(input.completedAt.getTime() + ttlHours * HOUR_MS) : null);
  const expired = input.purgedAt !== null || (expiresAt !== null && expiresAt <= now);
  return { available: !expired, expired, expiresAt };
}

/** True when segments 0 to expected-1 are all among the indexes found in storage. */
export function hasEverySegment(found: readonly number[], expected: number): boolean {
  const present = new Set(found);
  for (let index = 0; index < expected; index++) {
    if (!present.has(index)) {
      return false;
    }
  }
  return true;
}

/** What a stored selection asks for, in the counts the list shows. */
export function selectionCounts(
  origin: ExportOrigin,
  stored: Record<string, unknown> | null,
): { items: number | null; folders: number | null; capped?: true } {
  const selection = record(stored);
  if (origin === "archive") {
    if (Array.isArray(selection?.itemIds)) {
      return { items: selection.itemIds.length, folders: null };
    }
    const matched = selection?.matched;
    return {
      items: typeof matched === "number" && Number.isFinite(matched) ? matched : null,
      folders: null,
      ...(selection?.capped === true ? { capped: true as const } : {}),
    };
  }
  const parsed = parseStoredSelection(selection);
  if (parsed.all) {
    return { items: null, folders: null };
  }
  return {
    items: (parsed.paths?.length ?? 0) + (parsed.objectIds?.length ?? 0),
    folders: parsed.folderPaths?.length ?? 0,
  };
}

/** The report the worker stored, or null while the export has none. */
export function reportFromJson(value: unknown): ExportReportDto | null {
  const report = record(value);
  if (!report) {
    return null;
  }
  const skipped = record(report.skipped);
  const items = Array.isArray(report.items) ? report.items : [];
  return {
    messages: count(report.messages),
    folders: count(report.folders),
    bytes: count(report.bytes),
    failed: count(report.failed),
    skipped: {
      calendar: count(skipped?.calendar),
      contacts: count(skipped?.contacts),
      other: count(skipped?.other),
    },
    items: items
      .map((item) => {
        const entry = record(item);
        const ref = text(entry?.ref);
        const reason = text(entry?.reason);
        return ref && reason ? { ref, reason } : null;
      })
      .filter((item): item is { ref: string; reason: string } => item !== null)
      .slice(0, MAX_REPORT_ITEMS),
  };
}

export function toExportDto(row: ExportRow, now: Date, ttlHours: number): ExportDto {
  const status: ExportStatus = row.job?.status ?? "unknown";
  const completedAt = row.job?.completedAt ?? null;
  const availability = exportAvailability(
    {
      status,
      completedAt,
      expiresAt: row.export.expiresAt,
      purgedAt: row.export.purgedAt,
    },
    now,
    ttlHours,
  );
  return {
    id: row.export.id,
    jobId: row.export.jobId,
    origin: row.export.origin,
    format: row.export.format,
    status,
    object: row.object
      ? {
          id: row.object.id,
          kind: row.object.kind,
          externalId: row.object.externalId,
          displayName: row.object.displayName,
        }
      : null,
    snapshotId: row.export.snapshotId,
    selection: selectionCounts(row.export.origin, row.export.selection),
    fileName: row.export.fileName,
    fileSize: row.export.fileSize,
    sha256: row.export.sha256,
    createdAt: row.export.createdAt.toISOString(),
    completedAt: iso(completedAt),
    expiresAt: iso(availability.expiresAt),
    available: availability.available,
    progress: row.progress
      ? {
          total: row.progress.total,
          done: row.progress.done,
          failed: row.progress.failed,
          bytes: row.progress.bytes,
          etaSeconds: row.progress.etaSeconds,
        }
      : null,
    // Only a running export has a phase; a stale one must not linger.
    phase: status === "active" ? (runtimePhaseOf(row.job?.payload ?? null)?.name ?? null) : null,
    actor: {
      userId: row.export.actorUserId,
      name: row.actorName,
      email: row.actorEmail,
    },
    impersonated: row.export.impersonated,
  };
}
