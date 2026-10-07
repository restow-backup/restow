/**
 * The per-run context shared by the mail, calendar and contacts phases: the
 * Graph client, the snapshot writer with an id index over its objects, the
 * engine state, counters, and the checkpoint discipline.
 *
 * Every item the phases produce goes through {@link BackupRun.recordFetched}
 * (content fetched in this run) or {@link BackupRun.carryForward} (content
 * unchanged, metadata refreshed). Both keep the {@link ObjectIndex} in step
 * with the writer, so "is this item already stored?" is one map lookup rather
 * than a scan of the manifest.
 */
import { Readable } from "node:stream";
import { JobAbortedError, type ObjectInput, type WrittenObject } from "../../engine/chunkstore.js";
import type { SnapshotWriter } from "../../engine/snapshot.js";
import type {
  ItemFailureRecord,
  JobContext,
  Logger,
  ProgressReporter,
} from "../../engine/types.js";
import { classifyFailure } from "../../failures/classify.js";
import { type GraphClient, RETRYABLE_STATUSES } from "../../graph/client.js";
import { isGraphError, isMailboxUnavailable, isNotFound } from "../../graph/errors.js";
import type { ManifestObject } from "../../manifest.js";
import {
  type ExchangeCursor,
  type ExchangePhase,
  type ExchangeProgress,
  type ExchangeState,
  serializeState,
} from "./state.js";

/** Object types this engine writes (mapped onto `manifest_object_kind` by the worker). */
export const OBJECT_TYPES = {
  mail: "mail",
  attachment: "attachment",
  event: "event",
  contact: "contact",
  folder: "folder",
} as const;

export type ExchangeObjectType = (typeof OBJECT_TYPES)[keyof typeof OBJECT_TYPES];

/**
 * Metadata keys (all values are strings, see ManifestObject.metadata). The keys
 * marked "restore" are the shared vocabulary of restore/conventions.ts; the
 * others are this engine's own bookkeeping.
 */
export const META = {
  /** restore: RFC 5322 Message-ID; the worker mirrors it into `manifest_objects.message_id`. */
  messageId: "messageId",
  /** restore: folder names from the area root down (`Inbox/Projects`; `""` = the area root). */
  folderPath: "folderPath",
  /** restore: well-known name (inbox, sentitems, ...) of the first segment of `folderPath`. */
  wellKnownFolder: "wellKnownFolder",
  /** restore: `mime` (RFC 5322 bytes) or `json` (Graph message JSON, oversized messages). */
  format: "format",
  contentType: "contentType",
  /** restore: message state a MIME import does not carry. */
  isRead: "isRead",
  flagStatus: "flagStatus",
  categories: "categories",
  importance: "importance",
  /** restore: attachment facts; `messagePath` names the JSON message the attachment belongs to. */
  messagePath: "messagePath",
  name: "name",
  isInline: "isInline",
  /** restore: calendar facts of an event. */
  calendarName: "calendarName",
  isDefaultCalendar: "isDefaultCalendar",

  /** Graph id of the mail or contact folder an object lives in. */
  folderId: "folderId",
  calendarId: "calendarId",
  /** Well-known name of a mail folder itself (on folder objects). */
  wellKnownName: "wellKnownName",
  /** Digest of the content-relevant properties; equal digests mean the bytes need not be fetched again. */
  fingerprint: "fingerprint",
  /** Snapshot in which the bytes were last fetched from Graph (kept on metadata-only updates). */
  fetchedInSnapshot: "fetchedInSnapshot",
  /** For attachments and their folder: the Graph id of the message they belong to. */
  messageItemId: "messageItemId",
  /** For folder objects: `mail`, `calendar`, `contacts`, `attachments` or `root`. */
  folderKind: "folderKind",
  /** For JSON messages: number of attachment objects stored with the message. */
  attachmentCount: "attachmentCount",
  /** For JSON messages: names of link attachments, whose target Graph v1.0 does not expose. */
  referenceAttachments: "referenceAttachments",

  /** restore: mail envelope metadata contract shared with the IMAP engine - the same key names, same meaning. */
  subject: "subject",
  /** 'Display Name <address>' or the bare address. */
  from: "from",
  /** Comma-separated, capped at 20 entries; `toCount` carries the full total. */
  to: "to",
  toCount: "toCount",
  /** Comma-separated, capped at 20 entries; `ccCount` carries the full total. */
  cc: "cc",
  ccCount: "ccCount",
  hasAttachments: "hasAttachments",
  /** "rights-protected" (IRM/Purview) or "smime-encrypted" (S/MIME enveloped data); absent otherwise. */
  protection: "protection",
} as const;

