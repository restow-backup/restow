/**
 * Archive capture from an IMAP account (docs/IMAP.md "Archivierung", docs/ARCHIVE.md
 * "Erfassungswege", 0.4.4): the IMAP side of the worker's capture way
 * (apps/worker/src/archive-capture/imap.ts). Works on an {@link ImapSession} only, so the
 * same code runs against imapflow and the in-process fake (../backup/imap/testing).
 *
 * Which folders: every selectable folder, Sent, Trash and Junk included, Drafts excluded
 * (a draft is not mail anyone sent or received); a message flagged `\Draft` is skipped in
 * every folder. A Gmail account (Google Workspace, Gmail) shows every mail once more per
 * label: only `[Gmail]/All Mail`, Spam and Trash are read there, which hold every mail
 * exactly once.
 *
 * Per folder the state keeps UIDVALIDITY, the UIDNEXT last seen and `lastUid` (every UID up
 * to it is handled). A pass asks STATUS first and selects a folder only when UIDNEXT moved
 * past `lastUid`; then only the new UIDs are read, metadata first, and the source only of
 * mail the archive does not hold for this mailbox yet (by `<folder>;<uidvalidity>;<uid>` or
 * Message-ID). A changed UIDVALIDITY rescans the folder from the start: the mailbox's
 * Message-IDs keep that from archiving anything twice.
 *
 * Activation records where live capture starts (`backfillUpTo` per folder); the one-time
 * backfill takes over the UIDs up to it, checkpointed in its job's cursor.
 */
import { batchBySize, isInbox, orderFolders } from "../backup/imap/planning.js";
import {
  type ImapFolderInfo,
  type ImapMessageMeta,
  type ImapSession,
  isImapSessionError,
} from "../backup/imap/types.js";
import type { Logger } from "../engine/types.js";
import { classifyFailure } from "../failures/classify.js";
import { messageKey } from "./identity.js";

/**
 * A NO that is the account's temporary cap (throttling, a download or bandwidth limit), not
 * the message's fault: fetching on one by one only hits it again, and counting it against
 * the message would give up deliverable mail. The folder stops and keeps its checkpoint.
 */
function isServerLimit(error: unknown): boolean {
  return (
    isImapSessionError(error) &&
    classifyFailure(error, { role: "imap" }).code === "imap.server_limit"
  );
}

/** One folder as the capture remembers it. */
export interface ImapCaptureFolderState {
  readonly uidValidity: string;
  /** UIDNEXT at the last look. */
  readonly uidNext: number;
  /** Every UID up to and including this one is handled by the live capture. */
  readonly lastUid: number;
  /** UIDs up to this one existed when live capture started: the backfill's (absent: none). */
  readonly backfillUpTo?: number;
  /**
   * The message `lastUid` is held before because the server listed it but did not deliver
   * it, and in how many passes in a row that happened; after
   * {@link MAX_UNDELIVERED_ATTEMPTS} the capture gives up on it instead of re-reading every
   * UID above it on every pass forever.
   */
  readonly stuck?: { readonly uid: number; readonly attempts: number };
}

/** Passes in a row a listed-but-undelivered message holds a folder back before it is given up. */
export const MAX_UNDELIVERED_ATTEMPTS = 3;

/** What the IMAP way keeps in `archive_capture_streams.state` (other keys pass through). */
export interface ImapCaptureState {
  readonly folders: Readonly<Record<string, ImapCaptureFolderState>>;
  /** The folder an IDLE connection watches (INBOX; All Mail on Gmail), and whether the server can IDLE. */
  readonly idle?: { readonly folder: string | null; readonly supported: boolean };
  /** The account is a Gmail account (only All Mail, Spam and Trash are read). */
  readonly gmail?: boolean;
}

/** The capture's state from a stream's state JSON; anything malformed counts as unknown. */
export function readImapCaptureState(
  state: Record<string, unknown> | null | undefined,
): ImapCaptureState {
  const folders: Record<string, ImapCaptureFolderState> = {};
  const raw = state?.folders;
  if (raw && typeof raw === "object") {
    for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = value as Record<string, unknown> | null;
      if (
        entry &&
        typeof entry.uidValidity === "string" &&
        typeof entry.uidNext === "number" &&
        typeof entry.lastUid === "number"
      ) {
        folders[path] = {
          uidValidity: entry.uidValidity,
          uidNext: entry.uidNext,
          lastUid: entry.lastUid,
          ...(typeof entry.backfillUpTo === "number" ? { backfillUpTo: entry.backfillUpTo } : {}),
          ...(readStuck(entry.stuck) ?? {}),
        };
      }
    }
  }
  const idle = state?.idle as { folder?: unknown; supported?: unknown } | undefined;
  return {
    folders,
    ...(idle && typeof idle === "object"
      ? {
          idle: {
            folder: typeof idle.folder === "string" ? idle.folder : null,
            supported: idle.supported === true,
          },
        }
      : {}),
    ...(state?.gmail === true ? { gmail: true } : {}),
  };
}

