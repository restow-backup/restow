/**
 * Archive capture from a Microsoft 365 mailbox by Graph (docs/ARCHIVE.md "Erfassungswege",
 * docs/MICROSOFT.md "Change notifications"). Three ways to find mail, all ending in the
 * same {@link GraphCaptureSink} (the archive append with its dedupe across ways):
 *
 *   - {@link drainGraphPending}: the messages change notifications announced. Metadata first,
 *     in `$batch` (20 per request): drafts are skipped, a message Graph no longer finds
 *     (404: deleted or moved out of reach before it was fetched) is left to the catch-up,
 *     what the archive already holds for the mailbox is not downloaded. Then the MIME.
 *   - {@link catchUpGraphMailbox}: Graph delta over every mail folder plus
 *     `recoverableitemsdeletions`, with its own delta links (never the backup's, which
 *     live in the snapshot manifest). It finds what a notification missed, and in poll-only
 *     mode it is the capture. A folder's first enumeration leaves mail received before
 *     the stream went live to the backfill, unless the backfill is done; a 410 Gone
 *     enumerates that folder again from scratch. Progress is checkpointed per page.
 *   - {@link backfillGraphMailbox}: the one-time takeover of everything the mailbox holds,
 *     page by page with a resumable cursor; the framework flags mail received before the
 *     stream went live `captured-late`.
 *
 * Every request names immutable ids (`Prefer: IdType="ImmutableId"`), so a message keeps
 * its external ref across folder moves and is captured once.
 *
 * A message whose MIME export fails is never dropped silently (0.5.0, docs/ARCHIVE.md
 * "Lücken der Erfassung"): too large for a MIME export (above ~150 MB, `too_large`) or one
 * Exchange cannot convert (IRM, corrupt items: `not_convertible`) is recorded as an open
 * gap at once; the archive keeps MIME only, it does not invent a message from the JSON
 * parts. A 5xx is no refusal: the message is tried again later (the drain keeps it pending,
 * the catch-up and the backfill hand it to {@link GraphCaptureSink.retryLater}), and only
 * after three failed attempts it becomes a gap (`export_failed`).
 *
 * Nothing here touches Postgres or the archive store: the worker's Graph way
 * (apps/worker/src/archive-capture/graph.ts) wires the sink and the state.
 */
import { JobAbortedError } from "../engine/chunkstore.js";
import type { GraphClient } from "../graph/client.js";
import { GraphError, isGone, isGraphError, isNotFound } from "../graph/errors.js";
import { userPath } from "../graph/resources/common.js";
import {
  isMimeTooLargeError,
  listMailFolderTree,
  openMessageMime,
  resolveWellKnownFolders,
  type WellKnownFolderName,
} from "../graph/resources/mail.js";
import { IMMUTABLE_ID_PREFER } from "../graph/resources/subscriptions.js";
import { type CaptureGapSink, GAP_OPEN_AFTER_ATTEMPTS } from "./capture-gaps.js";
import { type HeldMails, heldBySentAt, holdMail } from "./identity.js";

/** Metadata the capture reads per message, in delta pages and in the drain's `$batch`. */
export const GRAPH_CAPTURE_MESSAGE_SELECT = [
  "id",
  "internetMessageId",
  "receivedDateTime",
  "sentDateTime",
  "isDraft",
  "parentFolderId",
] as const;

/**
 * Folders whose content is not mail that was sent or received: search folders (views of
 * other folders), drafts, the outbox (sent mail lands in Sent Items) and the sync issue
 * folders (with their children). Their whole subtree is skipped.
 */
export const GRAPH_CAPTURE_SKIPPED_FOLDERS: ReadonlySet<WellKnownFolderName> = new Set([
  "searchfolders",
  "drafts",
  "outbox",
  "syncissues",
  "conflicts",
  "localfailures",
  "serverfailures",
]);

/** Delta pages and backfill pages: as large as Graph allows for messages. */
const PAGE_SIZE = 200;