export const MESSAGE_FORMAT = { mime: "mime", json: "json" } as const;

/**
 * Phase names reported through the ProgressReporter (and shown by the UI). They
 * are stable identifiers, never folder names, so the UI can translate them.
 */
export const EXCHANGE_PHASES = {
  folders: "folders",
  mail: "mail",
  /** A mail folder whose delta link expired is being enumerated from scratch. */
  resync: "resync",
  calendar: "calendar",
  contacts: "contacts",
  commit: "commit",
} as const;

export type ExchangeReportedPhase = (typeof EXCHANGE_PHASES)[keyof typeof EXCHANGE_PHASES];

/** Group key of an object: everything that lives in the same mail folder, calendar or contact folder. */
export function groupOf(object: ManifestObject): string {
  const metadata = object.metadata ?? {};
  switch (object.type) {
    case OBJECT_TYPES.mail:
    case OBJECT_TYPES.attachment:
      return mailGroup(metadata[META.folderId] ?? "");
    case OBJECT_TYPES.event:
      return calendarGroup(metadata[META.calendarId] ?? "");
    case OBJECT_TYPES.contact:
      return contactsGroup(metadata[META.folderId] ?? "");
    case OBJECT_TYPES.folder:
      // The attachments folder of a JSON message lives with the message.
      return metadata[META.messageItemId] !== undefined
        ? mailGroup(metadata[META.folderId] ?? "")
        : FOLDERS_GROUP;
    default:
      return `other:${object.type ?? ""}`;
  }
}

/** Group of every folder object (mail folders, calendars, contact folders, roots). */
export const FOLDERS_GROUP = "folders";

export function mailGroup(folderId: string): string {
  return `mail:${folderId}`;
}

export function calendarGroup(calendarId: string): string {
  return `calendar:${calendarId}`;
}

/** Contact folder group; the default folder (no Graph id) uses the empty key. */
export function contactsGroup(folderKey: string): string {
  return `contacts:${folderKey}`;
}

function idKey(type: string | undefined, id: string): string {
  return `${type ?? ""}:${id}`;
}

/**
 * Index over the writer's objects by (type, id) and by group. The writer stays
 * the source of truth; the index only answers lookups and is updated through
 * the same calls that mutate the writer.
 */
export class ObjectIndex {
  private readonly byId = new Map<string, ManifestObject>();
  private readonly byGroup = new Map<string, Map<string, ManifestObject>>();

  constructor(private readonly writer: SnapshotWriter) {
    for (const object of writer.listObjects()) {
      this.track(object);
    }
  }

  private track(object: ManifestObject): void {
    if (object.id !== undefined) {
      this.byId.set(idKey(object.type, object.id), object);
    }
    const group = groupOf(object);
    let members = this.byGroup.get(group);
    if (!members) {
      members = new Map();
      this.byGroup.set(group, members);
    }
    members.set(object.path, object);
  }

  private untrack(object: ManifestObject): void {
    if (object.id !== undefined && this.byId.get(idKey(object.type, object.id)) === object) {
      this.byId.delete(idKey(object.type, object.id));
    }
    const group = groupOf(object);
    const members = this.byGroup.get(group);
    if (members?.get(object.path) === object) {
      members.delete(object.path);
      if (members.size === 0) {
        this.byGroup.delete(group);
      }
    }
  }

  get(type: ExchangeObjectType, id: string): ManifestObject | undefined {
    return this.byId.get(idKey(type, id));
  }

  /** Objects of a group (a mail folder, a calendar, a contact folder), in no particular order. */
  members(group: string): ManifestObject[] {
    return [...(this.byGroup.get(group)?.values() ?? [])];
  }

  groups(prefix: string): string[] {
    return [...this.byGroup.keys()].filter((group) => group.startsWith(prefix));
  }

  /**
   * Add or replace an object. An object with the same (type, id) at another
   * path is removed first, so a renamed item never leaves a stale twin behind.
   */
  put(object: ManifestObject): void {
    if (object.id !== undefined) {
      const twin = this.byId.get(idKey(object.type, object.id));
      if (twin && twin.path !== object.path) {
        this.removePath(twin.path);
      }
    }
    const previous = this.writer.get(object.path);
    if (previous) {
      this.untrack(previous);
    }
    this.writer.add(object);
    this.track(object);
  }

  removePath(path: string): boolean {
    const object = this.writer.get(path);
    if (!object) {
      return false;
    }
    this.untrack(object);
    return this.writer.remove(path);
  }
}

