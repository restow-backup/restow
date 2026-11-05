/**
 * Archive capture from an IMAP account (docs/IMAP.md "Archivierung", docs/ARCHIVE.md
 * "Erfassungswege", 0.4.4): the IMAP side of the worker's capture way
 * (apps/worker/src/archive-capture/imap.ts). Works on an {@link ImapSession} only, so the
 * same code runs against imapflow and the in-process fake (../backup/imap/testing).
 *
 * Which folders: every selectable folder, Sent, Trash and Junk included, the Drafts folder
 * excluded (a draft is not mail anyone sent or received): the folder with the `\Drafts`
 * special-use attribute, or, only when no folder carries it, a top-level folder (or direct
 * child of INBOX) named like one. A folder elsewhere in the tree with such a name
 * ("Kunden/Bozze") is a user's folder and captured. A message flagged `\Draft` is skipped in
 * every folder. A Gmail account (Google Workspace, Gmail) shows every mail once more per
 * label: only `[Gmail]/All Mail`, Spam and Trash are read there, which hold every mail
 * exactly once.
 *
 * Per folder the state keeps UIDVALIDITY, the UIDNEXT last seen and `lastUid` (every UID up
 * to it is handled). A pass asks STATUS first and selects a folder only when UIDNEXT moved
 * past `lastUid`; then only the new UIDs are read, metadata first, and the source only of
 * mail the archive does not hold for this mailbox yet (by `<folder>;<uidvalidity>;<uid>`, or
 * by Message-ID together with the exact size or the Date header). A changed UIDVALIDITY
 * rescans the folder from the start: Message-ID with size or date keeps that from downloading
 * anything twice (Exchange's RFC822.SIZE is an estimate, the date still matches), and a mail
 * with a known Message-ID but other content is downloaded and kept.
 *
 * Activation records where live capture starts (`backfillUpTo` per folder); the one-time
 * backfill takes over the UIDs up to it, checkpointed in its job's cursor.
 */
import { gmailMessageFolders, isGmailFolderList } from "../backup/imap/gmail.js";
import { batchBySize, isInbox, orderFolders } from "../backup/imap/planning.js";
import {
  type ImapFolderInfo,
  type ImapMessageMeta,
  type ImapSession,
  isImapSessionError,
} from "../backup/imap/types.js";
import type { Logger } from "../engine/types.js";
import { classifyFailure } from "../failures/classify.js";
import { type CaptureGap, type CaptureGapSink, GAP_OPEN_AFTER_ATTEMPTS } from "./capture-gaps.js";
import { type HeldMails, heldBySentAt, heldBySize } from "./identity.js";

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

/** The parts of an {@link imapExternalRef} (a folder name may hold `;`), or null. */
export function parseImapExternalRef(
  ref: string,
): { path: string; uidValidity: string; uid: number } | null {
  const last = ref.lastIndexOf(";");
  const middle = last > 0 ? ref.lastIndexOf(";", last - 1) : -1;
  if (middle <= 0) {
    return null;
  }
  const uid = Number(ref.slice(last + 1));
  const uidValidity = ref.slice(middle + 1, last);
  if (!Number.isSafeInteger(uid) || uid <= 0 || uidValidity.length === 0) {
    return null;
  }
  return { path: ref.slice(0, middle), uidValidity, uid };
}
const DRAFT_NAMES = /^(drafts|entw(ü|ue)rfe|brouillons|borradores|bozze|concepten)$/i;

export interface CaptureFolderPlan {
  /** The folders a pass reads, INBOX (or All Mail) first. */
  readonly folders: readonly ImapFolderInfo[];
  /** The folder new mail arrives in, for IDLE; null when there is none. */
  readonly idleFolder: string | null;
  readonly gmail: boolean;
}

/**
 * The account's Drafts folder: the one marked `\Drafts`. Only a server that marks none is
 * judged by the name, and only for a folder at the top level or directly under INBOX, where
 * clients create it; a nested "Kunden/Bozze" or "Projekte/Acme/Drafts" holds received mail.
 */
