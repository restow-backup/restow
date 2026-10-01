/**
 * Contracts of the mail export writers (docs/IMPORT.md).
 *
 * The writers take an ordered sequence of {@link ExportMessage}s and produce
 * one byte stream (a ZIP of EML files, a ZIP of MBOX files, or a single
 * MBOX) together with a summary promise. Everything is streamed: one message
 * is in flight at a time, so memory stays bounded by the largest single
 * message or by a few buffers.
 */
import type { Readable } from "node:stream";

export interface ExportMessage {
  /** Folder components below the export root, outermost first. */
  readonly folder: readonly string[];
  readonly date: Date | null;
  /** Size of the RFC 5322 bytes as stored; informative only, the manifest records the streamed size. */
  readonly size: number;
  readonly messageId: string | null;
  readonly subject: string | null;
  readonly from: string | null;
  readonly to: string | null;
  /** Expected SHA-256 (hex) of the bytes `open` yields; the writer verifies it while streaming. */
  readonly sha256?: string;
  /**
   * The RFC 5322 bytes. An error before the first byte (the message cannot be
   * opened, its chunks are missing) marks just this message as failed; an error
   * later, once bytes are in the archive, aborts the whole export.
   */
  open(): Readable;
}

export type ExportEntryStatus = "added" | "missing" | "failed";

export interface ExportEntry {
  /**
   * Entry name inside the ZIP (the name that was planned for a message that
   * failed), or `<mbox file>#<n>` / `#<n>` for a message of an MBOX.
   */
  readonly name: string;
  readonly status: ExportEntryStatus;
  /** SHA-256 (hex) of the bytes written for this entry; null when nothing was written. */
  readonly sha256: string | null;
  readonly bytes: number;
  readonly note?: string;
}

export interface ExportSummary {
  /** One entry per message, in the order the messages were given. */
  readonly entries: readonly ExportEntry[];
  /** Messages written. */
  readonly messages: number;
  /** Messages that could not be written (status `failed` or `missing`). */
  readonly failed: number;
  /** Sum of `bytes` of the written entries. */
  readonly bytes: number;
}

export interface ExportOptions {
  /** Aborts the export; `completed` rejects with a `JobAbortedError`. */
  readonly signal?: AbortSignal;
  /** ZIP comment (ZIP writers only). */
  readonly comment?: string;
  /** Deflate level 0-9 (ZIP writers only, default 6). */
  readonly level?: number;
  /** Folders to keep in the export even when no message is in them. */
  readonly extraFolders?: readonly (readonly string[])[];
  /** Called after every message, in order, including failed ones. */
  readonly onEntry?: (entry: ExportEntry) => void;
  /** Clock for the timestamps of MANIFEST.csv and SHA256SUMS inside a ZIP (default `new Date()`). */
  readonly now?: () => Date;
}

/** What every writer returns: the bytes to pipe wherever they go, and the outcome. */
export interface ExportResult {
  readonly stream: Readable;
  /** Resolves once the last byte has been produced; rejects if the export had to be aborted. */
  readonly completed: Promise<ExportSummary>;
}