/**
 * Per-run counters. They count source items (a message, an event, a
 * contact); attachments and folders ride along with their item.
 */
export interface RunCounters {
  /** Items whose content was fetched and stored in this run. */
  written: number;
  /** Items carried forward with refreshed metadata or a new path. */
  updated: number;
  unchanged: number;
  /** Items the mailbox no longer has. */
  removed: number;
  /**
   * Items deleted in the mailbox between being listed and being fetched. A
   * stored copy of such an item is dropped and counted under `removed` too.
   */
  vanished: number;
  failed: number;
}

/** Thrown when the mailbox as a whole cannot be read (no consent, access policy, no mailbox). */
export class MailboxAccessError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "MailboxAccessError";
    this.status = options.status;
    this.code = options.code;
  }
}

/** A problem that concerns exactly one item; recorded as an item failure, never fatal. */
export class ItemError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "ItemError";
  }
}

export interface CheckpointPolicy {
  readonly everyItems: number;
  readonly everyBytes: number;
}

export interface BackupRunOptions {
  readonly ctx: JobContext;
  readonly client: GraphClient;
  readonly userId: string;
  readonly writer: SnapshotWriter;
  readonly state: ExchangeState;
  readonly progress: ExchangeProgress;
  /** Delta links of folders completed by an interrupted attempt of this run. */
  readonly deltaTokens: Record<string, string>;
  readonly full: boolean;
  readonly checkpoints: CheckpointPolicy;
}

/** An object whose bytes were written in this run, ready to be recorded. */
export interface FetchedObject {
  readonly object: Omit<ManifestObject, "chunks" | "size" | "sha256">;
  readonly content: WrittenObject;
}

export class BackupRun {
  readonly ctx: JobContext;
  readonly client: GraphClient;
  readonly userId: string;
  readonly writer: SnapshotWriter;
  readonly index: ObjectIndex;
  readonly state: ExchangeState;
  readonly progress: ExchangeProgress;
  readonly deltaTokens: Record<string, string>;
  readonly full: boolean;
  readonly logger: Logger;
  readonly reporter: ProgressReporter;
  readonly counters: RunCounters = {
    written: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    vanished: 0,
    failed: 0,
  };
  /** Every item failure of this run, in order (also reported through the progress reporter). */
  readonly failures: ItemFailureRecord[] = [];

  private readonly checkpoints: CheckpointPolicy;
  private phase: ExchangePhase = "mail";
  private reportedPhase: ExchangeReportedPhase | undefined;
  private folderId: string | undefined;
  private lastItemId: string | undefined;
  private itemsSinceCheckpoint = 0;
  private bytesSinceCheckpoint = 0;
  private expected = 0;

  constructor(options: BackupRunOptions) {
    this.ctx = options.ctx;
    this.client = options.client;
    this.userId = options.userId;
    this.writer = options.writer;
    this.index = new ObjectIndex(options.writer);
    this.state = options.state;
    this.progress = options.progress;
    this.deltaTokens = options.deltaTokens;
    this.full = options.full;
    this.checkpoints = options.checkpoints;
    this.logger = options.ctx.logger.child({
      component: "exchange-backup",
      snapshotId: options.writer.snapshotId,
    });
    this.reporter = options.ctx.progress;
  }

  get snapshotId(): string {
    return this.writer.snapshotId;
  }

  throwIfAborted(): void {
    if (this.ctx.signal.aborted) {
      throw new JobAbortedError();
    }
  }

  /** Enter a phase of the run: recorded in the cursor, reported to the UI. */
  enterPhase(phase: ExchangePhase, reported: ExchangeReportedPhase = phase): void {
    this.phase = phase;
    this.folderId = undefined;
    this.lastItemId = undefined;
    this.report(reported);
  }

  /** Report a phase to the UI; repeated reports of the same phase are dropped. */
  report(phase: ExchangeReportedPhase): void {
    if (this.reportedPhase !== phase) {
      this.reportedPhase = phase;
      this.reporter.phase(phase);
    }
  }

  /** Position within the current phase (mail folder id, last item), for the cursor. */
  setPosition(folderId: string | undefined, lastItemId?: string): void {
    this.folderId = folderId;
    this.lastItemId = lastItemId;
  }

  /** Raise the expected item count shown as progress total. */
  expectMore(count: number): void {
    if (count <= 0) {
      return;
    }
    this.expected += count;
    this.reporter.total(this.expected);
  }