function draftsFilter(listed: readonly ImapFolderInfo[]): (folder: ImapFolderInfo) => boolean {
  if (listed.some((folder) => folder.specialUse === "\\Drafts")) {
    return (folder) => folder.specialUse === "\\Drafts";
  }
  return (folder) =>
    DRAFT_NAMES.test(folder.name) &&
    (folder.parent.length === 0 ||
      (folder.parent.length === 1 && folder.parent[0]?.toUpperCase() === "INBOX"));
}

/** Which folders the capture reads (see the module docstring). */
export function captureFolderPlan(
  listed: readonly ImapFolderInfo[],
  options: { readonly gmail?: boolean } = {},
): CaptureFolderPlan {
  const selectable = orderFolders(listed);
  if (options.gmail || isGmailFolderList(listed)) {
    const gmail = gmailMessageFolders(selectable);
    if (gmail) {
      return {
        folders: [gmail.allMail, ...gmail.outsideAllMail],
        idleFolder: gmail.allMail.path,
        gmail: true,
      };
    }
  }
  const isDrafts = draftsFilter(listed);
  const folders = selectable.filter((folder) => !isDrafts(folder));
  const inbox = folders.find(isInbox);
  return { folders, idleFolder: inbox?.path ?? null, gmail: false };
}

/** Where captured mail goes and what the capture checks before downloading. */
export interface ImapCaptureSink {
  readonly signal: AbortSignal;
  /**
   * Which refs the archive already holds for this mailbox, and what it holds under the
   * given Message-IDs (size and date of each mail, to compare before a download).
   */
  alreadyCaptured(query: {
    readonly externalRefs: readonly string[];
    readonly messageIds: readonly string[];
  }): Promise<{ externalRefs: Set<string>; messages: HeldMails }>;
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
  /** The deadline passed before every UID was read; `handledUpTo` says how far it got. */
  readonly stopped: boolean;
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
    /**
     * Stop after the batch during which this time (epoch ms) passed (`stopped`), so a very
     * large folder yields mid-folder and the caller resumes from the checkpoint.
     */
    readonly deadline?: number;
    readonly now?: () => number;
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
  const now = options.now ?? Date.now;
  let stopped = false;
  for (let start = 0; start < uids.length; start += limits.metaBatch) {
    abortIfNeeded(sink.signal);
    if (start > 0 && options.deadline !== undefined && now() >= options.deadline) {
      stopped = true;
      break;
    }
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
      // By ref, or by Message-ID together with the exact size or the Date header (ENVELOPE):
      // the same Message-ID with other content is another mail, downloaded and kept
      // (identity.ts). Exchange reports an estimated RFC822.SIZE (unless EnableExactRFC822Size
      // is set), which almost never equals the archived bytes; without the date every
      // UIDVALIDITY change and every copy in another folder downloaded the mail again.
      if (
        known.externalRefs.has(refOf(meta.uid)) ||
        heldBySize(known.messages, meta.messageId, meta.size) ||
        heldBySentAt(known.messages, meta.messageId, meta.envelope?.sentDateTime)
      ) {
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
  return { captured, skipped, handledUpTo, missing, stopped };
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
  /** Where failing folders and given-up messages are recorded (./capture-gaps.ts). */
  readonly gaps?: CaptureGapSink;
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
   * (after {@link MAX_UNDELIVERED_ATTEMPTS} passes); they are not in the archive and are
   * recorded as gaps.
   */
  readonly undeliverable: number;
  /** Folders the server refused this pass (STATUS, EXAMINE, SEARCH or FETCH); counted as gaps. */
  readonly foldersFailed: number;
  /**
   * The pass stopped at the account's limit (`imap.server_limit`): the folder it hit and
   * those after it keep their state for the next pass, nothing counts against them.
   */
  readonly serverLimited: boolean;
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
  let foldersFailed = 0;
  let serverLimited = false;
  const gaps = options.gaps;
  /** A folder the server refused this pass: one more attempt; open from the third pass on. */
  const folderFailed = async (path: string, error: unknown) => {
    foldersFailed++;
    await gaps?.failed({
      kind: "folder",
      ref: path,
      reason: classifyFailure(error, { role: "imap" }).code,
    });
  };
  // Open gaps that may be fetchable by now (once a day): a message the server listed but did
  // not deliver, and a folder whose older mail the backfill could not take over (read from its
  // first UID here). Live capture never reads below its checkpoint otherwise.
  const retryMessages = new Map<string, { uidValidity: string; uid: number }[]>();
  const retryFolders = new Set<string>();
  for (const gap of (await gaps?.retryDue?.({ kinds: ["message", "backfill_folder"] })) ?? []) {
    if (gap.kind === "backfill_folder") {
      retryFolders.add(gap.ref);
      continue;
    }
    const parsed = parseImapExternalRef(gap.ref);
    if (parsed) {
      const list = retryMessages.get(parsed.path) ?? [];
      list.push({ uidValidity: parsed.uidValidity, uid: parsed.uid });
      retryMessages.set(parsed.path, list);
    }
  }
  for (const folder of plan.folders) {
    abortIfNeeded(sink.signal);
    visited.add(folder.path);
    const known = previous.folders[folder.path];
    const rescan = options.rescan === true || retryFolders.has(folder.path);
    const retrying = retryMessages.get(folder.path) ?? [];
    let status: Awaited<ReturnType<ImapSession["status"]>>;
    try {
      status = await session.status(folder.path);
    } catch (error) {
      if (!isImapSessionError(error) || error.connectionLost) {
        throw error;
      }
      if (known) {
        folders[folder.path] = known;
      }
      if (isServerLimit(error)) {
        // The account's cap (Gmail's OVERQUOTA lasts hours while a backfill downloads), not
        // this folder's: nothing counts against it, the folders after it keep their state.
        options.logger?.warn("imap archive capture stopped at the server's limit", {
          folder: folder.path,
          errorMessage: error.message,
        });
        serverLimited = true;
        break;
      }
      options.logger?.warn("imap archive capture could not read a folder", {
        folder: folder.path,
        errorMessage: error.message,
      });
      await folderFailed(folder.path, error);
      continue;
    }
    const sameValidity = known !== undefined && known.uidValidity === status.uidValidity;
    const from = sameValidity && !rescan ? known.lastUid : 0;
    if (
      sameValidity &&
      !rescan &&
      status.uidNext <= known.lastUid + 1 &&
      !retrying.some((entry) => entry.uidValidity === status.uidValidity)
    ) {
      folders[folder.path] = { ...known, uidNext: status.uidNext };
      await gaps?.resolved("folder", folder.path);
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
      const stuck = sameValidity && !rescan ? known.stuck : undefined;
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
      // Messages given up on an earlier pass, below the checkpoint (or the backfill's): asked
      // for once more; one delivered now resolves its gap.
      const again = retrying
        .filter((entry) => entry.uidValidity === uidValidity && entry.uid <= from)
        .map((entry) => entry.uid)
        .sort((a, b) => a - b);
      if (again.length > 0) {
        const retried = await captureFolderUids(
          session,
          { path: folder.path, uidValidity },
          again,
          sink,
          {
            ...(options.limits ? { limits: options.limits } : {}),
            ...(options.logger ? { logger: options.logger } : {}),
          },
        );
        captured += retried.captured;
        skipped += retried.skipped;
        for (const uid of again) {
          if (!retried.missing.includes(uid)) {
            await gaps?.resolved("message", imapExternalRef(folder.path, uidValidity, uid));
          }
        }
      }
      const done = Math.max(from, outcome.handledUpTo, opened.uidNext - 1);
      const [first, next] = outcome.missing;
      if (first === undefined) {
        folders[folder.path] = base(done, null);
      } else {
        // Counted through the gap sink when there is one: at most once per hour, so a burst of
        // NO answers over a few passes does not give up a message fetchable shortly after.
        const attempts = gaps
          ? await gaps.failed({
              kind: "message",
              ref: imapExternalRef(folder.path, uidValidity, first),
              reason: "undelivered",
            })
          : stuck?.uid === first
            ? stuck.attempts + 1
            : 1;
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
          await gaps?.gaveUp({
            kind: "message",
            ref: imapExternalRef(folder.path, uidValidity, first),
            reason: "undelivered",
          });
          folders[folder.path] =
            next === undefined
              ? base(done, null)
              : base(Math.max(from, next - 1), { uid: next, attempts: 1 });
        }
      }
      await session.closeFolder();
      await gaps?.resolved("folder", folder.path);
      if (from === 0 && outcome.missing.length === 0 && !outcome.stopped) {
        // Read from the first UID without a gap (a resync, a UIDVALIDITY change): the mail
        // the backfill was to take over is in the archive too.
        await gaps?.resolved("backfill_folder", folder.path);
      }
    } catch (error) {
      if (!isImapSessionError(error) || error.connectionLost) {
        throw error;
      }
      // What a checkpoint recorded before the error stays; otherwise what was known.
      if (folders[folder.path] === undefined && known) {
        folders[folder.path] = known;
      }
      await session.closeFolder().catch(() => undefined);
      if (isServerLimit(error)) {
        // The account's cap, not this folder's: no attempt against it, and the next folders
        // would only hit it again. They keep their previous entries (see snapshot) and are
        // read on the next pass.
        options.logger?.warn("imap archive capture stopped at the server's limit", {
          folder: folder.path,
          errorMessage: error.message,
        });
        serverLimited = true;
        break;
      }
      options.logger?.warn("imap archive capture could not read a folder", {
        folder: folder.path,
        errorMessage: error.message,
      });
      await folderFailed(folder.path, error);
    }
  }
  return {
    state: snapshot(),
    captured,
    skipped,
    foldersRead,
    undeliverable,
    foldersFailed,
    serverLimited,
  };
}

/**
 * Where a backfill stands (kept on the stream, apps/worker handlers/archive.ts): folders
 * done, the folder in progress, and per folder the UIDs the server listed but did not
 * deliver yet (retried by the next jobs until the gap sink gives them up).
 */
export interface ImapBackfillCursor {
  readonly completed: readonly string[];
  /** Per folder in progress: every UID up to `lastUid` is taken over or in `retry`. */
  readonly active: Readonly<
    Record<string, { readonly uidValidity: string; readonly lastUid: number }>
  >;
  /** Per folder: UIDs at or below `active[path].lastUid` still to be fetched again. */
  readonly retry?: Readonly<Record<string, readonly number[]>>;
}

export function readImapBackfillCursor(raw: unknown): ImapBackfillCursor {
  const value = (raw ?? {}) as { completed?: unknown; active?: unknown; retry?: unknown };
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
  const retry: Record<string, number[]> = {};
  if (value.retry && typeof value.retry === "object") {
    for (const [path, entry] of Object.entries(value.retry as Record<string, unknown>)) {
      const uids = Array.isArray(entry)
        ? entry.filter((uid): uid is number => typeof uid === "number")
        : [];
      if (uids.length > 0) {
        retry[path] = uids;
      }
    }
  }
  return { completed, active, ...(Object.keys(retry).length > 0 ? { retry } : {}) };
}

export interface ImapBackfillOptions {
  readonly limits?: ImapCaptureLimits;
  readonly logger?: Logger;
  /** Persist the cursor (after each batch). */
  readonly saveCursor: (cursor: ImapBackfillCursor) => Promise<void>;
  /** Stop (not completed) once this time (epoch ms) has passed; the next job resumes. */
  readonly deadline?: number;
  readonly now?: () => number;
  /**
   * Where refused folders and undelivered messages are counted and given up
   * (./capture-gaps.ts). Without one, each is given up after its first failure, as
   * before 0.5.0, but never silently: the result counts it.
   */
  readonly gaps?: CaptureGapSink;
}

export interface ImapBackfillResult {
  readonly captured: number;
  readonly skipped: number;
  readonly completed: boolean;
  /**
   * Not completed because folders or messages failed and are retried later (not because
   * the budget ran out): the next job should not start at once.
   */
  readonly retryLater: boolean;
  /** Folders and messages given up in this run (open gaps). */
  readonly gaveUp: number;
  /**
   * What this run left to a later job because the server refused it (a folder path, or a
   * message ref) and why (a failure code, or `undelivered`): the job reports them as failed
   * items, so a run that took nothing of them in never reads as a plain success.
   */
  readonly waiting: readonly { readonly ref: string; readonly reason: string }[];
  readonly cursor: ImapBackfillCursor;
}

/**
 * The one-time takeover of the mail that existed when live capture started
 * (`backfillUpTo` of each folder), resumable from `cursor`. A folder whose UIDVALIDITY
 * changed since is the live capture's (it rescans it), and done here.
 *
 * Nothing is dropped on the first failure (0.5.0): a server limit on EXAMINE stops the run
 * (the account's cap; the next job resumes), another NO keeps the folder pending and counts
 * an attempt in the gap sink, and a message listed but not delivered stays in the cursor's
 * `retry` list. After {@link GAP_OPEN_AFTER_ATTEMPTS} runs the folder or message is given
 * up as an open gap (the stream shows it) and the backfill can complete. A folder's gap is
 * the backfill's own (`backfill_folder`), apart from the live capture's `folder` gap: a live
 * pass that only asks STATUS, or reads the new mail, neither resets the backfill's attempts
 * nor resolves the gap of older mail it never read.
 */
export async function backfillImapCapture(
  session: ImapSession,
  state: ImapCaptureState,
  start: ImapBackfillCursor,
  sink: ImapCaptureSink,
  options: ImapBackfillOptions,
): Promise<ImapBackfillResult> {
  const now = options.now ?? Date.now;
  const gaps = options.gaps;
  const completed = new Set(start.completed);
  const active: Record<string, { uidValidity: string; lastUid: number }> = { ...start.active };
  const retry: Record<string, number[]> = Object.fromEntries(
    Object.entries(start.retry ?? {}).map(([path, uids]) => [path, [...uids]]),
  );
  const cursor = (): ImapBackfillCursor => ({
    completed: [...completed],
    active: { ...active },
    ...(Object.keys(retry).length > 0 ? { retry: { ...retry } } : {}),
  });
  const done = (path: string) => {
    completed.add(path);
    delete active[path];
    delete retry[path];
  };
  let captured = 0;
  let skipped = 0;
  let gaveUp = 0;
  let retryLater = false;
  const waiting: { ref: string; reason: string }[] = [];
  const result = (complete: boolean, later = retryLater): ImapBackfillResult => ({
    captured,
    skipped,
    completed: complete,
    retryLater: !complete && later,
    gaveUp,
    waiting,
    cursor: cursor(),
  });
  /** Count a failed attempt; true when the gap is now given up. */
  const failedAttempt = async (gap: CaptureGap): Promise<boolean> => {
    const attempts = gaps ? await gaps.failed(gap) : GAP_OPEN_AFTER_ATTEMPTS;
    if (attempts >= GAP_OPEN_AFTER_ATTEMPTS) {
      gaveUp++;
      return true;
    }
    return false;
  };
  // A job always reads at least one folder (or one batch of it) before its budget may stop
  // it, so every job moves the cursor on, however small the budget.
  let worked = false;
  const listed = new Set((await session.listFolders()).map((folder) => folder.path));
  for (const [path, folder] of Object.entries(state.folders)) {
    if (completed.has(path)) {
      continue;
    }
    if (worked && options.deadline !== undefined && now() >= options.deadline) {
      // The budget: the continuation starts at once.
      return result(false, false);
    }
    abortIfNeeded(sink.signal);
    const upTo = folder.backfillUpTo ?? 0;
    if (upTo <= 0 || !listed.has(path)) {
      done(path);
      continue;
    }
    let opened: Awaited<ReturnType<ImapSession["openFolder"]>>;
    try {
      opened = await session.openFolder(path);
    } catch (error) {
      if (!isImapSessionError(error) || error.connectionLost) {
        throw error;
      }
      const reason = classifyFailure(error, { role: "imap" }).code;
      if (isServerLimit(error)) {
        // The account's cap (throttling, a bandwidth limit), not this folder's: every further
        // folder would only hit it too. The folder stays pending; a later job resumes.
        options.logger?.warn("imap archive backfill stopped at the server's limit", {
          folder: path,
          errorMessage: error.message,
        });
        retryLater = true;
        waiting.push({ ref: path, reason });
        await options.saveCursor(cursor());
        return result(false, true);
      }
      // Counted as the backfill's own gap (`backfill_folder`): the live capture's passes over
      // this folder (STATUS, its new mail) say nothing about the older mail taken over here.
      if (await failedAttempt({ kind: "backfill_folder", ref: path, reason })) {
        options.logger?.warn("imap archive backfill gave up on a folder; recorded as a gap", {
          folder: path,
          errorMessage: error.message,
        });
        done(path);
        await options.saveCursor(cursor());
      } else {
        options.logger?.warn("imap archive backfill could not open a folder; tried again later", {
          folder: path,
          errorMessage: error.message,
        });
        retryLater = true;
        waiting.push({ ref: path, reason });
      }
      continue;
    }
    worked = true;
    if (opened.uidValidity !== folder.uidValidity) {
      // The live capture reads the whole folder again (it rescans after a UIDVALIDITY change),
      // its older mail included: the backfill's part of it is that rescan's now.
      done(path);
      await gaps?.resolved("backfill_folder", path);
      await session.closeFolder();
      continue;
    }
    const uidValidity = opened.uidValidity;
    const refOf = (uid: number) => imapExternalRef(path, uidValidity, uid);
    const resumeAfter =
      active[path]?.uidValidity === uidValidity ? (active[path]?.lastUid ?? 0) : 0;
    if (active[path]?.uidValidity !== uidValidity) {
      delete retry[path];
    }
    const captureOptions = {
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    };
    // Messages an earlier job could not get: asked for once more.
    const pending: number[] = [];
    const earlier = (retry[path] ?? []).filter((uid) => uid <= resumeAfter);
    if (earlier.length > 0) {
      const again = await captureFolderUids(
        session,
        { path, uidValidity },
        earlier,
        sink,
        captureOptions,
      );
      captured += again.captured;
      skipped += again.skipped;
      for (const uid of earlier) {
        if (!again.missing.includes(uid)) {
          await gaps?.resolved("message", refOf(uid));
        }
      }
      pending.push(...again.missing);
    }
    const uids = (await session.uidsAbove(resumeAfter)).filter((uid) => uid <= upTo);
    const outcome = await captureFolderUids(session, { path, uidValidity }, uids, sink, {
      ...captureOptions,
      ...(options.deadline !== undefined ? { deadline: options.deadline, now } : {}),
      progress: async (handledUpTo) => {
        active[path] = { uidValidity, lastUid: Math.max(resumeAfter, handledUpTo) };
        await options.saveCursor(cursor());
      },
    });
    captured += outcome.captured;
    skipped += outcome.skipped;
    await session.closeFolder();
    if (outcome.stopped) {
      // The budget ran out inside the folder: the next job resumes after `active[path]`
      // (which stays before an undelivered message, so that one is asked for again too).
      if (pending.length > 0) {
        retry[path] = pending;
      }
      await options.saveCursor(cursor());
      return result(false, false);
    }
    pending.push(...outcome.missing);
    // Listed but not delivered (a NO for that message, no source): counted per job; it stays
    // in the cursor until it is delivered or given up as a gap. Live capture starts above
    // backfillUpTo, so nobody else would ever ask for it.
    const kept: number[] = [];
    for (const uid of [...new Set(pending)].sort((a, b) => a - b)) {
      if (!(await failedAttempt({ kind: "message", ref: refOf(uid), reason: "undelivered" }))) {
        kept.push(uid);
      }
    }
    if (pending.length > 0) {
      options.logger?.warn("imap archive backfill: messages listed but not delivered", {
        folder: path,
        uids: pending.slice(0, 20),
        count: pending.length,
        triedAgainLater: kept.length,
      });
    }
    if (kept.length > 0) {
      active[path] = { uidValidity, lastUid: upTo };
      retry[path] = kept;
      retryLater = true;
      waiting.push(...kept.map((uid) => ({ ref: refOf(uid), reason: "undelivered" })));
    } else {
      // Taken over: every UID up to backfillUpTo is in the archive or an open message gap.
      done(path);
      await gaps?.resolved("backfill_folder", path);
    }
    await options.saveCursor(cursor());
  }
  return result(!retryLater);
}