function readStuck(raw: unknown): { stuck: { uid: number; attempts: number } } | undefined {
  const stuck = raw as { uid?: unknown; attempts?: unknown } | null | undefined;
  return stuck && typeof stuck.uid === "number" && typeof stuck.attempts === "number"
    ? { stuck: { uid: stuck.uid, attempts: stuck.attempts } }
    : undefined;
}

/** Whether the stream's state says the account was activated (its folders are known). */
export function imapCaptureActivated(state: ImapCaptureState): boolean {
  return Object.keys(state.folders).length > 0 || state.idle !== undefined;
}

/** The ref of a message for the archive: `<folder>;<uidvalidity>;<uid>`. */
export function imapExternalRef(path: string, uidValidity: string, uid: number): string {
  return `${path};${uidValidity};${uid}`;
}

const GMAIL_PREFIX = /^\[(gmail|google mail)\](\/|$)/i;
const DRAFT_NAMES = /^(drafts|entw(ü|ue)rfe|brouillons|borradores|bozze|concepten)$/i;

/** Whether a folder list is Gmail's (`[Gmail]/All Mail` with the `\All` attribute). */
export function isGmailFolderList(folders: readonly ImapFolderInfo[]): boolean {
  return folders.some((folder) => folder.specialUse === "\\All" && GMAIL_PREFIX.test(folder.path));
}

export interface CaptureFolderPlan {
  /** The folders a pass reads, INBOX (or All Mail) first. */
  readonly folders: readonly ImapFolderInfo[];
  /** The folder new mail arrives in, for IDLE; null when there is none. */
  readonly idleFolder: string | null;
  readonly gmail: boolean;
}

function isDrafts(folder: ImapFolderInfo): boolean {
  return folder.specialUse === "\\Drafts" || DRAFT_NAMES.test(folder.name);
}

/** Which folders the capture reads (see the module docstring). */
export function captureFolderPlan(
  listed: readonly ImapFolderInfo[],
  options: { readonly gmail?: boolean } = {},
): CaptureFolderPlan {
  const selectable = orderFolders(listed);
  if (options.gmail || isGmailFolderList(listed)) {
    const all = selectable.find(
      (folder) => folder.specialUse === "\\All" || /\/all mail$/i.test(folder.path),
    );
    if (all) {
      const others = selectable.filter(
        (folder) =>
          folder !== all &&
          GMAIL_PREFIX.test(folder.path) &&
          (folder.specialUse === "\\Junk" ||
            folder.specialUse === "\\Trash" ||
            /\/(spam|trash|bin|papierkorb)$/i.test(folder.path)),
      );
      return { folders: [all, ...others], idleFolder: all.path, gmail: true };
    }
  }
  const folders = selectable.filter((folder) => !isDrafts(folder));
  const inbox = folders.find(isInbox);
  return { folders, idleFolder: inbox?.path ?? null, gmail: false };
}

/** Where captured mail goes and what the capture checks before downloading. */
export interface ImapCaptureSink {
  readonly signal: AbortSignal;
  /** Which refs and Message-IDs the archive already holds for this mailbox. */
  alreadyCaptured(query: {
    readonly externalRefs: readonly string[];
    readonly messageIds: readonly string[];
  }): Promise<{ externalRefs: Set<string>; messageKeys: Set<string> }>;
  append(mail: {
    readonly original: Buffer;
    readonly externalRef: string;
    readonly receivedByService: Date | null;
  }): Promise<unknown>;
}

export interface ImapCaptureLimits {
  /** UIDs whose metadata is fetched at once. */
  readonly metaBatch: number;
  /** Bounds of one FETCH of sources. */
  readonly maxBatchBytes: number;
  readonly maxBatchMessages: number;
}