  cursor(): ExchangeCursor {
    const cursor: ExchangeCursor = {
      phase: this.phase,
      deltaTokens: { ...this.deltaTokens },
      exchange: {
        completedFolders: [...this.progress.completedFolders],
        calendarDone: this.progress.calendarDone,
        contactsDone: this.progress.contactsDone,
      },
    };
    if (this.folderId !== undefined) {
      cursor.folderId = this.folderId;
      const link = this.state.mailDeltaLinks[this.folderId];
      if (link !== undefined) {
        cursor.deltaToken = link;
      }
    }
    if (this.lastItemId !== undefined) {
      cursor.lastItemId = this.lastItemId;
    }
    return cursor;
  }

  /** Make everything so far durable (packs, partial manifest, cursor). */
  async checkpoint(): Promise<void> {
    this.writer.setState(serializeState(this.state));
    await this.writer.checkpoint(this.cursor());
    this.itemsSinceCheckpoint = 0;
    this.bytesSinceCheckpoint = 0;
  }

  /** Checkpoint when enough items or bytes have accumulated since the last one. */
  async maybeCheckpoint(): Promise<void> {
    if (
      this.itemsSinceCheckpoint >= this.checkpoints.everyItems ||
      this.bytesSinceCheckpoint >= this.checkpoints.everyBytes
    ) {
      await this.checkpoint();
    }
  }

  private noteItem(bytes: number): void {
    this.itemsSinceCheckpoint++;
    this.bytesSinceCheckpoint += bytes;
  }

  /**
   * Chunk and store bytes without recording an object yet (see
   * {@link recordFetched}). A response stream that could not be consumed to
   * the end (abort, storage error) is destroyed so its connection is released.
   */
  async writeContent(input: ObjectInput): Promise<WrittenObject> {
    try {
      return await this.writer.chunks.write(input);
    } catch (error) {
      if (input instanceof Readable) {
        input.destroy();
      }
      throw error;
    }
  }

  /**
   * Record the objects of one item whose content was fetched in this run (a
   * message and its attachments are recorded together or not at all).
   */
  recordFetched(objects: readonly FetchedObject[]): void {
    let size = 0;
    let newBytes = 0;
    for (const { object, content } of objects) {
      this.index.put({
        ...object,
        metadata: { ...(object.metadata ?? {}), [META.fetchedInSnapshot]: this.snapshotId },
        size: content.size,
        sha256: content.sha256,
        chunks: content.chunks,
      });
      size += content.size;
      newBytes += content.newBytes;
    }
    this.counters.written++;
    this.reporter.advance(1, newBytes, size);
    this.noteItem(size);
  }

  /** Fetch-and-store for an item that is exactly one object. */
  async storeBytes(input: ObjectInput, object: FetchedObject["object"]): Promise<void> {
    const content = await this.writeContent(input);
    this.recordFetched([{ object, content }]);
  }

  /**
   * Keep an item's bytes, refresh path/mtime/metadata. `fetchedInSnapshot` is
   * preserved so a resumed `full` run can tell content fetched by this run
   * from inherited content.
   */
  carryForward(
    existing: ManifestObject,
    next: { path: string; mtime: number; metadata: Record<string, string> },
  ): "unchanged" | "updated" {
    const metadata = {
      ...next.metadata,
      [META.fetchedInSnapshot]: existing.metadata?.[META.fetchedInSnapshot] ?? "",
    };
    const same =
      existing.path === next.path &&
      existing.mtime === next.mtime &&
      metadataEqual(existing.metadata ?? {}, metadata);
    if (same) {
      this.counters.unchanged++;
    } else {
      this.index.put({ ...existing, path: next.path, mtime: next.mtime, metadata });
      this.counters.updated++;
    }
    this.reporter.advance(1, 0);
    this.noteItem(0);
    return same ? "unchanged" : "updated";
  }

  /** Was this object's content fetched from Graph in the current run (as opposed to inherited)? */
  fetchedInThisRun(object: ManifestObject): boolean {
    return object.metadata?.[META.fetchedInSnapshot] === this.snapshotId;
  }

  /**
   * Can `existing` stand in for an item whose content fingerprint is `fingerprint`?
   * In a `full` run only content fetched by this very run (before an interruption)
   * qualifies; everything inherited is fetched again.
   */
  reusable(existing: ManifestObject | undefined, fingerprint: string): existing is ManifestObject {
    if (!existing || existing.metadata?.[META.fingerprint] !== fingerprint) {
      return false;
    }
    return !this.full || this.fetchedInThisRun(existing);
  }