/** Headers of every capture request that returns message ids. */
export function graphCaptureHeaders(): Record<string, string> {
  return { Prefer: `odata.maxpagesize=${PAGE_SIZE}, ${IMMUTABLE_ID_PREFER}` };
}

/** One message as the capture sees it before downloading. */
export interface GraphMessageMeta {
  readonly id: string;
  readonly internetMessageId?: string | null;
  readonly receivedDateTime?: string | null;
  /** The Date header. */
  readonly sentDateTime?: string | null;
  readonly isDraft?: boolean | null;
  readonly parentFolderId?: string | null;
  readonly "@removed"?: unknown;
}

/** Where captured mail goes (the worker's capture context). */
export interface GraphCaptureSink {
  /**
   * Which refs the archive holds for the mailbox, and what it holds under the given
   * Message-IDs (size and date of each mail, to compare before a download).
   */
  alreadyCaptured(query: {
    readonly externalRefs?: readonly string[];
    readonly messageIds?: readonly string[];
  }): Promise<{ externalRefs: Set<string>; messages: HeldMails }>;
  append(mail: {
    readonly original: Buffer;
    readonly externalRef: string;
    readonly receivedByService: Date | null;
  }): Promise<unknown>;
  /** Where messages without a MIME export are recorded (./capture-gaps.ts). */
  readonly gaps?: CaptureGapSink;
  /**
   * Fetch these messages again on a later pass (the worker puts them into the drain's
   * pending list): a MIME export that failed with a 5xx in a catch-up or the backfill,
   * whose cursor moves on past the message. Without it such a failure fails the run.
   */
  retryLater?(refs: readonly string[]): Promise<void>;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new JobAbortedError();
  }
}

