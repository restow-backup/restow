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
 * its external ref across folder moves and is captured once. Messages too large for a
 * MIME export (above ~150 MB) are not archived and are reported back (`oversized`).
 *
 * Nothing here touches Postgres or the archive store: the worker's Graph way
 * (apps/worker/src/archive-capture/graph.ts) wires the sink and the state.
 */
import { JobAbortedError } from "../engine/chunkstore.js";
import type { GraphClient } from "../graph/client.js";
import { GraphError, isGone, isNotFound } from "../graph/errors.js";
import { userPath } from "../graph/resources/common.js";
import {
  fetchMessageContent,
  listMailFolderTree,
  resolveWellKnownFolders,
  type WellKnownFolderName,
} from "../graph/resources/mail.js";
import { IMMUTABLE_ID_PREFER } from "../graph/resources/subscriptions.js";
import { messageKey } from "./identity.js";

/** Metadata the capture reads per message, in delta pages and in the drain's `$batch`. */
export const GRAPH_CAPTURE_MESSAGE_SELECT = [
  "id",
  "internetMessageId",
  "receivedDateTime",
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
  readonly isDraft?: boolean | null;
  readonly parentFolderId?: string | null;
  readonly "@removed"?: unknown;
}

/** Where captured mail goes (the worker's capture context). */
export interface GraphCaptureSink {
  /** Which refs and Message-IDs (as {@link messageKey}s) the archive holds for the mailbox. */
  alreadyCaptured(query: {
    readonly externalRefs?: readonly string[];
    readonly messageIds?: readonly string[];
  }): Promise<{ externalRefs: Set<string>; messageKeys: Set<string> }>;
  append(mail: {
    readonly original: Buffer;
    readonly externalRef: string;
    readonly receivedByService: Date | null;
  }): Promise<unknown>;
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

/** Download one message's MIME; null when Graph refuses the MIME export (too large). */
async function downloadMime(
  client: GraphClient,
  userId: string,
  messageId: string,
  signal: AbortSignal | undefined,
): Promise<Buffer | null> {
  const content = await fetchMessageContent(client, userId, messageId);
  if (content.kind !== "mime") {
    return null;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of content.stream) {
    throwIfAborted(signal);
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** Counters every capture function reports. */
export interface GraphCaptureCounts {
  /** Mail handed to the sink. */
  captured: number;
  /** Mail the archive already held for the mailbox, not downloaded. */
  skipped: number;
  /** Ids of messages too large for a MIME export: not archived. */
  oversized: string[];
}

/**
 * Capture the messages of one page: those the archive does not hold yet for the mailbox
 * (by ref or Message-ID) are downloaded and appended, in page order.
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
    const key = messageKey(message.internetMessageId ?? null);
    if (known.externalRefs.has(message.id) || (key !== null && known.messageKeys.has(key))) {
      counts.skipped++;
      continue;
    }
    let original: Buffer | null;
    try {
      original = await downloadMime(options.client, options.userId, message.id, options.signal);
    } catch (error) {
      // Gone between listing and download (deleted, moved out of reach): nothing to keep.
      if (isNotFound(error)) {
        continue;
      }
      throw error;
    }
    if (original === null) {
      counts.oversized.push(message.id);
      continue;
    }
    await options.sink.append({
      original,
      externalRef: message.id,
      receivedByService: dateOf(message.receivedDateTime),
    });
    if (key !== null) {
      // A second copy of the same mail later in the page is not downloaded again.
      known.messageKeys.add(key);
    }
    known.externalRefs.add(message.id);
    counts.captured++;
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
  /** Refs that are done (captured, held already, drafts, gone): delete them from pending. */
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
    captured: 0,
    skipped: 0,
    oversized: [],
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
  for (const message of messages) {
    result.handled.push(message.id);
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
  const result: GraphCatchUpResult = {
    state: { ...options.state, folders: cursors },
    folders: folders.length,
    resynced: 0,
    leftToBackfill: 0,
    captured: 0,
    skipped: 0,
    oversized: [],
  };
  const save = async () => {
    result.state = { ...options.state, folders: { ...cursors } };
    await options.checkpoint?.(result.state);
  };
  const activatedAt = options.activatedAt?.getTime() ?? null;

  for (const folder of folders) {
    throwIfAborted(options.signal);
    const initialUrl = messagesDeltaInitialUrl(options.userId, folder.id);
    let cursor = cursors[folder.id] ?? {};
    // A folder's first enumeration (not after a 410, not a full resync) leaves the older
    // mail to the backfill while that has not run.
    let initial = cursor.nextLink ? cursor.initial === true : cursor.deltaLink === undefined;
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
          await capturePage(options, wanted, result);
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
  readonly folders?: readonly GraphCaptureFolder[];
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
  let cursor: GraphBackfillCursor =
    options.cursor ??
    ({
      folders: (options.folders ?? (await graphCaptureFolders(options.client, options.userId))).map(
        (folder) => folder.id,
      ),
      index: 0,
      captured: 0,
      skipped: 0,
    } satisfies GraphBackfillCursor);
  await options.saveCursor(cursor);
  const counts: GraphCaptureCounts = { captured: 0, skipped: 0, oversized: [] };
  const result = (completed: boolean): GraphBackfillResult => ({ ...counts, completed, cursor });

  while (cursor.index < cursor.folders.length) {
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
      await capturePage(options, messages, counts);
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