  /** Drop an item together with the objects that ride along with it (attachments, their folder). */
  removeItem(object: ManifestObject, riders: readonly ManifestObject[] = []): void {
    for (const rider of riders) {
      this.index.removePath(rider.path);
    }
    if (this.index.removePath(object.path)) {
      this.counters.removed++;
      this.noteItem(0);
    }
  }

  /** An item was deleted in the mailbox after it was listed; nothing to store, nothing failed. */
  vanished(itemRef: string): void {
    this.counters.vanished++;
    this.reporter.advance(1, 0);
    this.noteItem(0);
    this.logger.debug("item deleted in the mailbox while the backup ran", {
      itemRef: redactItemRef(itemRef),
    });
  }

  /** Record an item failure (never fatal for the run). */
  fail(itemRef: string, error: unknown, itemDate?: string | null): void {
    const reason = describeError(error);
    const cause = classifyFailure(error);
    this.counters.failed++;
    this.failures.push({ itemRef, reason, cause });
    this.reporter.fail(itemRef, reason, cause, { itemDate });
    this.noteItem(0);
    this.logger.warn("item failed", { itemRef: redactItemRef(itemRef), reason });
  }
}

function metadataEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) {
    return false;
  }
  return keysA.every((key) => a[key] === b[key]);
}

/** A one-line reason for `item_failures`: status and Graph code, no bodies or tokens. */
export function describeError(error: unknown): string {
  if (isGraphError(error)) {
    const code = error.code ?? error.innerCode;
    return `Graph ${error.status}${code ? ` ${code}` : ""}: ${truncate(error.message, 300)}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${truncate(error.message, 300)}`;
  }
  return truncate(String(error), 300);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Log lines carry ids, not subjects: keep the folder and the id digest of a path only. */
function redactItemRef(itemRef: string): string {
  const slash = itemRef.lastIndexOf("/");
  const name = slash < 0 ? itemRef : itemRef.slice(slash + 1);
  const digest = name.match(/\.([0-9a-f]{8,16})(?:\.[a-z]+)?$/)?.[1];
  return digest ? `${slash < 0 ? "" : `${itemRef.slice(0, slash)}/`}…${digest}` : "…";
}

/**
 * Errors that mean the whole mailbox is off limits: 401 (token), 403 (no
 * consent or an Application Access Policy) and the "no mailbox" codes. They
 * abort the snapshot instead of producing a run full of item failures.
 */
export function isMailboxAccessError(error: unknown): boolean {
  if (error instanceof MailboxAccessError) {
    return true;
  }
  if (!isGraphError(error)) {
    return false;
  }
  return error.status === 401 || error.status === 403 || isMailboxUnavailable(error);
}

/** Wrap a structural failure (folder tree, calendar list) as a mailbox access error when that is what it is. */
export function toMailboxAccessError(error: unknown, what: string): unknown {
  if (error instanceof MailboxAccessError || !isMailboxAccessError(error) || !isGraphError(error)) {
    return error;
  }
  return new MailboxAccessError(`cannot read ${what}: ${describeError(error)}`, {
    status: error.status,
    code: error.code ?? error.innerCode,
    cause: error,
  });
}

/**
 * The item was deleted between being listed and being fetched (docs: "404 →
 * item vanished between delta and download"). Not a failure: the mailbox
 * simply no longer has it. "No mailbox" codes that also come as 404 are not
 * a vanished item.
 */
export function isVanished(error: unknown): boolean {
  return isNotFound(error) && !isMailboxUnavailable(error);
}

/**
 * Errors that concern one item only and are recorded as an item failure: an
 * {@link ItemError}, any Graph answer except 401 (which breaks every following
 * call as well) and throttling the client already retried in vain (the next
 * item would fare no better; the job is retried later and resumes), and
 * transport failures while a body was being streamed (the fetch stack raises
 * plain TypeErrors and socket errors for those). Everything else (storage,
 * index, programming errors, cancellation) fails the run so the framework can
 * retry it from the last checkpoint.
 */
export function isItemLevelError(error: unknown): boolean {
  if (error instanceof JobAbortedError) {
    return false;
  }
  if (error instanceof ItemError) {
    return true;
  }
  if (isGraphError(error)) {
    return error.status !== 401 && !RETRYABLE_STATUSES.has(error.status);
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSPORT_CODES.has(code)) {
    return true;
  }
  return error.name === "TypeError" && TRANSPORT_MESSAGE.test(error.message);
}

const TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_SOCKET",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const TRANSPORT_MESSAGE = /fetch failed|terminated|network|socket|aborted/i;