function dateOf(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Exchange cannot convert the item to MIME (IRM, corrupt or special item classes). */
function isConversionRefused(error: unknown): boolean {
  if (!isGraphError(error) || [401, 403, 404, 410, 429].includes(error.status)) {
    return false;
  }
  const wording = `${error.code ?? ""} ${error.innerCode ?? ""} ${error.message}`;
  return /MimeContentConversion|ConversionFailed|CorruptData/i.test(wording);
}

type MimeOutcome =
  | { readonly original: Buffer }
  | { readonly refused: "too_large" | "not_convertible" }
  | { readonly failed: GraphError };

/**
 * Download one message's MIME (`$value`). A refusal (too large, not convertible) and a
 * 5xx are told apart, never both "too large"; anything else (404, auth, throttling the
 * client gave up on, the network) is thrown.
 */
async function downloadMime(
  client: GraphClient,
  userId: string,
  messageId: string,
  signal: AbortSignal | undefined,
): Promise<MimeOutcome> {
  let stream: Awaited<ReturnType<typeof openMessageMime>>;
  try {
    stream = await openMessageMime(client, userId, messageId);
  } catch (error) {
    if (isMimeTooLargeError(error)) {
      return { refused: "too_large" };
    }
    if (isConversionRefused(error)) {
      return { refused: "not_convertible" };
    }
    if (isGraphError(error) && error.status >= 500) {
      return { failed: error };
    }
    throw error;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    throwIfAborted(signal);
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return { original: Buffer.concat(chunks) };
}

/** Counters every capture function reports. */
export interface GraphCaptureCounts {
  /** Mail handed to the sink. */
  captured: number;
  /** Mail the archive already held for the mailbox, not downloaded. */
  skipped: number;
  /** Ids of messages too large for a MIME export: not archived, recorded as gaps. */
  oversized: string[];
  /** Ids of messages Exchange cannot convert to MIME: not archived, recorded as gaps. */
  notConvertible: string[];
  /** Ids whose MIME export failed (5xx) and that are tried again later. */
  deferred: string[];
  /** Ids whose MIME export failed three times: given up, recorded as gaps. */
  exportFailed: string[];
}

function emptyCounts(): GraphCaptureCounts {
  return {
    captured: 0,
    skipped: 0,
    oversized: [],
    notConvertible: [],
    deferred: [],
    exportFailed: [],
  };
}

/**
 * Capture the messages of one page: those the archive does not hold yet for the mailbox
 * are downloaded and appended, in page order. Held means the ref (immutable id) is known,
 * or a mail with the same Message-ID and the same Date header is: the same Message-ID with
 * another date is downloaded, and the append keeps it if its body differs
 * (`message-id-conflict`) or merges it if it is the same mail.
 */
async function capturePage(
  options: {
    readonly client: GraphClient;
    readonly userId: string;
    readonly sink: GraphCaptureSink;
    readonly signal?: AbortSignal;
  },
  messages: readonly GraphMessageMeta[],
  counts: GraphCaptureCounts,
  /** A failed (5xx) export is kept for later (the caller sees `deferred`), not thrown. */
  defer = true,
): Promise<void> {
  if (messages.length === 0) {
    return;
  }
  const known = await options.sink.alreadyCaptured({
    externalRefs: messages.map((m) => m.id),
    messageIds: messages
      .map((m) => m.internetMessageId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  });
  for (const message of messages) {
    throwIfAborted(options.signal);
    const sentAt = dateOf(message.sentDateTime);
    if (
      known.externalRefs.has(message.id) ||
      heldBySentAt(known.messages, message.internetMessageId, sentAt)
    ) {
      // In the archive: a gap of it (an earlier failure, asked for again) is closed.
      await options.sink.gaps?.resolved("message", message.id);
      counts.skipped++;
      continue;
    }
    let outcome: MimeOutcome;
    try {
      outcome = await downloadMime(options.client, options.userId, message.id, options.signal);
    } catch (error) {
      // Gone between listing and download (deleted, moved out of reach): nothing to keep.
      if (isNotFound(error)) {
        continue;
      }
      throw error;
    }
    if ("refused" in outcome) {
      // No MIME export of this message, now or later: an open gap, never silently dropped.
      await options.sink.gaps?.gaveUp({
        kind: "message",
        ref: message.id,
        reason: outcome.refused,
      });
      (outcome.refused === "too_large" ? counts.oversized : counts.notConvertible).push(message.id);
      continue;
    }
    if ("failed" in outcome) {
      if (!defer) {
        throw outcome.failed;
      }
      const attempts = options.sink.gaps
        ? await options.sink.gaps.failed({
            kind: "message",
            ref: message.id,
            reason: "export_failed",
          })
        : 1;
      if (attempts >= GAP_OPEN_AFTER_ATTEMPTS) {
        counts.exportFailed.push(message.id);
      } else {
        counts.deferred.push(message.id);
      }
      continue;
    }
    const original = outcome.original;
    await options.sink.append({
      original,
      externalRef: message.id,
      receivedByService: dateOf(message.receivedDateTime),
    });
    // A second copy of the same mail later in the page is not downloaded again.
    holdMail(known.messages, message.internetMessageId, { sizeBytes: original.length, sentAt });
    known.externalRefs.add(message.id);
    counts.captured++;
  }
}

/**
 * Capture a page of a catch-up or the backfill. Their cursor moves past the page, so a
 * message whose export failed (5xx) is handed to the sink's `retryLater` (the drain asks for
 * it again); a sink without one fails the run instead, as before 0.5.0.
 */
async function capturePageMovingOn(
  options: Parameters<typeof capturePage>[0],
  messages: readonly GraphMessageMeta[],
  counts: GraphCaptureCounts,
): Promise<void> {
  const before = counts.deferred.length;
  await capturePage(options, messages, counts, options.sink.retryLater !== undefined);
  const deferred = counts.deferred.slice(before);
  if (deferred.length > 0) {
    await options.sink.retryLater?.(deferred);
  }
}

// ---------------------------------------------------------------------------
// Folders

/** A folder the capture enumerates. */
export interface GraphCaptureFolder {
  readonly id: string;
  /** Display names from the root, e.g. `Inbox/Projects`; `Recoverable Items/Deletions`. */
  readonly path: string;
  readonly wellKnownName: WellKnownFolderName | null;
}

/**
 * The folders to capture: the whole folder tree (hidden folders included) without the
 * {@link GRAPH_CAPTURE_SKIPPED_FOLDERS} subtrees, plus `recoverableitemsdeletions` (what a user
 * deleted from Deleted Items; outside the tree, and the only Recoverable Items folder
 * Graph v1.0 names).
 */
export async function graphCaptureFolders(
  client: GraphClient,
  userId: string,
): Promise<GraphCaptureFolder[]> {
  const wellKnown = await resolveWellKnownFolders(client, userId);
  const tree = await listMailFolderTree(client, userId, { includeHidden: true, wellKnown });
  const skipped = new Set<string>();
  const folders: GraphCaptureFolder[] = [];
  for (const node of tree) {
    const skip =
      (node.wellKnownName !== null && GRAPH_CAPTURE_SKIPPED_FOLDERS.has(node.wellKnownName)) ||
      (node.parentFolderId !== null && skipped.has(node.parentFolderId));
    if (skip) {
      skipped.add(node.id);
      continue;
    }
    folders.push({ id: node.id, path: node.path.join("/"), wellKnownName: node.wellKnownName });
  }
  const deletions = wellKnown.byName.get("recoverableitemsdeletions");
  if (deletions && !folders.some((folder) => folder.id === deletions)) {
    folders.push({
      id: deletions,
      path: "Recoverable Items/Deletions",
      wellKnownName: "recoverableitemsdeletions",
    });
  }
  return folders;
}

// ---------------------------------------------------------------------------
// Drain

export interface GraphDrainOptions {
  readonly client: GraphClient;
  readonly userId: string;
  /** Message ids the notifications named (immutable ids). */
  readonly refs: readonly string[];
  readonly sink: GraphCaptureSink;
  readonly signal?: AbortSignal;
}

export interface GraphDrainResult extends GraphCaptureCounts {
  /**
   * Refs that are done (captured, held already, drafts, gone, given up as a gap): delete
   * them from pending. A ref in `deferred` is not, it is fetched again on the next pass.
   */
  handled: string[];
  /** Refs Graph no longer found (404): moved or deleted before the fetch; a catch-up looks. */
  missing: number;
  /** Drafts skipped (a draft is captured once sent, as the sent message). */
  drafts: number;
  /**
   * The first sub-request that failed other than with 404 (403, 5xx after the client's
   * retries); its refs are not in `handled` and stay pending.
   */
  failure: GraphError | null;
  /** Every ref whose fetch failed other than with 404 (403, 5xx after retries): still pending. */
  failed: string[];
}

/**
 * Fetch what notifications announced. A sub-request failing other than with 404 leaves
 * its ref pending and is reported as `failure`; the others are captured.
 */
export async function drainGraphPending(options: GraphDrainOptions): Promise<GraphDrainResult> {
  const result: GraphDrainResult = {
    handled: [],
    missing: 0,
    drafts: 0,
    failure: null,
    failed: [],
    ...emptyCounts(),
  };
  const refs = [...new Set(options.refs)];
  if (refs.length === 0) {
    return result;
  }
  // Mail the archive already holds for the mailbox (an earlier pass, the catch-up): no call.
  const held = await options.sink.alreadyCaptured({ externalRefs: refs });
  const open: string[] = [];
  for (const ref of refs) {
    if (held.externalRefs.has(ref)) {
      await options.sink.gaps?.resolved("message", ref);
      result.handled.push(ref);
      result.skipped++;
    } else {
      open.push(ref);
    }
  }
  if (open.length === 0) {
    return result;
  }
  throwIfAborted(options.signal);
  const select = GRAPH_CAPTURE_MESSAGE_SELECT.join(",");
  const responses = await options.client.batch(
    open.map((ref) => ({
      id: ref,
      method: "GET",
      url: `${userPath(options.userId)}/messages/${encodeURIComponent(ref)}?$select=${select}`,
      headers: { Prefer: IMMUTABLE_ID_PREFER },
    })),
  );
  const messages: GraphMessageMeta[] = [];
  for (const response of responses) {
    if (response.status === 404) {
      result.handled.push(response.id);
      result.missing++;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      result.failed.push(response.id);
      result.failure ??= new GraphError({
        status: response.status,
        method: "GET",
        url: `${userPath(options.userId)}/messages/{id}`,
        headers: response.headers ?? {},
        payload: response.body,
      });
      continue;
    }
    const message = response.body as GraphMessageMeta | undefined;
    if (!message || typeof message.id !== "string") {
      result.handled.push(response.id);
      result.missing++;
      continue;
    }
    if (message.isDraft === true) {
      result.handled.push(response.id);
      result.drafts++;
      continue;
    }
    // Keep the notified ref as the external ref (it is the immutable id Graph returns too).
    messages.push({ ...message, id: response.id });
  }
  await capturePage(options, messages, result);
  // A message whose export failed (5xx) stays pending for the next pass; given up after
  // three attempts it is a gap and done here.
  const later = new Set(result.deferred);
  for (const message of messages) {
    if (!later.has(message.id)) {
      result.handled.push(message.id);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Catch-up (delta)

/** Where one folder's delta enumeration stands. */
export interface GraphFolderCursor {
  /** The delta link of the last complete enumeration. */
  readonly deltaLink?: string;
  /** The next page of an enumeration in progress (checkpointed). */
  readonly nextLink?: string;
  /** The enumeration in progress is the folder's first (see {@link catchUpGraphMailbox}). */
  readonly initial?: boolean;
}

/** The Graph way's own part of the stream state (keys of ../../apps/worker graph.ts). */
export interface GraphCatchUpState {
  readonly folders?: Record<string, GraphFolderCursor>;
  /**
   * The folders the mailbox had when capture started (and every folder seen since). Only
   * their first enumeration leaves the older mail to the backfill; a folder first seen
   * later is enumerated in full: the backfill fixed its folder list at its start, so mail
   * moved into a folder made since would otherwise be taken over by nobody.
   */
  readonly knownFolders?: readonly string[];
}

export interface GraphCatchUpOptions {
  readonly client: GraphClient;
  readonly userId: string;
  readonly state: GraphCatchUpState;
  readonly sink: GraphCaptureSink;
  /** When the stream went live; null before. */
  readonly activatedAt: Date | null;
  /** The backfill took over the mailbox's older mail already. */
  readonly backfillCompleted: boolean;
  /** Forget every delta link and capture everything the archive does not hold. */
  readonly fullResync?: boolean;
  /** Persist the state mid-run (after each page). */
  readonly checkpoint?: (state: GraphCatchUpState) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Folder list (tests); fetched with {@link graphCaptureFolders} otherwise. */
  readonly folders?: readonly GraphCaptureFolder[];
}

export interface GraphCatchUpResult extends GraphCaptureCounts {
  state: GraphCatchUpState;
  folders: number;
  /** Folders whose delta link Graph refused (410) and that were enumerated again. */
  resynced: number;
  /** Messages a first enumeration left to the backfill (received before activation). */
  leftToBackfill: number;
}

function messagesDeltaInitialUrl(userId: string, folderId: string): string {
  return `${userPath(userId)}/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=${GRAPH_CAPTURE_MESSAGE_SELECT.join(",")}`;
}

/** Run the delta catch-up over every capture folder; see the module docstring. */
export async function catchUpGraphMailbox(
  options: GraphCatchUpOptions,
): Promise<GraphCatchUpResult> {
  const folders = options.folders ?? (await graphCaptureFolders(options.client, options.userId));
  const cursors: Record<string, GraphFolderCursor> = {};
  if (!options.fullResync) {
    // Folders that no longer exist lose their cursor.
    for (const folder of folders) {
      const cursor = options.state.folders?.[folder.id];
      if (cursor) {
        cursors[folder.id] = cursor;
      }
    }
  }
  // Before 0.5.0 the state named no known folders: those with a cursor are the known ones;
  // on the very first catch-up (no cursor at all) every folder there is now.
  const known = new Set(
    options.state.knownFolders ??
      (Object.keys(options.state.folders ?? {}).length > 0
        ? Object.keys(options.state.folders ?? {})
        : folders.map((folder) => folder.id)),
  );
  const knownFolders = () => [...new Set([...known, ...folders.map((folder) => folder.id)])];
  const result: GraphCatchUpResult = {
    state: { ...options.state, folders: cursors, knownFolders: knownFolders() },
    folders: folders.length,
    resynced: 0,
    leftToBackfill: 0,
    ...emptyCounts(),
  };
  const save = async () => {
    result.state = { ...options.state, folders: { ...cursors }, knownFolders: knownFolders() };
    await options.checkpoint?.(result.state);
  };
  const activatedAt = options.activatedAt?.getTime() ?? null;

  for (const folder of folders) {
    throwIfAborted(options.signal);
    const initialUrl = messagesDeltaInitialUrl(options.userId, folder.id);
    let cursor = cursors[folder.id] ?? {};
    // A folder's first enumeration (not after a 410, not a full resync) leaves the older
    // mail to the backfill while that has not run, but only for a folder the mailbox had
    // when capture started: one made since is not in the backfill's folder list.
    let initial = cursor.nextLink
      ? cursor.initial === true
      : cursor.deltaLink === undefined && known.has(folder.id);
    if (options.fullResync) {
      initial = false;
    }
    let url = cursor.nextLink ?? cursor.deltaLink ?? initialUrl;
    let restarted = false;
    for (;;) {
      try {
        for await (const page of options.client.delta<GraphMessageMeta>(
          url,
          graphCaptureHeaders(),
        )) {
          throwIfAborted(options.signal);
          const wanted: GraphMessageMeta[] = [];
          for (const message of page.value) {
            if (message["@removed"] !== undefined || message.isDraft === true) {
              continue;
            }
            const received = dateOf(message.receivedDateTime)?.getTime() ?? null;
            if (
              initial &&
              !options.backfillCompleted &&
              activatedAt !== null &&
              received !== null &&
              received < activatedAt
            ) {
              result.leftToBackfill++;
              continue;
            }
            wanted.push(message);
          }
          await capturePageMovingOn(options, wanted, result);
          cursor = page.deltaLink
            ? { deltaLink: page.deltaLink }
            : {
                ...(cursor.deltaLink ? { deltaLink: cursor.deltaLink } : {}),
                ...(page.nextLink ? { nextLink: page.nextLink } : {}),
                initial,
              };
          cursors[folder.id] = cursor;
          await save();
        }
        break;
      } catch (error) {
        if (isGone(error) && !restarted) {
          // The delta link expired: enumerate the folder again, capturing what is unknown.
          restarted = true;
          result.resynced++;
          initial = false;
          url = initialUrl;
          cursor = {};
          delete cursors[folder.id];
          continue;
        }
        if (isNotFound(error)) {
          // The folder went away during the run.
          delete cursors[folder.id];
          break;
        }
        throw error;
      }
    }
  }
  await save();
  return result;
}

// ---------------------------------------------------------------------------
// Backfill

/** The backfill's resumable position (the `archive` job's cursor). */
export interface GraphBackfillCursor {
  /** The folders to take over, fixed when the backfill started. */
  readonly folders: readonly string[];
  /** Index into `folders` of the folder in progress. */
  readonly index: number;
  /** The next page of that folder, when one was started. */
  readonly nextLink?: string;
  readonly captured: number;
  readonly skipped: number;
}

export interface GraphBackfillOptions {
  readonly client: GraphClient;
  readonly userId: string;
  readonly sink: GraphCaptureSink;
  readonly cursor: GraphBackfillCursor | null;
  readonly saveCursor: (cursor: GraphBackfillCursor) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Stop after this long (ms) with `completed: false`; the next job resumes. */
  readonly budgetMs?: number;
  readonly now?: () => number;
  /** Progress per page (messages looked at). */
  readonly onPage?: (info: { folder: number; folders: number; messages: number }) => void;
  /** Folder list (tests); fetched with {@link graphCaptureFolders} otherwise. */
  readonly folders?: readonly GraphCaptureFolder[] | (() => Promise<readonly GraphCaptureFolder[]>);
}

export interface GraphBackfillResult extends GraphCaptureCounts {
  completed: boolean;
  cursor: GraphBackfillCursor;
}

function backfillFolderUrl(userId: string, folderId: string): string {
  return `${userPath(userId)}/mailFolders/${encodeURIComponent(folderId)}/messages?$select=${GRAPH_CAPTURE_MESSAGE_SELECT.join(",")}&$top=${PAGE_SIZE}`;
}

/** Take over every message of the mailbox's capture folders, page by page; resumable. */
export async function backfillGraphMailbox(
  options: GraphBackfillOptions,
): Promise<GraphBackfillResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const listFolders = async (): Promise<readonly GraphCaptureFolder[]> =>
    typeof options.folders === "function"
      ? options.folders()
      : (options.folders ?? (await graphCaptureFolders(options.client, options.userId)));
  let cursor: GraphBackfillCursor =
    options.cursor ??
    ({
      folders: (await listFolders()).map((folder) => folder.id),
      index: 0,
      captured: 0,
      skipped: 0,
    } satisfies GraphBackfillCursor);
  await options.saveCursor(cursor);
  const counts = emptyCounts();
  const result = (completed: boolean): GraphBackfillResult => ({ ...counts, completed, cursor });

  for (;;) {
    if (cursor.index >= cursor.folders.length) {
      // Folders made while the backfill ran (old mail moved into them is in none of the
      // listed ones any more): appended and taken over too before it reports completed.
      const added = (await listFolders())
        .map((folder) => folder.id)
        .filter((id) => !cursor.folders.includes(id));
      if (added.length === 0) {
        break;
      }
      cursor = { ...cursor, folders: [...cursor.folders, ...added] };
      await options.saveCursor(cursor);
    }
    const folderId = cursor.folders[cursor.index] as string;
    let url: string | undefined = cursor.nextLink ?? backfillFolderUrl(options.userId, folderId);
    while (url) {
      throwIfAborted(options.signal);
      if (options.budgetMs !== undefined && now() - started >= options.budgetMs) {
        return result(false);
      }
      const response: { status: number; headers: Record<string, string>; body: unknown } =
        await options.client.request({ method: "GET", url, headers: graphCaptureHeaders() });
      if (response.status === 404) {
        // The folder was deleted since the backfill started.
        break;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new GraphError({
          status: response.status,
          method: "GET",
          url,
          headers: response.headers,
          payload: response.body,
        });
      }
      const page = response.body as {
        value?: GraphMessageMeta[];
        "@odata.nextLink"?: string;
      };
      const messages = (page.value ?? []).filter((m) => m.isDraft !== true);
      const before = { captured: counts.captured, skipped: counts.skipped };
      await capturePageMovingOn(options, messages, counts);
      url = page["@odata.nextLink"];
      const { nextLink: _previous, ...rest } = cursor;
      cursor = {
        ...rest,
        ...(url ? { nextLink: url } : { index: cursor.index + 1 }),
        captured: cursor.captured + counts.captured - before.captured,
        skipped: cursor.skipped + counts.skipped - before.skipped,
      };
      await options.saveCursor(cursor);
      options.onPage?.({
        folder: cursor.index,
        folders: cursor.folders.length,
        messages: (page.value ?? []).length,
      });
    }
    if (cursor.folders[cursor.index] === folderId) {
      // Left by the 404 above.
      const { nextLink: _gone, ...rest } = cursor;
      cursor = { ...rest, index: cursor.index + 1 };
      await options.saveCursor(cursor);
    }
  }
  return result(true);
}