export const DEFAULT_IMAP_CAPTURE_LIMITS: ImapCaptureLimits = {
  metaBatch: 200,
  maxBatchBytes: 32 * 1024 * 1024,
  maxBatchMessages: 50,
};

export interface UidCaptureOutcome {
  readonly captured: number;
  readonly skipped: number;
  /** Every UID up to this one is handled (captured, held already, a draft or gone). */
  readonly handledUpTo: number;
  /**
   * UIDs (ascending) the server listed but did not deliver (or refused with a NO): every
   * other UID was still captured, `handledUpTo` stays before the first of them.
   */
  readonly missing: readonly number[];
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
  }
}

/**
 * Capture the given UIDs (ascending) of the open folder: metadata first, sources only of
 * mail the archive lacks. A message the server listed but did not deliver (expunged between
 * the two FETCHes, no source, or refused with a NO such as Exchange's "message could not be
 * retrieved") stops `handledUpTo` before it, so the next pass asks again; the UIDs after it
 * are still captured (the archive's refs and Message-IDs skip them on that next pass), only
 * the checkpoint is held back.
 */
export async function captureFolderUids(
  session: ImapSession,
  folder: { readonly path: string; readonly uidValidity: string },
  uids: readonly number[],
  sink: ImapCaptureSink,
  options: {
    readonly limits?: ImapCaptureLimits;
    /** Called after each batch with the UID handled up to (a checkpoint). */
    readonly progress?: (handledUpTo: number) => Promise<void>;
    readonly logger?: Logger;
  } = {},
): Promise<UidCaptureOutcome> {
  const limits = options.limits ?? DEFAULT_IMAP_CAPTURE_LIMITS;
  let captured = 0;
  let skipped = 0;
  let handledUpTo = 0;
  const missing: number[] = [];
  const deliver = async (message: { uid: number; source: Buffer; internalDate: Date | null }) => {
    await sink.append({
      original: message.source,
      externalRef: imapExternalRef(folder.path, folder.uidValidity, message.uid),
      receivedByService: message.internalDate,
    });
    captured++;
    abortIfNeeded(sink.signal);
  };
  for (let start = 0; start < uids.length; start += limits.metaBatch) {
    abortIfNeeded(sink.signal);
    const group = uids.slice(start, start + limits.metaBatch);
    const metas = (await session.fetchMeta(group)).filter(
      (meta) => !meta.flags.some((flag) => flag.toLowerCase() === "\\draft"),
    );
    const refOf = (uid: number) => imapExternalRef(folder.path, folder.uidValidity, uid);
    const known = await sink.alreadyCaptured({
      externalRefs: metas.map((meta) => refOf(meta.uid)),
      messageIds: metas.map((meta) => meta.messageId).filter((id): id is string => id !== null),
    });
    const wanted: ImapMessageMeta[] = [];
    for (const meta of metas) {
      const key = messageKey(meta.messageId);
      if (known.externalRefs.has(refOf(meta.uid)) || (key !== null && known.messageKeys.has(key))) {
        skipped++;
      } else {
        wanted.push(meta);
      }
    }
    const delivered = new Set<number>();
    for (const batch of batchBySize(wanted, {
      maxBytes: limits.maxBatchBytes,
      maxMessages: limits.maxBatchMessages,
    })) {
      abortIfNeeded(sink.signal);
      try {
        for await (const message of session.fetchSources(batch)) {
          delivered.add(message.uid);
          await deliver(message);
        }
      } catch (error) {
        if (!isImapSessionError(error) || error.connectionLost || isServerLimit(error)) {
          throw error;
        }
        // A NO for the batch is often one message the server cannot hand out: the rest of
        // the batch one by one, so only that one is left for the next pass.
        for (const uid of batch) {
          if (delivered.has(uid)) {
            continue;
          }
          abortIfNeeded(sink.signal);
          try {
            for await (const message of session.fetchSources([uid])) {
              delivered.add(message.uid);
              await deliver(message);
            }
          } catch (single) {
            if (!isImapSessionError(single) || single.connectionLost || isServerLimit(single)) {
              throw single;
            }
            options.logger?.warn("imap archive capture: server refused a message", {
              folder: folder.path,
              uid,
              errorMessage: single.message,
            });
          }
        }
      }
    }
    const groupMissing = wanted.filter((meta) => !delivered.has(meta.uid)).map((meta) => meta.uid);
    // Listed but not delivered: handled only up to the first of them (the next pass retries);
    // the later groups are still read, only the checkpoint stays before the gap.
    if (missing.length === 0 && groupMissing.length > 0) {
      handledUpTo = Math.max(handledUpTo, Math.min(...groupMissing) - 1);
      await options.progress?.(handledUpTo);
    }
    missing.push(...groupMissing);
    if (missing.length === 0) {
      handledUpTo = group[group.length - 1] as number;
      await options.progress?.(handledUpTo);
    }
  }
  missing.sort((a, b) => a - b);
  return { captured, skipped, handledUpTo, missing };
}

