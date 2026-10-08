/**
 * Reading an archived message's original bytes from the chunk store, for the
 * archive's reading pane, the `.eml` download and the content sample of the
 * chain check. The read goes through the chunk store's integrity-checked
 * path: every chunk is checked against its id, and the whole message against
 * the size and SHA-256 recorded at capture (`item_hash`), so bytes that come
 * back are the bytes that were archived.
 */
import { type ChunkReader, type ManifestObject, RestoreIntegrityError } from "@restow/core";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { openContentReader } from "../snapshots/content.js";

/** The `archive_items` fields a content read needs. */
export interface ArchiveContentRow {
  readonly id: string;
  readonly itemHash: string;
  readonly sizeBytes: number | null;
  readonly chunks: readonly string[] | null;
  readonly receivedAt: Date;
}

/** Why an item's content could not be checked or read. */
export type ArchiveContentProblem =
  /** The row predates the recorded chunk list or size: there is nothing to read it by. */
  | "not_recorded"
  /** The bytes were read but do not match the recorded size or SHA-256 (or a chunk its id). */
  | "mismatch"
  /** Storage did not deliver the content (missing pack, unreachable target, key). */
  | "unreadable";

export class ArchiveContentError extends Error {
  readonly problem: ArchiveContentProblem;

  constructor(problem: ArchiveContentProblem, cause?: unknown) {
    super(`archived content ${problem}`, cause === undefined ? undefined : { cause });
    this.name = "ArchiveContentError";
    this.problem = problem;
  }
}

/** The row as the manifest object the chunk reader reconstructs; null when it cannot be read. */
export function archiveContentObject(row: ArchiveContentRow): ManifestObject | null {
  if (row.sizeBytes === null || row.chunks === null) {
    return null;
  }
  return {
    path: row.id,
    size: row.sizeBytes,
    mtime: row.receivedAt.getTime(),
    id: row.id,
    type: "archive-item",
    sha256: row.itemHash,
    chunks: [...row.chunks],
  };
}

/** Classify a failed read: a verified mismatch, or content storage did not deliver. */
export function contentProblemOf(error: unknown): ArchiveContentProblem {
  if (error instanceof ArchiveContentError) {
    return error.problem;
  }
  return error instanceof RestoreIntegrityError ? "mismatch" : "unreadable";
}

/** Read one item's original bytes with an already opened reader; throws {@link ArchiveContentError}. */
export async function readArchiveContent(
  reader: ChunkReader,
  row: ArchiveContentRow,
): Promise<Buffer> {
  const object = archiveContentObject(row);
  if (!object) {
    throw new ArchiveContentError("not_recorded");
  }
  try {
    return await reader.readObjectToBuffer(object);
  } catch (error) {
    throw new ArchiveContentError(contentProblemOf(error), error);
  }
}

/** Read one item's original bytes; opens the tenant's reader for this one read. */
export async function readArchiveItemBytes(
  db: DbExecutor,
  tenantId: string,
  row: ArchiveContentRow,
): Promise<Buffer> {
  if (!archiveContentObject(row)) {
    throw new ArchiveContentError("not_recorded");
  }
  const reader = await openContentReader(db, tenantId);
  return readArchiveContent(reader, row);
}

/** A file name for the `.eml` download: the subject, cleaned, or the item id. */
export function emlFileName(subject: string | null, itemId: string): string {
  const cleaned = Array.from(subject ?? "", (char) => (char.charCodeAt(0) < 32 ? " " : char))
    .join("")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${cleaned || itemId}.eml`;
}
