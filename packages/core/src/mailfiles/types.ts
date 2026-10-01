/**
 * Shared contracts of the mail file import and export (docs/IMPORT.md).
 *
 * Import turns files a person brings along (EML, MSG, MBOX, ZIP archives and
 * folder trees such as MailStore exports) into a snapshot of an "imported
 * mailbox" in the same manifest format the IMAP backup writes (mail/<folder>/
 * <uid>.eml plus folder objects), so restore, preview, download and the archive
 * treat it like any other mailbox. Export turns messages back into EML in a
 * ZIP or MBOX.
 *
 * PST and OST files are recognised by content and refused: their import is
 * planned for a later release.
 */
import type { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

/**
 * What a file turned out to be, judged by its bytes and never by its name.
 * `pst` covers PST and OST (both are recognised, neither is imported).
 */
export type MailFileFormat = "eml" | "msg" | "mbox" | "zip" | "pst" | "unknown";

export interface MailFormatDetection {
  readonly format: MailFileFormat;
  /** Short English note for the report, e.g. "OLE compound file that is not an Outlook message". */
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * One file offered to the import: an upload from the encrypted staging area or
 * a file of the server-side import folder. Nothing here loads a file whole:
 * `open` streams it, `read` serves ZIP central directories and format sniffing.
 */
export interface MailInputFile {
  /**
   * '/'-separated path shown to the user and used as the folder prefix of
   * everything found in the file ("Archive/2019/inbox.mbox"). No leading slash,
   * no ".." segments.
   */
  readonly path: string;
  readonly size: number;
  /** A fresh sequential stream over the whole file. */
  open(): Readable;
  /** Up to `length` bytes at `offset` (fewer at the end of the file). */
  read(offset: number, length: number): Promise<Buffer>;
}

/** Hard limits that keep a hostile or damaged file from exhausting the worker. */
export interface MailFileLimits {
  /** Largest single message (EML, MSG or one MBOX message) that is read into memory. */
  readonly maxMessageBytes: number;
  /** Most entries a ZIP may hold. */
  readonly maxZipEntries: number;
  /** Most bytes all entries of one ZIP may expand to. */
  readonly maxZipExpandedBytes: number;
  /** Largest allowed ratio of expanded to compressed bytes of one ZIP entry (zip bomb guard). */
  readonly maxZipRatio: number;
}

export const DEFAULT_MAIL_FILE_LIMITS: MailFileLimits = {
  maxMessageBytes: 256 * 1024 * 1024,
  maxZipEntries: 2_000_000,
  maxZipExpandedBytes: 256 * 1024 * 1024 * 1024,
  maxZipRatio: 1000,
};

// ---------------------------------------------------------------------------
// Walking a file: what the readers produce
// ---------------------------------------------------------------------------

/** Machine-readable reason for an item that did not become a stored message. */
export type MailProblemCode =
  /** Damaged or not parseable although it looked like the format. */
  | "unreadable"
  /** A recognised container or format Restow does not read (nested archive, encrypted ZIP). */
  | "unsupported"
  /** A file that is not a mail message at all (index file, image, Outlook contact or appointment). */
  | "not_mail"
  /** PST or OST: planned for a later release. */
  | "pst_not_supported"
  /** Bigger than the per-message limit. */
  | "too_large"
  /** No content (zero bytes, or a MBOX message without any header). */
  | "empty"
  /** A ZIP guard fired (entry count, expanded size, ratio). */
  | "limit";

export interface MailWalkProblem {
  readonly type: "problem";
  /** Stable reference for the report: "inbox.mbox#17", "export.zip!Inbox/a.eml". */
  readonly ref: string;
  /** 0-based position among the items of the top-level file (messages and problems). */
  readonly index: number;
  readonly code: MailProblemCode;
  /** English, no secrets; shown in the import report. */
  readonly reason: string;
  readonly format?: MailFileFormat;
}

/** A folder to create even when it stays empty (directories of a ZIP or tree). */
export interface MailWalkFolder {
  readonly type: "folder";
  readonly path: readonly string[];
}

export interface MailWalkMessage {
  readonly type: "message";
  readonly ref: string;
  readonly index: number;
  /** Folder components below the import root, outermost first (unescaped names). */
  readonly folder: readonly string[];
  /** Base name of the item in its source ("a.eml", "Inbox.mbox#3"), for naming and reports. */
  readonly sourceName: string;
  readonly format: "eml" | "msg" | "mbox";
  /** The RFC 5322 bytes to store: verbatim for EML and MBOX, reconstructed for MSG. */
  readonly raw: Buffer;
  /** True when `raw` was rebuilt from a format that does not hold RFC 5322 bytes (MSG). */
  readonly synthesized: boolean;
  /** IMAP-style flags derived from the source ("\\Seen", "\\Flagged", "\\Answered", "\\Draft"). */
  readonly flags: readonly string[];
  /** When the message was received or sent according to the source, if it says. */
  readonly internalDate: Date | null;
  /** Source bytes consumed by this item, for progress. */
  readonly sourceBytes: number;
}

export type MailWalkEvent = MailWalkFolder | MailWalkMessage | MailWalkProblem;

export interface WalkOptions {
  readonly limits?: Partial<MailFileLimits>;
  /**
   * Resume support: skip the first `skipItems` items (messages and problems,
   * not folders) of the file without parsing them. The numbering is
   * deterministic, so skipping n items and continuing yields exactly the events
   * a full pass yields after item n.
   */
  readonly skipItems?: number;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Message metadata (for the manifest and the archive)
// ---------------------------------------------------------------------------

/** Metadata derived from the RFC 5322 bytes; mirrors the IMAP envelope contract. */
export interface MessageMeta {
  readonly messageId: string | null;
  readonly subject: string;
  /** 'Display Name <address>' or the bare address; null when there is no From. */
  readonly from: string | null;
  readonly to: readonly string[];
  readonly toCount: number;
  readonly cc: readonly string[];
  readonly ccCount: number;
  readonly hasAttachments: boolean;
  readonly attachmentCount: number;
  /** The Date header, if present and valid. */
  readonly sentAt: Date | null;
  /** "smime-encrypted" or "rights-protected" when the body cannot be read without a key. */
  readonly protection: "rights-protected" | "smime-encrypted" | null;
  /** Plain text of the body for the archive search, cut at 200,000 characters. */
  readonly bodyText: string;
  /**
   * True when the metadata could not be read (the parser failed, ran out of time or out of
   * memory): the fields above are empty, the message itself is stored as it is.
   */
  readonly unavailable?: boolean;
}

// ---------------------------------------------------------------------------
// Import report
// ---------------------------------------------------------------------------

/** What happened to one item that was not stored as a message. */
export type ImportItemOutcome = "failed" | "skipped";

/** Why an item was skipped although it is not damaged. */
export type ImportSkipCode = MailProblemCode | "duplicate";

export interface ImportReportItem {
  /** Reference inside the file ("Inbox.mbox#17"). */
  readonly ref: string;
  readonly file: string;
  readonly outcome: ImportItemOutcome;
  readonly code: ImportSkipCode;
  readonly reason: string;
}

export type ImportFileStatus = "imported" | "partial" | "failed" | "refused";

export interface ImportFileReport {
  readonly path: string;
  readonly size: number;
  /** "directory" for a selected folder tree (MailStore export and the like). */
  readonly format: MailFileFormat | "directory";
  /** SHA-256 (hex) of the file's bytes, computed while it was read; null when it was never read. */
  readonly sha256: string | null;
  readonly status: ImportFileStatus;
  readonly messages: number;
  readonly folders: number;
  readonly attachments: number;
  readonly duplicates: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface ImportArchiveReport {
  readonly requested: boolean;
  readonly ingested: number;
  /** Messages that were in the archive from an earlier import already. */
  readonly alreadyArchived: number;
  readonly failed: number;
}

export interface ImportTotals {
  readonly files: number;
  readonly messages: number;
  readonly folders: number;
  readonly attachments: number;
  readonly duplicates: number;
  readonly skipped: number;
  readonly failed: number;
  /** Plaintext bytes of the stored messages. */
  readonly messageBytes: number;
  /** Bytes read from the source files. */
  readonly sourceBytes: number;
  /** Messages whose RFC 5322 form was rebuilt from MSG. */
  readonly synthesizedMessages: number;
}

/** The final report of an import job, stored on the job and shown on the import page. */
export interface ImportReport {
  readonly version: 1;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly snapshotId: string | null;
  readonly totals: ImportTotals;
  readonly files: readonly ImportFileReport[];
  /** Failed items first, then skipped ones, capped at {@link MAX_REPORT_ITEMS}. */
  readonly items: readonly ImportReportItem[];
  /** How many items exist beyond the ones listed. */
  readonly itemsOmitted: number;
  readonly archive: ImportArchiveReport | null;
  /** Fixed, English notes on known limits ("calendar_contacts_not_imported", ...). */
  readonly notes: readonly string[];
}

export const MAX_REPORT_ITEMS = 1000;
