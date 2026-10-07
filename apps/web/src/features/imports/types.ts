import type { Failure } from "@/features/failures";

/**
 * Contract types of `/api/v1/imports` (apps/api/src/features/imports) and of
 * the import report (packages/core/src/mailfiles/types.ts). Kept in sync by
 * hand; the API is the source of truth. The web app never imports the core
 * package, so the report shape is mirrored here.
 */

/** What a file turned out to be, judged by its bytes and never by its name. */
export type MailFileFormat = "eml" | "msg" | "mbox" | "zip" | "pst" | "unknown";

export type ImportStatus = "queued" | "active" | "completed" | "failed" | "cancelled" | "unknown";

export interface ImportConfig {
  uploadEnabled: boolean;
  maxFileBytes: number;
  segmentSize: number;
  uploadExpiresHours: number;
  folder: { enabled: boolean; path: string };
  supportedFormats: MailFileFormat[];
  refusedFormats: MailFileFormat[];
}

// --- Uploads ------------------------------------------------------------------

export type UploadServerStatus =
  | "uploading"
  | "ready"
  | "consumed"
  | "cancelled"
  | "expired"
  | (string & {});

export type UploadRefusalCode = "pst_not_supported" | "unrecognised";

export interface UploadRefusal {
  code: UploadRefusalCode;
  /** English text of the server; the web maps `code` to German and English. */
  message: string;
}

export interface ImportUploadDto {
  id: string;
  fileName: string;
  size: number;
  segmentSize: number;
  segmentCount: number;
  status: UploadServerStatus;
  receivedSegments: number[];
  detectedFormat: MailFileFormat | null;
  refusal: UploadRefusal | null;
  expiresAt: string;
}

export interface CreateUploadInput {
  fileName: string;
  size: number;
  segmentSize?: number;
}

export interface SegmentAck {
  index: number;
  size: number;
  sha256: string;
  receivedCount: number;
}

// --- Server folder --------------------------------------------------------------

export interface FolderEntry {
  name: string;
  /** Path relative to the import root ('/'-separated). */
  path: string;
  type: "file" | "directory";
  size: number | null;
  modifiedAt: string;
  format: MailFileFormat | null;
  supported: boolean;
}

export interface FolderListing {
  enabled: boolean;
  path: string;
  current: string;
  entries: FolderEntry[];
}

// --- Imports ------------------------------------------------------------------

export type ImportFileInput =
  | { origin: "upload"; uploadId: string }
  | { origin: "folder"; path: string };

/** Exactly one of `name` (a new imported mailbox) or `objectId` (an existing one). */
export interface CreateImportInput {
  name?: string;
  objectId?: string;
  files: ImportFileInput[];
  archive: boolean;
}

export interface ImportCreated {
  id: string;
  jobId: string;
  objectId: string;
  sourceId: string;
}

/** Counters the worker publishes about once a second while the import runs. */
export interface ImportLive {
  messages: number;
  duplicates: number;
  skipped: number;
  failed: number;
  filesDone: number;
  filesTotal: number;
  /** Messages handed to the archive so far, while the archive phase runs. */
  archiveDone?: number;
  archiveTotal?: number;
}

export interface ImportSummary {
  id: string;
  name: string;
  objectId: string;
  sourceId: string;
  jobId: string;
  status: ImportStatus;
  fileCount: number;
  archive: boolean;
  createdAt: string;
  completedAt: string | null;
  messages: number | null;
  failed: number | null;
  /** Present while the import runs. */
  live?: ImportLive | null;
}

export interface ImportSourceFile {
  origin: "upload" | "folder";
  kind: string;
  path: string;
  size: number;
  format: MailFileFormat | null;
}

/**
 * `total` and `done` are source bytes (done / total is the percentage),
 * `bytes` the plaintext bytes stored so far, `failed` the failed items.
 */
export interface ImportProgress {
  total: number;
  done: number;
  failed: number;
  bytes: number;
  etaSeconds: number | null;
}

export interface ImportLiveFailure {
  itemRef: string;
  reason: string;
  attempts: number;
}

// --- Report (mirrors packages/core/src/mailfiles/types.ts) ---------------------

export type ImportItemOutcome = "failed" | "skipped";

export type ImportSkipCode =
  | "unreadable"
  | "unsupported"
  | "not_mail"
  | "pst_not_supported"
  | "too_large"
  | "empty"
  | "limit"
  | "duplicate";

export interface ImportReportItem {
  ref: string;
  file: string;
  outcome: ImportItemOutcome;
  code: ImportSkipCode | (string & {});
  /** English, straight from the reader. */
  reason: string;
}

export type ImportFileStatus = "imported" | "partial" | "failed" | "refused";

export interface ImportFileReport {
  path: string;
  size: number;
  format: MailFileFormat;
  sha256: string | null;
  status: ImportFileStatus;
  messages: number;
  folders: number;
  attachments: number;
  duplicates: number;
  skipped: number;
  failed: number;
}

export interface ImportArchiveReport {
  requested: boolean;
  ingested: number;
  alreadyArchived: number;
  failed: number;
}

export interface ImportTotals {
  files: number;
  messages: number;
  folders: number;
  attachments: number;
  duplicates: number;
  skipped: number;
  failed: number;
  messageBytes: number;
  sourceBytes: number;
  synthesizedMessages: number;
}

export interface ImportReport {
  version: 1;
  startedAt: string;
  completedAt: string;
  snapshotId: string | null;
  totals: ImportTotals;
  files: ImportFileReport[];
  items: ImportReportItem[];
  itemsOmitted: number;
  archive: ImportArchiveReport | null;
  /** Codes of known limits ("calendar_contacts_not_imported", "msg_reconstructed", ...). */
  notes: string[];
}

export interface ImportDetail extends ImportSummary {
  files: ImportSourceFile[];
  startedAt: string | null;
  errorMessage: string | null;
  /** The classified cause of a failure, translated by FailureExplanation; null without one (older rows). */
  failure?: Failure | null;
  actor: { userId: string | null; name: string | null; email: string | null };
  progress: ImportProgress | null;
  phase: string | null;
  report: ImportReport | null;
  failures: ImportLiveFailure[];
}

/** The bit of `/snapshots/objects` the target step reads (imported mailboxes have `sourceKind: "import"`). */
export interface ObjectListEntry {
  id: string;
  displayName: string | null;
  externalId: string;
  sourceKind: string;
}