/**
 * Activation: the folders and where each stands now. Mail up to here is the backfill's,
 * mail after it the live capture's.
 */
export async function activateImapCapture(
  session: ImapSession,
  options: { readonly gmail?: boolean; readonly logger?: Logger } = {},
): Promise<ImapCaptureState> {
  const plan = captureFolderPlan(await session.listFolders(), options);
  const folders: Record<string, ImapCaptureFolderState> = {};
  for (const folder of plan.folders) {
    try {
      const status = await session.status(folder.path);
      const lastUid = Math.max(0, status.uidNext - 1);
      folders[folder.path] = {
        uidValidity: status.uidValidity,
        uidNext: status.uidNext,
        lastUid,
        backfillUpTo: lastUid,
      };
    } catch (error) {
      if (!isImapSessionError(error) || error.connectionLost) {
        throw error;
      }
      // A folder the server refuses now is picked up by a later pass as a new folder.
      options.logger?.warn("imap archive capture could not read a folder", {
        folder: folder.path,
        errorMessage: error.message,
      });
    }
  }
  return {
    folders,
    idle: { folder: plan.idleFolder, supported: session.idleSupported },
    ...(plan.gmail ? { gmail: true } : {}),
  };
}

export interface ImapCatchUpOptions {
  readonly gmail?: boolean;
  /** Read every folder from its first UID (a requested resync); the archive's refs keep it cheap. */
  readonly rescan?: boolean;
  readonly limits?: ImapCaptureLimits;
  readonly logger?: Logger;
  /** Persist the state mid-pass (after each batch). */
  readonly checkpoint?: (state: ImapCaptureState) => Promise<void>;
}

export interface ImapCatchUpResult {
  readonly state: ImapCaptureState;
  readonly captured: number;
  readonly skipped: number;
  /** Folders that had new mail and were read. */
  readonly foldersRead: number;
  /**
   * Messages the server kept listing without delivering them that this pass gave up on
   * (after {@link MAX_UNDELIVERED_ATTEMPTS} passes); they are not in the archive.
   */
  readonly undeliverable: number;
}

