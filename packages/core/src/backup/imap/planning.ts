/**
 * Pure planning helpers of the IMAP engine: which folders to visit in which
 * order, whether a folder is read incrementally or from scratch, which UIDs
 * to download, and how to group downloads into bounded FETCH batches.
 */
import type {
  ImapEngineState,
  ImapFolderInfo,
  ImapFolderState,
  ImapFolderStatus,
  ImapMessageMeta,
} from "./types.js";

export type FolderMode = "full" | "incremental";

export type FolderPlanReason =
  | "first_backup"
  | "full_requested"
  | "uidvalidity_changed"
  | "incremental";

export interface FolderPlan {
  readonly mode: FolderMode;
  readonly reason: FolderPlanReason;
}

/**
 * Incremental only when the folder was seen before under the same UIDVALIDITY
 * (docs/IMAP.md). A changed UIDVALIDITY invalidates every UID we know, so the
 * folder is re-read in full; storage stays flat because a message matching a
 * stored one by Message-ID and hash reuses its chunks (./dedup.ts), and any
 * other identical bytes still yield identical chunk ids.
 */
export function planFolder(
  previous: ImapFolderState | undefined,
  status: ImapFolderStatus,
  options: { readonly full?: boolean } = {},
): FolderPlan {
  if (options.full) {
    return { mode: "full", reason: "full_requested" };
  }
  if (!previous) {
    return { mode: "full", reason: "first_backup" };
  }
  if (previous.uidValidity !== status.uidValidity) {
    return { mode: "full", reason: "uidvalidity_changed" };
  }
  return { mode: "incremental", reason: "incremental" };
}

/**
 * UIDs to download, ascending. Incremental runs download what the previous
 * snapshot does not hold (the set difference also retries items that failed
 * last time); full runs download everything. `resumeAfterUid` skips what a
 * checkpointed earlier attempt of this very run already stored.
 */
export function selectUidsToFetch(
  mode: FolderMode,
  currentUids: Iterable<number>,
  knownUids: ReadonlySet<number>,
  resumeAfterUid = 0,
): number[] {
  const selected: number[] = [];
  for (const uid of currentUids) {
    if (uid <= resumeAfterUid) {
      continue;
    }
    if (mode === "incremental" && knownUids.has(uid)) {
      continue;
    }
    selected.push(uid);
  }
  return selected.sort((a, b) => a - b);
}

export interface FetchBreakdown {
  /** UIDs at or above the previous UIDNEXT: delivered since the last run. */
  readonly arrived: number;
  /** UIDs below it that the previous snapshot lacks (failed or omitted last time). */
  readonly retried: number;
}

/** Split an incremental download list by the UIDNEXT the previous run saw. */
export function breakdownByUidNext(
  uids: readonly number[],
  previousUidNext: number,
): FetchBreakdown {
  let arrived = 0;
  for (const uid of uids) {
    if (uid >= previousUidNext) {
      arrived++;
    }
  }
  return { arrived, retried: uids.length - arrived };
}

export interface BatchLimits {
  readonly maxBytes: number;
  readonly maxMessages: number;
}

/** Bounded FETCH batches, in the given order. A message larger than `maxBytes` gets a batch of its own. */
export function batchBySize(
  messages: readonly Pick<ImapMessageMeta, "uid" | "size">[],
  limits: BatchLimits,
): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let currentBytes = 0;
  for (const message of messages) {
    const size = Math.max(0, message.size);
    const wouldOverflow =
      current.length > 0 &&
      (current.length >= limits.maxMessages || currentBytes + size > limits.maxBytes);
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(message.uid);
    currentBytes += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/** Selectable folders, INBOX first, then by path; containers (`\Noselect`) are skipped. */
export function orderFolders(folders: readonly ImapFolderInfo[]): ImapFolderInfo[] {
  const selectable = folders.filter((folder) => folder.selectable);
  return selectable.sort((a, b) => {
    const aInbox = isInbox(a) ? 0 : 1;
    const bInbox = isInbox(b) ? 0 : 1;
    if (aInbox !== bInbox) {
      return aInbox - bInbox;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

export function isInbox(folder: ImapFolderInfo): boolean {
  return folder.specialUse === "\\Inbox" || folder.path.toUpperCase() === "INBOX";
}

/** Type-safe read of the engine state a previous manifest carried; anything malformed counts as "no state". */
export function readImapState(state: Record<string, unknown> | undefined): ImapEngineState {
  const empty: ImapEngineState = { imap: { version: 1, folders: {} } };
  const imap = state?.imap;
  if (!imap || typeof imap !== "object") {
    return empty;
  }
  const folders = (imap as { folders?: unknown }).folders;
  if (!folders || typeof folders !== "object") {
    return empty;
  }
  const clean: Record<string, ImapFolderState> = {};
  for (const [path, value] of Object.entries(folders as Record<string, unknown>)) {
    if (isFolderState(value)) {
      clean[path] = value;
    }
  }
  return { imap: { version: 1, folders: clean } };
}

function isFolderState(value: unknown): value is ImapFolderState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.uidValidity === "string" &&
    typeof candidate.uidNext === "number" &&
    typeof candidate.delimiter === "string" &&
    typeof candidate.messages === "number"
  );
}
