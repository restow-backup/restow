/**
 * How the export writers classify what goes wrong with one message.
 *
 * A message that cannot be opened is listed as failed (or missing) and the
 * export goes on. Bytes that do not match their recorded hash, and every
 * cancellation, end the whole export: a silently corrupt export is worse than
 * none, and half an archive is not what anybody asked for.
 */
import {
  JobAbortedError,
  MissingChunkError,
  RestoreIntegrityError,
} from "../../engine/chunkstore.js";
import { describeRestoreError, failureCodeOf, isAbortError } from "../../restore/results.js";
import type { ExportEntryStatus } from "./types.js";

export { JobAbortedError };

/** The bytes of a message do not match the SHA-256 the caller recorded. */
export class ExportIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportIntegrityError";
  }
}

/** True for errors that must end the export instead of marking one message as failed. */
export function isFatalExportError(error: unknown): boolean {
  return (
    isAbortError(error) ||
    error instanceof ExportIntegrityError ||
    error instanceof RestoreIntegrityError ||
    failureCodeOf(error) === "integrity"
  );
}

/** Status of a message whose error is not fatal: `missing` when its data is gone, else `failed`. */
export function statusOfError(error: unknown): ExportEntryStatus {
  return error instanceof MissingChunkError || failureCodeOf(error) === "data_missing"
    ? "missing"
    : "failed";
}

/**
 * A note for the manifest and the report: one line, no dashes used as
 * punctuation (the project writes none in user-visible text).
 */
export function plainNote(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s[\u{2013}\u{2014}]\s/gu, ", ")
    .replace(/[\u{2013}\u{2014}]/gu, "-")
    .trim();
}

/** The manifest note for a thrown value. */
export function describeExportError(error: unknown): string {
  return plainNote(describeRestoreError(error));
}