/** The live catch-up of an activated account (see the module docstring). */
export async function catchUpImapCapture(
  session: ImapSession,
  previous: ImapCaptureState,
  sink: ImapCaptureSink,
  options: ImapCatchUpOptions = {},
): Promise<ImapCatchUpResult> {
  const plan = captureFolderPlan(await session.listFolders(), {
    gmail: options.gmail ?? previous.gmail,
  });
  const folders: Record<string, ImapCaptureFolderState> = {};
  const visited = new Set<string>();
  // Folders the server refuses this time keep what was known about them; folders this pass
  // has not reached yet keep their previous entry, so a mid-pass checkpoint (or the state a
  // failed or interrupted pass leaves) loses neither their lastUid nor their backfillUpTo.
  const snapshot = (): ImapCaptureState => {
    const merged: Record<string, ImapCaptureFolderState> = {};
    for (const folder of plan.folders) {
      const kept = visited.has(folder.path) ? folders[folder.path] : previous.folders[folder.path];
      if (kept) {
        merged[folder.path] = kept;
      }
    }
    return {
      ...previous,
      folders: merged,
      idle: { folder: plan.idleFolder, supported: session.idleSupported },
      ...(plan.gmail ? { gmail: true } : {}),
    };
  };
  let captured = 0;
  let skipped = 0;
  let foldersRead = 0;
  let undeliverable = 0;
  for (const folder of plan.folders) {
    abortIfNeeded(sink.signal);
    visited.add(folder.path);
    const known = previous.folders[folder.path];
    let status: Awaited<ReturnType<ImapSession["status"]>>;
    try {
      status = await session.status(folder.path);
    } catch (error) {
      if (!isImapSessionError(error) || error.connectionLost) {
        throw error;
      }
      options.logger?.warn("imap archive capture could not read a folder", {
        folder: folder.path,
        errorMessage: error.message,
      });
      if (known) {
        folders[folder.path] = known;
      }
      continue;
    }
    const sameValidity = known !== undefined && known.uidValidity === status.uidValidity;
    const from = sameValidity && !options.rescan ? known.lastUid : 0;
    if (sameValidity && !options.rescan && status.uidNext <= known.lastUid + 1) {
      folders[folder.path] = { ...known, uidNext: status.uidNext };
      continue;
    }
    if (known && !sameValidity) {
      options.logger?.info("imap folder UIDVALIDITY changed; the folder is read again", {
        folder: folder.path,
      });
    }
    // Everything below is one folder: a NO on EXAMINE, SEARCH or FETCH (a corrupt mail, a
    // throttled command) costs this folder for this pass, not every folder sorted after it.
    try {
      const opened = await session.openFolder(folder.path);
      const uidValidity = opened.uidValidity;
      const backfillUpTo = known?.uidValidity === uidValidity ? known.backfillUpTo : undefined;
      const stuck = sameValidity && !options.rescan ? known.stuck : undefined;
      const base = (
        lastUid: number,
        holding: ImapCaptureFolderState["stuck"] | null = stuck,
      ): ImapCaptureFolderState => ({
        uidValidity,
        uidNext: opened.uidNext,
        lastUid,
        ...(backfillUpTo !== undefined ? { backfillUpTo } : {}),
        ...(holding && holding.uid > lastUid ? { stuck: holding } : {}),
      });
      const uids = await session.uidsAbove(from);
      foldersRead++;
      const outcome = await captureFolderUids(
        session,
        { path: folder.path, uidValidity },
        uids,
        sink,
        {
          ...(options.limits ? { limits: options.limits } : {}),
          ...(options.logger ? { logger: options.logger } : {}),
          progress: async (handledUpTo) => {
            folders[folder.path] = base(Math.max(from, handledUpTo));
            await options.checkpoint?.(snapshot());
          },
        },
      );
      captured += outcome.captured;
      skipped += outcome.skipped;
      const done = Math.max(from, outcome.handledUpTo, opened.uidNext - 1);
      const [first, next] = outcome.missing;
      if (first === undefined) {
        folders[folder.path] = base(done, null);
      } else {
        const attempts = stuck?.uid === first ? stuck.attempts + 1 : 1;
        if (attempts < MAX_UNDELIVERED_ATTEMPTS) {
          folders[folder.path] = base(Math.max(from, outcome.handledUpTo), {
            uid: first,
            attempts,
          });
        } else {
          // The server keeps listing it without handing it out: give it up, or every pass
          // re-reads every UID above it and the folder never counts as caught up.
          options.logger?.warn(
            "imap archive capture gave up on a message the server does not deliver",
            {
              folder: folder.path,
              uid: first,
              attempts,
            },
          );
          undeliverable++;
          folders[folder.path] =
            next === undefined
              ? base(done, null)
              : base(Math.max(from, next - 1), { uid: next, attempts: 1 });
        }
      }
      await session.closeFolder();
    } catch (error) {
      if (!isImapSessionError(error) || error.connectionLost) {
        throw error;
      }
      options.logger?.warn("imap archive capture could not read a folder", {
        folder: folder.path,
        errorMessage: error.message,
      });
      // What a checkpoint recorded before the error stays; otherwise what was known.
      if (folders[folder.path] === undefined && known) {
        folders[folder.path] = known;
      }
      await session.closeFolder().catch(() => undefined);
      if (isServerLimit(error)) {
        // The account's cap, not this folder's: the next folders would only hit it again.
        // They keep their previous entries (see snapshot) and are read on the next pass.
        break;
      }
    }
  }
  return { state: snapshot(), captured, skipped, foldersRead, undeliverable };
}

/** Where a backfill stands: in the `archive` job's cursor. */
export interface ImapBackfillCursor {
  readonly completed: readonly string[];
  /** Per folder in progress: every UID up to `lastUid` is taken over. */
  readonly active: Readonly<
    Record<string, { readonly uidValidity: string; readonly lastUid: number }>
  >;
}

