/**
 * When two captures are the same mail (docs/ARCHIVE.md "Erfassungswege", 0.4.4).
 *
 * One mail can reach the archive several ways: Exchange journaling or a forwarded copy at
 * transport, Graph or IMAP from the mailbox, a file import. The archive is append-only, so
 * a second capture never changes the first; it either becomes no item at all (a capture
 * row on the existing item, when it is not stronger) or a new item that names the weaker
 * one it supersedes. This module is the pure part of that decision; ./append.ts applies it
 * under the tenant's chain lock.
 *
 * Identity: the normalized Message-ID ({@link messageKey}) plus either the exact bytes
 * (`itemHash`) or the body ({@link bodyHash}): a journal copy and the mailbox copy of one
 * mail differ in their headers (Received, X-MS-Exchange-*), not in the body. Without a
 * Message-ID only the exact bytes count. The same Message-ID with another body is not the
 * same mail: both are kept and the new one is flagged `message-id-conflict`.
 */
import { createHash } from "node:crypto";
import type { ArchiveSource } from "./types.js";

/**
 * How strong a capture way is as evidence: at transport (before any user could touch the
 * mail) 2, from the mailbox shortly after delivery 1, imported afterwards 0.
 */
export function captureRank(source: ArchiveSource): number {
  switch (source) {
    case "journal":
    case "smtp_forward":
      return 2;
    case "graph_sync":
    case "imap_sync":
      return 1;
    case "file_import":
      return 0;
    default:
      return 0;
  }
}

const KEY_TRIM = new Set(["<", ">", " "]);

/**
 * The Message-ID as the archive compares it: lowercase, without the angle brackets and
 * spaces around it. Exactly `lower(btrim(message_id, '<> '))` in Postgres (the expression
 * index on `archive_items`). Null for a missing or empty one.
 */
export function messageKey(messageId: string | null | undefined): string | null {
  if (!messageId) {
    return null;
  }
  let start = 0;
  let end = messageId.length;
  while (start < end && KEY_TRIM.has(messageId[start] as string)) {
    start++;
  }
  while (end > start && KEY_TRIM.has(messageId[end - 1] as string)) {
    end--;
  }
  const key = messageId.slice(start, end).toLowerCase();
  return key.length > 0 ? key : null;
}

/** Where the body starts: after the first empty line (CRLF CRLF or LF LF), else nothing. */
function bodyStart(bytes: Buffer): number {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0x0a) {
      continue;
    }
    if (bytes[i + 1] === 0x0a) {
      return i + 2;
    }
    if (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) {
      return i + 3;
    }
  }
  return bytes.length;
}

/**
 * SHA-256 (hex) of a message's body, stable across the transport differences two captures
 * of one mail show: the bytes after the first empty line, line ends normalized to CRLF,
 * spaces and tabs at the end of every line and empty lines at the end removed. Works on
 * bytes (latin1 maps them one to one), so no charset is ever guessed.
 */
export function bodyHash(original: Buffer): string {
  const body = original.subarray(bodyStart(original)).toString("latin1");
  const lines = body.split(/\r?\n/).map((line) => line.replace(/[ \t\r]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return createHash("sha256")
    .update(Buffer.from(lines.join("\r\n"), "latin1"))
    .digest("hex");
}

/** SHA-256 (hex) of the exact bytes, as the writer computes `itemHash`. */
export function itemHashOf(original: Buffer): string {
  return createHash("sha256").update(original).digest("hex");
}

/** What a new capture is, for the decision. */
export interface CaptureIdentity {
  readonly source: ArchiveSource;
  readonly itemHash: string;
  readonly bodyHash: string | null;
  readonly messageKey: string | null;
}

/** An archived item that may be the same mail (found by Message-ID or exact bytes). */
export interface ArchiveMatchCandidate {
  readonly id: string;
  readonly source: ArchiveSource;
  readonly itemHash: string;
  /** Null for items captured before 0.4.4. */
  readonly bodyHash: string | null;
  readonly messageKey: string | null;
}

/**
 * `merge`: a capture that is not stronger than the item it matches becomes a capture row
 * (no second item). `keep`: every capture becomes an item of its own, as before 0.4.4 for
 * journal reports and imports; a stronger one still names the weaker item it supersedes.
 */
export type DuplicatePolicy = "merge" | "keep";

export type DuplicateDecision =
  /** Write a new item; `supersedes` is the weaker match it replaces in search, if any. */
  | { readonly kind: "new"; readonly supersedes: string | null; readonly conflict: boolean }
  /** Record a capture of the existing item `of`; write nothing to the chain. */
  | { readonly kind: "duplicate"; readonly of: string };

/** Whether `candidate` is the same mail as the capture. */
export function sameMail(capture: CaptureIdentity, candidate: ArchiveMatchCandidate): boolean {
  if (candidate.itemHash === capture.itemHash) {
    return true;
  }
  return (
    capture.messageKey !== null &&
    candidate.messageKey === capture.messageKey &&
    capture.bodyHash !== null &&
    candidate.bodyHash === capture.bodyHash
  );
}

/**
 * Decide what a new capture becomes, given the candidates in append order (oldest
 * first). The strongest matching candidate counts (the oldest among equals); a capture
 * not stronger than it is a duplicate under `merge`, a stronger one supersedes it. A
 * candidate with the same Message-ID but neither the same bytes nor the same body is a
 * conflict: the capture is kept as an item of its own and flagged.
 */
export function decideDuplicate(
  capture: CaptureIdentity,
  candidates: readonly ArchiveMatchCandidate[],
  policy: DuplicatePolicy = "merge",
): DuplicateDecision {
  let strongest: ArchiveMatchCandidate | null = null;
  let conflict = false;
  for (const candidate of candidates) {
    if (sameMail(capture, candidate)) {
      if (strongest === null || captureRank(candidate.source) > captureRank(strongest.source)) {
        strongest = candidate;
      }
    } else if (capture.messageKey !== null && candidate.messageKey === capture.messageKey) {
      conflict = true;
    }
  }
  if (strongest === null) {
    return { kind: "new", supersedes: null, conflict };
  }
  if (captureRank(capture.source) > captureRank(strongest.source)) {
    return { kind: "new", supersedes: strongest.id, conflict: false };
  }
  if (policy === "keep") {
    return { kind: "new", supersedes: null, conflict: false };
  }
  return { kind: "duplicate", of: strongest.id };
}