export function readImapBackfillCursor(raw: unknown): ImapBackfillCursor {
  const value = (raw ?? {}) as { completed?: unknown; active?: unknown };
  const completed = Array.isArray(value.completed)
    ? value.completed.filter((path): path is string => typeof path === "string")
    : [];
  const active: Record<string, { uidValidity: string; lastUid: number }> = {};
  if (value.active && typeof value.active === "object") {
    for (const [path, entry] of Object.entries(value.active as Record<string, unknown>)) {
      const candidate = entry as { uidValidity?: unknown; lastUid?: unknown } | null;
      if (typeof candidate?.uidValidity === "string" && typeof candidate.lastUid === "number") {
        active[path] = { uidValidity: candidate.uidValidity, lastUid: candidate.lastUid };
      }
    }
  }
  return { completed, active };
}

export interface ImapBackfillOptions {
  readonly limits?: ImapCaptureLimits;
  readonly logger?: Logger;
  /** Persist the cursor (after each batch). */
  readonly saveCursor: (cursor: ImapBackfillCursor) => Promise<void>;
  /** Stop (not completed) once this time (epoch ms) has passed; the next job resumes. */
  readonly deadline?: number;
  readonly now?: () => number;
}

export interface ImapBackfillResult {
  readonly captured: number;
  readonly skipped: number;
  readonly completed: boolean;
  readonly cursor: ImapBackfillCursor;
}

/**
 * The one-time takeover of the mail that existed when live capture started
 * (`backfillUpTo` of each folder), resumable from `cursor`. A folder whose UIDVALIDITY
 * changed since is the live capture's (it rescans it), and done here.
 */
export async function backfillImapCapture(
  session: ImapSession,
  state: ImapCaptureState,
  start: ImapBackfillCursor,
  sink: ImapCaptureSink,
  options: ImapBackfillOptions,
): Promise<ImapBackfillResult> {
  const now = options.now ?? Date.now;
  const completed = new Set(start.completed);
  const active: Record<string, { uidValidity: string; lastUid: number }> = { ...start.active };
  const cursor = (): ImapBackfillCursor => ({ completed: [...completed], active: { ...active } });
  let captured = 0;
  let skipped = 0;
  const listed = new Set((await session.listFolders()).map((folder) => folder.path));
  for (const [path, folder] of Object.entries(state.folders)) {
    if (completed.has(path)) {
      continue;
    }
    if (options.deadline !== undefined && now() >= options.deadline) {
      return { captured, skipped, completed: false, cursor: cursor() };
    }
    abortIfNeeded(sink.signal);
    const upTo = folder.backfillUpTo ?? 0;
    if (upTo <= 0 || !listed.has(path)) {
      completed.add(path);
      delete active[path];
      continue;
    }
    let opened: Awaited<ReturnType<ImapSession["openFolder"]>>;
    try {
      opened = await session.openFolder(path);
    } catch (error) {
      if (!isImapSessionError(error) || error.connectionLost) {
        throw error;
      }
      options.logger?.warn("imap archive backfill could not open a folder; it is left out", {
        folder: path,
        errorMessage: error.message,
      });
      completed.add(path);
      continue;
    }
    if (opened.uidValidity !== folder.uidValidity) {
      completed.add(path);
      delete active[path];
      continue;
    }
    const resumeAfter =
      active[path]?.uidValidity === opened.uidValidity ? (active[path]?.lastUid ?? 0) : 0;
    const uids = (await session.uidsAbove(resumeAfter)).filter((uid) => uid <= upTo);
    const outcome = await captureFolderUids(
      session,
      { path, uidValidity: opened.uidValidity },
      uids,
      sink,
      {
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        progress: async (handledUpTo) => {
          active[path] = { uidValidity: opened.uidValidity, lastUid: handledUpTo };
          await options.saveCursor(cursor());
        },
      },
    );
    captured += outcome.captured;
    skipped += outcome.skipped;
    await session.closeFolder();
    // The UIDs after a message listed but not delivered were still read. That message itself
    // is not retried by anyone (live capture starts above backfillUpTo; only a requested
    // resync reads below it): an expunged message is gone anyway, and one without a source
    // would hold the folder forever, so the folder counts as done, but not silently.
    if (outcome.missing.length > 0) {
      options.logger?.warn("imap archive backfill: messages listed but not delivered", {
        folder: path,
        uids: outcome.missing.slice(0, 20),
        count: outcome.missing.length,
      });
    }
    completed.add(path);
    delete active[path];
    await options.saveCursor(cursor());
  }
  return { captured, skipped, completed: true, cursor: cursor() };
}
