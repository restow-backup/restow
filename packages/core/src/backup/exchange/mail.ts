/**
 * Mail phase: folder tree, per-folder message delta, MIME download.
 *
 * Per folder the engine keeps the delta link of the last completed enumeration
 * (docs/MICROSOFT.md, per-folder delta tokens). A 410 Gone resyncs
 * that folder alone: the delta helper drops the link and enumerates the folder
 * from scratch, and anything the fresh enumeration does not list is removed.
 * Folders are processed one after the other: Graph's limit is per mailbox, so
 * parallelism belongs across mailboxes (separate jobs), not within one.
 *
 * Content is fetched only when it can have changed. Flag, read-state and
 * category changes bump `lastModifiedDateTime` but never the MIME, so a delta
 * entry whose content fingerprint matches the stored object only refreshes the
 * metadata. Messages whose MIME export Graph refuses are stored as Graph JSON
 * plus one object per attachment, recorded together or not at all.
 *
 * Envelope metadata (subject, from, to, cc, hasAttachments) comes straight off
 * every delta entry, so it stays current for anything Graph delta reports as
 * changed. A message the mailbox has not touched is never even mentioned by
 * delta and so keeps whatever metadata (envelope included) its manifest object
 * already carries until it next changes: unlike the IMAP engine, there is no
 * per-item backfill call here, on purpose (no Graph call per carried-forward
 * item) - except once, right after an upgrade that widened the delta
 * `$select`, when state.ts/engine.ts reset every folder to a full
 * enumeration so `mailMetadata` sees the new properties on every message, not
 * only the ones that happened to change. `protection` is different again: it
 * needs the downloaded bytes, so it is only (re)detected when the content is
 * actually fetched and otherwise carried forward as content metadata (see
 * CONTENT_METADATA below).
 */
import { createHash } from "node:crypto";
import { type Readable, Transform, pipeline } from "node:stream";
import type { Message, Recipient } from "@microsoft/microsoft-graph-types";
import { JobAbortedError } from "../../engine/chunkstore.js";
import { type DeltaMode, RecordDeltaTokenStore, isRemoved } from "../../graph/delta.js";
import {
  MESSAGE_DELTA_SELECT,
  type MailFolderNode,
  type MessageContent,
  type MessageDeltaEntry,
  type WellKnownFolderName,
  fetchMessageContent,
  getMessage,
  listMailFolderTree,
  messagesDelta,
} from "../../graph/resources/mail.js";
import type { ManifestObject } from "../../manifest.js";
import {
  MAIL_ROOT,
  assignFolderPaths,
  attachmentObjectPath,
  attachmentsFolderOf,
  displayFolderPath,
  mailJsonObjectPath,
  mailObjectPath,
  rebasePath,
} from "./paths.js";
import {
  type BackupRun,
  EXCHANGE_PHASES,
  FOLDERS_GROUP,
  type FetchedObject,
  ItemError,
  MESSAGE_FORMAT,
  META,
  OBJECT_TYPES,
  isItemLevelError,
  isVanished,
  mailGroup,
  toMailboxAccessError,
} from "./run.js";
import type { MailFolderState } from "./state.js";
import { toMillis } from "./time.js";

/** Properties added to the documented delta `$select` for change detection and restore. */
export const MAIL_EXTRA_SELECT = ["isDraft", "bodyPreview", "importance"] as const;

/** Virtual folders that only reference messages stored elsewhere. */
export const DEFAULT_SKIPPED_FOLDERS: ReadonlySet<WellKnownFolderName> = new Set(["searchfolders"]);

export type MailDeltaEntry = MessageDeltaEntry &
  Partial<Pick<Message, (typeof MAIL_EXTRA_SELECT)[number]>>;

export interface MailPhaseOptions {
  readonly includeHiddenFolders: boolean;
  readonly skipWellKnownFolders: ReadonlySet<WellKnownFolderName>;
  readonly deltaPageSize: number;
}

export interface PlannedFolder {
  readonly node: MailFolderNode;
  /** Object path, e.g. `mail/Inbox/Projects`. */
  readonly path: string;
  /** Folder names from the mailbox root, e.g. `Inbox/Projects` (the `folderPath` metadata). */
  readonly displayPath: string;
  /** Well-known name of the top-level folder this folder lives in (`inbox` for Inbox/Projects). */
  readonly topWellKnownName: WellKnownFolderName | null;
}

const FOLDER_KIND_MAIL = "mail";
const FOLDER_KIND_ATTACHMENTS = "attachments";
const REFERENCE_ATTACHMENT = "#microsoft.graph.referenceAttachment";

/**
 * Drop skipped subtrees and give every remaining folder its object path,
 * display path and top-level well-known name. The tree arrives breadth first,
 * so parents are always planned before children.
 */
export function planMailFolders(
  tree: readonly MailFolderNode[],
  skip: ReadonlySet<WellKnownFolderName>,
): PlannedFolder[] {
  const skipped = new Set<string>();
  const kept: MailFolderNode[] = [];
  for (const node of tree) {
    const skipSelf = node.wellKnownName !== null && skip.has(node.wellKnownName);
    const skipParent = node.parentFolderId !== null && skipped.has(node.parentFolderId);
    if (skipSelf || skipParent) {
      skipped.add(node.id);
      continue;
    }
    kept.push(node);
  }
  const paths = assignFolderPaths(
    MAIL_ROOT,
    kept.map((node) => ({ id: node.id, parentId: node.parentFolderId, name: node.displayName })),
  );
  const topWellKnown = new Map<string, WellKnownFolderName | null>();
  return kept.map((node) => {
    const parentId = node.parentFolderId;
    const top =
      parentId !== null && topWellKnown.has(parentId)
        ? (topWellKnown.get(parentId) ?? null)
        : node.wellKnownName;
    topWellKnown.set(node.id, top);
    return {
      node,
      path: paths.get(node.id) ?? MAIL_ROOT,
      displayPath: displayFolderPath(node.path),
      topWellKnownName: top,
    };
  });
}

/**
 * Digest of the properties whose change implies different MIME bytes. Flags,
 * read state, categories and importance are deliberately absent. A draft can
 * be edited anywhere in its body, so for drafts every modification counts.
 */
export function contentFingerprint(entry: MailDeltaEntry): string {
  const parts = [
    entry.subject ?? "",
    entry.hasAttachments === true,
    entry.isDraft === true,
    entry.bodyPreview ?? "",
    entry.isDraft === true ? (entry.lastModifiedDateTime ?? "") : "",
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** Where an object lives: the metadata every mail-area object carries. */
function withLocation(
  metadata: Record<string, string>,
  folder: PlannedFolder,
): Record<string, string> {
  const located: Record<string, string> = {
    ...metadata,
    [META.folderId]: folder.node.id,
    [META.folderPath]: folder.displayPath,
  };
  if (folder.topWellKnownName) {
    located[META.wellKnownFolder] = folder.topWellKnownName;
  } else {
    delete located[META.wellKnownFolder];
  }
  return located;
}

function folderObject(folder: PlannedFolder): ManifestObject {
  const metadata: Record<string, string> = {
    [META.folderKind]: FOLDER_KIND_MAIL,
    parentFolderId: folder.node.parentFolderId ?? "",
    displayName: folder.node.displayName,
    isHidden: String(folder.node.isHidden),
    totalItemCount: String(folder.node.totalItemCount),
  };
  if (folder.node.wellKnownName) {
    metadata[META.wellKnownName] = folder.node.wellKnownName;
  }
  return {
    path: folder.path,
    id: folder.node.id,
    type: OBJECT_TYPES.folder,
    size: 0,
    mtime: 0,
    chunks: [],
    metadata: withLocation(metadata, folder),
  };
}

// ---------------------------------------------------------------------------
// Envelope metadata (mail restore explorer contract shared with the IMAP
// engine): from, to, cc and protection, the same metadata keys with the same
// meaning in both engines.

/** Formatted address lists are capped here; the *Count metadata carries the full total. */
const MAX_ADDRESS_LIST_ENTRIES = 20;

/**
 * Quote a display name that contains an RFC 5322 special (a bare comma most
 * commonly, e.g. a "Last, First" directory name), so 'Flores, Lucas <l@x>,
 * Doe, John <j@x>' still splits unambiguously downstream.
 */
function quoteDisplayName(name: string): string {
  return /[,;:<>()[\]@\\"]/.test(name) ? `"${name.replace(/[\\"]/g, "\\$&")}"` : name;
}

/** 'Display Name <address>' or the bare address (or the bare name if Graph omitted the address). */
function formatRecipient(recipient: Recipient | null | undefined): string | null {
  const name = recipient?.emailAddress?.name?.trim();
  const address = recipient?.emailAddress?.address?.trim();
  if (name && address) {
    return `${quoteDisplayName(name)} <${address}>`;
  }
  return address || name || null;
}

interface FormattedRecipientList {
  readonly formatted: string[];
  readonly count: number;
}

/** Formats up to {@link MAX_ADDRESS_LIST_ENTRIES} recipients; `count` is the full total. */
function formatRecipientList(recipients: Recipient[] | null | undefined): FormattedRecipientList {
  const entries = recipients ?? [];
  const formatted: string[] = [];
  for (const recipient of entries) {
    if (formatted.length >= MAX_ADDRESS_LIST_ENTRIES) {
      break;
    }
    const value = formatRecipient(recipient);
    if (value) {
      formatted.push(value);
    }
  }
  return { formatted, count: entries.length };
}

/** How a message is protected against casual reading, detected without a full MIME parse. */
export type MessageProtection = "rights-protected" | "smime-encrypted";

const RPMSG_CONTENT_TYPE = "application/x-microsoft-rpmsg-message";
const PKCS7_MIME_TYPES = new Set(["application/pkcs7-mime", "application/x-pkcs7-mime"]);
const ENVELOPED_SMIME_TYPES = new Set(["enveloped-data", "authenveloped-data"]);

/**
 * Protection markers from a top-level Content-Type header value (no full MIME
 * parse): rights-protected (IRM/Purview) and S/MIME enveloped data. An
 * explicit `smime-type` is authoritative: opaque signing (RFC 8551 3.5.2,
 * `smime-type=signed-data`) is not encrypted even though it conventionally
 * also names the part `smime.p7m`, so the name is only a fallback for a part
 * with no `smime-type` at all.
 */
function protectionFromContentType(value: string): MessageProtection | null {
  const type = (value.match(/^\s*([a-z0-9.+-]+\/[a-z0-9.+-]+)/i)?.[1] ?? "").toLowerCase();
  if (type === RPMSG_CONTENT_TYPE) {
    return "rights-protected";
  }
  if (PKCS7_MIME_TYPES.has(type)) {
    const smimeType = value.match(/smime-type\s*=\s*"?([a-z-]+)"?/i)?.[1];
    if (smimeType !== undefined) {
      return ENVELOPED_SMIME_TYPES.has(smimeType.toLowerCase()) ? "smime-encrypted" : null;
    }
    const name = (value.match(/(?:name|filename)\s*=\s*"?([^";]+)"?/i)?.[1] ?? "")
      .trim()
      .toLowerCase();
    if (name === "smime.p7m") {
      return "smime-encrypted";
    }
  }
  return null;
}

/** True for the `Content-Class: rpmsg.message` header real IRM/Purview exports carry. */
function isRpmsgContentClass(value: string | null): boolean {
  return value !== null && value.trim().toLowerCase() === "rpmsg.message";
}

/**
 * Protection from the oversized-message JSON fallback, whose headers Graph
 * already parsed out: the Content-Type sniff above, plus Content-Class for
 * IRM/Purview mail exported as ordinary `multipart/mixed` with a
 * `message.rpmsg` attachment (real exports rarely use a top-level rpmsg
 * Content-Type).
 */
function protectionFromHeaders(
  headers: Message["internetMessageHeaders"] | undefined,
): MessageProtection | null {
  const value = (name: string) =>
    headers?.find((header) => header.name?.toLowerCase() === name)?.value ?? null;
  const contentType = value("content-type");
  const fromContentType = contentType ? protectionFromContentType(contentType) : null;
  if (fromContentType) {
    return fromContentType;
  }
  return isRpmsgContentClass(value("content-class")) ? "rights-protected" : null;
}

/** Bytes of a downloaded MIME sniffed to find its top-level Content-Type header, no full parse. */
const HEADER_SNIFF_BYTES = 64 * 1024;

function headerBlockEnd(text: string): number {
  const crlf = text.indexOf("\r\n\r\n");
  const lf = text.indexOf("\n\n");
  if (crlf === -1 && lf === -1) {
    return text.length;
  }
  if (crlf === -1 || lf === -1) {
    return Math.max(crlf, lf);
  }
  return Math.min(crlf, lf);
}

/** The (folded) value of a top-level header, or null when it is not present in the sniffed head. */
function extractTopLevelHeader(head: Buffer, name: string): string | null {
  const text = head.toString("latin1");
  const lines = text.slice(0, headerBlockEnd(text)).split(/\r\n|\n/);
  const prefix = `${name.toLowerCase()}:`;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().startsWith(prefix)) {
      continue;
    }
    const parts = [lines[i].slice(prefix.length)];
    let next = i + 1;
    while (next < lines.length && /^[ \t]/.test(lines[next])) {
      parts.push(lines[next].trim());
      next++;
    }
    return parts.join(" ").trim();
  }
  return null;
}

/**
 * Wrap a MIME stream so its first {@link HEADER_SNIFF_BYTES} can be inspected
 * once it has fully passed through, without buffering the whole message or
 * reading it twice. `header` resolves once the wrapped stream ends (or the
 * cap is reached, whichever comes first).
 */
function sniffMimeHeader(source: Readable): { stream: Readable; header: Promise<Buffer> } {
  let captured = Buffer.alloc(0);
  let resolveHeader!: (value: Buffer) => void;
  const header = new Promise<Buffer>((resolve) => {
    resolveHeader = resolve;
  });
  const sniff = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (captured.length < HEADER_SNIFF_BYTES) {
        captured = Buffer.concat([
          captured,
          chunk.subarray(0, HEADER_SNIFF_BYTES - captured.length),
        ]);
        if (captured.length >= HEADER_SNIFF_BYTES) {
          resolveHeader(captured);
        }
      }
      callback(null, chunk);
    },
    flush(callback) {
      resolveHeader(captured);
      callback();
    },
  });
  // pipeline (not a bare .pipe()) so an error on either side destroys both ends.
  pipeline(source, sniff, () => {
    // The error, if any, already surfaces to whoever reads `stream`.
  });
  return { stream: sniff, header };
}

/**
 * Write a recipient list only when this delta entry actually carries the
 * property. A carried-forward message can be processed while its folder's
 * stored delta link still predates a `$select` change mid-upgrade (state.ts
 * MAIL_SELECT_VERSION resets it before the next run, but this guards the
 * transition itself): falling back to whatever is already stored beats
 * overwriting it with an empty list and a false "0 recipients".
 */
function assignRecipientList(
  metadata: Record<string, string>,
  listKey: string,
  countKey: string,
  recipients: Recipient[] | null | undefined,
  previous: Record<string, string> | undefined,
): void {
  if (recipients !== undefined) {
    const list = formatRecipientList(recipients);
    metadata[listKey] = list.formatted.join(", ");
    metadata[countKey] = String(list.count);
    return;
  }
  if (previous?.[listKey] !== undefined) {
    metadata[listKey] = previous[listKey];
    metadata[countKey] = previous[countKey] ?? "0";
  }
}

/**
 * The metadata that a restore needs to put a message back the way it was.
 * `existing` is the object's current metadata (if any), used only as a
 * fallback for from/to/cc when `entry` itself does not carry them (see
 * {@link assignRecipientList}).
 */
export function mailMetadata(
  entry: MailDeltaEntry,
  folder: PlannedFolder,
  existing?: ManifestObject,
): Record<string, string> {
  const previous = existing?.metadata;
  const metadata: Record<string, string> = {
    [META.subject]: entry.subject ?? "",
    receivedDateTime: entry.receivedDateTime ?? "",
    lastModifiedDateTime: entry.lastModifiedDateTime ?? "",
    [META.isRead]: String(entry.isRead === true),
    isDraft: String(entry.isDraft === true),
    [META.flagStatus]: entry.flag?.flagStatus ?? "notFlagged",
    [META.categories]: JSON.stringify(entry.categories ?? []),
    [META.hasAttachments]: String(entry.hasAttachments === true),
  };
  assignRecipientList(metadata, META.to, META.toCount, entry.toRecipients, previous);
  assignRecipientList(metadata, META.cc, META.ccCount, entry.ccRecipients, previous);
  if (entry.from !== undefined) {
    const from = formatRecipient(entry.from);
    if (from) {
      metadata[META.from] = from;
    }
  } else if (previous?.[META.from] !== undefined) {
    metadata[META.from] = previous[META.from];
  }
  if (entry.importance) {
    metadata[META.importance] = entry.importance;
  }
  if (entry.internetMessageId) {
    metadata[META.messageId] = entry.internetMessageId;
  }
  return withLocation(metadata, folder);
}

// ---------------------------------------------------------------------------
// Folder reconciliation

function folderState(folder: PlannedFolder): MailFolderState {
  return {
    path: folder.path,
    displayPath: folder.displayPath,
    name: folder.node.displayName,
    parentId: folder.node.parentFolderId,
    ...(folder.node.wellKnownName ? { wellKnownName: folder.node.wellKnownName } : {}),
    ...(folder.topWellKnownName ? { topWellKnownName: folder.topWellKnownName } : {}),
    ...(folder.node.isHidden ? { hidden: true } : {}),
  };
}

function locationChanged(previous: MailFolderState, folder: PlannedFolder): boolean {
  return (
    previous.path !== folder.path ||
    previous.displayPath !== folder.displayPath ||
    (previous.topWellKnownName ?? null) !== folder.topWellKnownName
  );
}

/** A mail-area object moved to `folder`: new path, new location metadata, rebased `messagePath`. */
function relocated(
  object: ManifestObject,
  path: string,
  folder: PlannedFolder,
  from: string,
  to: string,
) {
  const metadata = withLocation(object.metadata ?? {}, folder);
  const messagePath = metadata[META.messagePath];
  if (messagePath !== undefined) {
    metadata[META.messagePath] = rebasePath(messagePath, from, to);
  }
  return { ...object, path, metadata };
}

/**
 * Bring the folder objects and the folder map in line with the current tree:
 * objects of vanished folders go, objects of renamed or moved folders are
 * re-pathed (their bytes stay), every folder gets a fresh folder object.
 */
export function reconcileMailFolders(run: BackupRun, planned: readonly PlannedFolder[]): void {
  const plannedById = new Map(planned.map((folder) => [folder.node.id, folder]));

  for (const group of run.index.groups("mail:")) {
    if (!plannedById.has(group.slice("mail:".length))) {
      dropGroup(run, group);
    }
  }
  for (const folderId of Object.keys(run.state.mailFolders)) {
    if (!plannedById.has(folderId)) {
      forgetFolder(run, folderId);
    }
  }
  // Folder objects are swept on their own too, in case the state was reset.
  for (const member of run.index.members(FOLDERS_GROUP)) {
    const isMailFolder = member.metadata?.[META.folderKind] === FOLDER_KIND_MAIL;
    if (isMailFolder && member.id !== undefined && !plannedById.has(member.id)) {
      run.index.removePath(member.path);
    }
  }

  // Two phases so that swapped names (A -> B, B -> A) never overwrite each other.
  const moves: ManifestObject[] = [];
  for (const folder of planned) {
    const previous = run.state.mailFolders[folder.node.id];
    if (!previous || !locationChanged(previous, folder)) {
      continue;
    }
    for (const member of run.index.members(mailGroup(folder.node.id))) {
      run.index.removePath(member.path);
      moves.push(
        relocated(
          member,
          rebasePath(member.path, previous.path, folder.path),
          folder,
          previous.path,
          folder.path,
        ),
      );
    }
  }
  for (const moved of moves) {
    run.index.put(moved);
    if (moved.type === OBJECT_TYPES.mail) {
      run.counters.updated++;
    }
  }
  if (moves.length > 0) {
    run.logger.info("re-pathed objects of renamed or moved folders", { objects: moves.length });
  }

  const folders: Record<string, MailFolderState> = {};
  for (const folder of planned) {
    run.index.put(folderObject(folder));
    folders[folder.node.id] = folderState(folder);
  }
  run.state.mailFolders = folders;
}

/** Remove every object of a mail folder group (the folder is gone). */
function dropGroup(run: BackupRun, group: string): void {
  for (const member of run.index.members(group)) {
    if (member.type === OBJECT_TYPES.mail) {
      run.removeItem(member);
    } else {
      run.index.removePath(member.path);
    }
  }
}

/** Forget a folder that no longer exists: its folder object, delta link and progress. */
function forgetFolder(run: BackupRun, folderId: string): void {
  const folderObject = run.index.get(OBJECT_TYPES.folder, folderId);
  if (folderObject) {
    run.index.removePath(folderObject.path);
  }
  delete run.state.mailFolders[folderId];
  delete run.state.mailDeltaLinks[folderId];
  delete run.state.mailRetry[folderId];
  delete run.deltaTokens[folderId];
  const done = run.progress.completedFolders.indexOf(folderId);
  if (done >= 0) {
    run.progress.completedFolders.splice(done, 1);
  }
}

// ---------------------------------------------------------------------------
// Messages

function isJsonMessage(object: ManifestObject): boolean {
  return object.metadata?.[META.format] === MESSAGE_FORMAT.json;
}

/** The attachments and the attachments folder stored with a JSON message. */
function ridersOf(run: BackupRun, message: ManifestObject): ManifestObject[] {
  if (message.id === undefined || !isJsonMessage(message)) {
    return [];
  }
  const folderId = message.metadata?.[META.folderId] ?? "";
  return run.index
    .members(mailGroup(folderId))
    .filter((member) => member.metadata?.[META.messageItemId] === message.id);
}

function removeMessage(run: BackupRun, message: ManifestObject): void {
  run.removeItem(message, ridersOf(run, message));
}

/**
 * Metadata of a stored message that describes its bytes rather than its
 * state. `protection` lives here (not in {@link mailMetadata}) because
 * detecting it needs the downloaded bytes: a carried-forward message keeps
 * whatever this engine found the last time its content was actually fetched.
 */
const CONTENT_METADATA = [
  META.format,
  META.contentType,
  META.fingerprint,
  META.attachmentCount,
  META.referenceAttachments,
  META.protection,
] as const;

/** Refresh a stored message without fetching its bytes again. */
function carryMessage(
  run: BackupRun,
  folder: PlannedFolder,
  entry: MailDeltaEntry,
  existing: ManifestObject,
  mtime: number,
): void {
  const json = isJsonMessage(existing);
  const path = json
    ? mailJsonObjectPath(folder.path, entry.subject, entry.id)
    : mailObjectPath(folder.path, entry.subject, entry.id);
  const metadata = mailMetadata(entry, folder, existing);
  for (const key of CONTENT_METADATA) {
    const value = existing.metadata?.[key];
    if (value !== undefined) {
      metadata[key] = value;
    }
  }
  const riders = ridersOf(run, existing);
  const oldPath = existing.path;
  run.carryForward(existing, { path, mtime, metadata });
  if (riders.length > 0 && oldPath !== path) {
    // A new subject renames the message; its attachments folder follows.
    const from = attachmentsFolderOf(oldPath);
    const to = attachmentsFolderOf(path);
    for (const rider of riders) {
      run.index.removePath(rider.path);
    }
    for (const rider of riders) {
      const moved = relocated(rider, rebasePath(rider.path, from, to), folder, oldPath, path);
      run.index.put(moved);
    }
  }
}

function attachmentsFolderObject(
  path: string,
  folder: PlannedFolder,
  messageId: string,
): ManifestObject {
  return {
    path,
    id: `${messageId}/attachments`,
    type: OBJECT_TYPES.folder,
    size: 0,
    mtime: 0,
    chunks: [],
    metadata: withLocation(
      { [META.folderKind]: FOLDER_KIND_ATTACHMENTS, [META.messageItemId]: messageId },
      folder,
    ),
  };
}

type JsonContent = Extract<MessageContent, { kind: "parts" }>;

/** Failure reason when an attachment 404s while its message still exists (no user content). */
const ATTACHMENT_REMOVED =
  "an attachment was removed from the message while it was being backed up";

/**
 * Write a JSON message and all of its attachments to the chunk store, then
 * record them together: a message is either complete in the snapshot or keeps
 * its previous version. Link attachments carry no content Graph v1.0 exposes;
 * their names are kept on the message instead of pretending to be files.
 */
async function storeJsonMessage(
  run: BackupRun,
  folder: PlannedFolder,
  entry: MailDeltaEntry,
  existing: ManifestObject | undefined,
  content: JsonContent,
  base: { mtime: number; metadata: Record<string, string> },
): Promise<void> {
  const messagePath = mailJsonObjectPath(folder.path, entry.subject, entry.id);
  const attachmentsFolder = attachmentsFolderOf(messagePath);
  const messageContent = await run.writeContent(
    Buffer.from(JSON.stringify(content.message), "utf8"),
  );

  const attachments: FetchedObject[] = [];
  const references: string[] = [];
  for (const attachment of content.attachments) {
    run.throwIfAborted();
    const meta = attachment.meta;
    if (meta["@odata.type"] === REFERENCE_ATTACHMENT) {
      references.push(meta.name ?? "");
      continue;
    }
    let written: FetchedObject["content"];
    try {
      written = await run.writeContent(await attachment.open());
    } catch (error) {
      throw isVanished(error) ? new ItemError(ATTACHMENT_REMOVED, { cause: error }) : error;
    }
    attachments.push({
      object: {
        path: attachmentObjectPath(attachmentsFolder, meta.name, meta.id),
        id: `${entry.id}/${meta.id}`,
        type: OBJECT_TYPES.attachment,
        mtime: toMillis(meta.lastModifiedDateTime) || base.mtime,
        metadata: withLocation(
          {
            [META.messageItemId]: entry.id,
            [META.messagePath]: messagePath,
            [META.name]: meta.name ?? "",
            [META.contentType]: meta.contentType ?? "application/octet-stream",
            [META.isInline]: String(meta.isInline === true),
            attachmentType: meta["@odata.type"] ?? "",
            declaredSize: String(meta.size ?? ""),
          },
          folder,
        ),
      },
      content: written,
    });
  }

  const metadata: Record<string, string> = {
    ...base.metadata,
    [META.format]: MESSAGE_FORMAT.json,
    [META.contentType]: "application/json",
    [META.attachmentCount]: String(attachments.length),
  };
  if (references.length > 0) {
    metadata[META.referenceAttachments] = JSON.stringify(references);
  }

  if (existing) {
    for (const rider of ridersOf(run, existing)) {
      run.index.removePath(rider.path);
    }
  }
  if (attachments.length > 0) {
    run.index.put(attachmentsFolderObject(attachmentsFolder, folder, entry.id));
  }
  run.recordFetched([
    {
      object: {
        path: messagePath,
        id: entry.id,
        type: OBJECT_TYPES.mail,
        mtime: base.mtime,
        metadata,
      },
      content: messageContent,
    },
    ...attachments,
  ]);
}

/** Fetch a message's content and store it as MIME, or as JSON when Graph refuses the MIME. */
async function fetchMessage(
  run: BackupRun,
  folder: PlannedFolder,
  entry: MailDeltaEntry,
  existing: ManifestObject | undefined,
  mtime: number,
  fingerprint: string,
): Promise<void> {
  const content = await fetchMessageContent(run.client, run.userId, entry.id);
  const metadata: Record<string, string> = {
    ...mailMetadata(entry, folder, existing),
    [META.fingerprint]: fingerprint,
  };

  if (content.kind === "parts") {
    const protection = protectionFromHeaders(content.message.internetMessageHeaders);
    if (protection) {
      metadata[META.protection] = protection;
    }
    await storeJsonMessage(run, folder, entry, existing, content, { mtime, metadata });
    return;
  }
  const { stream, header } = sniffMimeHeader(content.stream);
  const written = await run.writeContent(stream);
  const head = await header;
  const protection =
    protectionFromContentType(extractTopLevelHeader(head, "content-type") ?? "") ??
    (isRpmsgContentClass(extractTopLevelHeader(head, "content-class")) ? "rights-protected" : null);
  if (protection) {
    metadata[META.protection] = protection;
  }
  if (existing) {
    // An earlier JSON version leaves its attachments behind otherwise.
    for (const rider of ridersOf(run, existing)) {
      run.index.removePath(rider.path);
    }
  }
  run.recordFetched([
    {
      object: {
        path: mailObjectPath(folder.path, entry.subject, entry.id),
        id: entry.id,
        type: OBJECT_TYPES.mail,
        mtime,
        metadata: {
          ...metadata,
          [META.format]: MESSAGE_FORMAT.mime,
          [META.contentType]: "message/rfc822",
        },
      },
      content: written,
    },
  ]);
}

async function storeMessage(
  run: BackupRun,
  folder: PlannedFolder,
  entry: MailDeltaEntry,
): Promise<void> {
  const fingerprint = contentFingerprint(entry);
  const mtime = toMillis(entry.lastModifiedDateTime) || toMillis(entry.receivedDateTime);
  const existing = run.index.get(OBJECT_TYPES.mail, entry.id);
  if (run.reusable(existing, fingerprint)) {
    carryMessage(run, folder, entry, existing, mtime);
    return;
  }
  await fetchMessage(run, folder, entry, existing, mtime, fingerprint);
}

type EntryOutcome = "stored" | "removed" | "vanished" | "failed";

/** A message deleted in the mailbox after it was listed: drop the stored copy, if any. */
function messageVanished(run: BackupRun, id: string, itemRef: string, seen: Set<string>): void {
  seen.delete(id);
  const existing = run.index.get(OBJECT_TYPES.mail, id);
  if (existing) {
    removeMessage(run, existing);
  }
  run.vanished(itemRef);
}

async function processEntry(
  run: BackupRun,
  folder: PlannedFolder,
  entry: MailDeltaEntry,
  seen: Set<string>,
): Promise<EntryOutcome> {
  if (isRemoved(entry)) {
    const existing = run.index.get(OBJECT_TYPES.mail, entry.id);
    if (existing) {
      removeMessage(run, existing);
    }
    seen.delete(entry.id);
    run.reporter.advance(1, 0);
    return "removed";
  }
  seen.add(entry.id);
  const itemRef = mailObjectPath(folder.path, entry.subject, entry.id);
  try {
    await storeMessage(run, folder, entry);
    return "stored";
  } catch (error) {
    if (isVanished(error)) {
      messageVanished(run, entry.id, itemRef, seen);
      return "vanished";
    }
    if (!isItemLevelError(error)) {
      throw error;
    }
    // The previous version (if any) stays in the snapshot: the last good copy.
    run.fail(itemRef, error);
    return "failed";
  }
}

/** Properties fetched for a message retried outside the delta (the delta entry's shape). */
const RETRY_SELECT = [...MESSAGE_DELTA_SELECT, ...MAIL_EXTRA_SELECT] as const;

/**
 * Past this many failed messages in one folder, the folder is enumerated in
 * full on the next run instead of retrying ids one by one.
 */
export const MAX_RETRY_IDS_PER_FOLDER = 1000;

/**
 * Fetch again the messages of a folder that failed in the previous run. The
 * folder's delta link has moved past them, so without this a message that
 * failed once would stay missing (or stale) until it changes again.
 */
async function retryFailedMessages(
  run: BackupRun,
  folder: PlannedFolder,
  ids: readonly string[],
  seen: Set<string>,
  failed: Set<string>,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  run.logger.info("retrying messages that failed in the previous run", {
    folderId: folder.node.id,
    messages: ids.length,
  });
  run.expectMore(ids.length);
  for (const id of ids) {
    run.throwIfAborted();
    const existing = run.index.get(OBJECT_TYPES.mail, id);
    const itemRef = existing?.path ?? mailObjectPath(folder.path, null, id);
    let message: Message;
    try {
      message = await getMessage(run.client, run.userId, id, { select: RETRY_SELECT });
    } catch (error) {
      if (isVanished(error)) {
        messageVanished(run, id, itemRef, seen);
      } else if (isItemLevelError(error)) {
        run.fail(itemRef, error);
        failed.add(id);
      } else {
        throw error;
      }
      continue;
    }
    if (message.parentFolderId && message.parentFolderId !== folder.node.id) {
      // Moved meanwhile: the delta of the folder it lives in now covers it.
      run.reporter.advance(1, 0);
      continue;
    }
    const outcome = await processEntry(run, folder, { ...message, id } as MailDeltaEntry, seen);
    if (outcome === "failed") {
      failed.add(id);
    }
    run.setPosition(folder.node.id, id);
    await run.maybeCheckpoint();
  }
}

/** Remember this run's failed messages of a folder for the next run. */
function rememberFailures(run: BackupRun, folderId: string, failed: ReadonlySet<string>): void {
  if (failed.size === 0) {
    delete run.state.mailRetry[folderId];
    return;
  }
  if (failed.size > MAX_RETRY_IDS_PER_FOLDER) {
    // Too many to track one by one: the next run enumerates the whole folder again.
    run.logger.warn("too many failed messages to retry individually, folder will be resynced", {
      folderId,
      failed: failed.size,
    });
    delete run.state.mailRetry[folderId];
    delete run.state.mailDeltaLinks[folderId];
    return;
  }
  run.state.mailRetry[folderId] = [...failed];
}

/** After a full enumeration of a folder, drop what it no longer lists. */
function removeUnseen(run: BackupRun, folder: PlannedFolder, seen: ReadonlySet<string>): void {
  for (const member of run.index.members(mailGroup(folder.node.id))) {
    if (member.type === OBJECT_TYPES.mail) {
      if (member.id !== undefined && !seen.has(member.id)) {
        removeMessage(run, member);
      }
      continue;
    }
    const owner = member.metadata?.[META.messageItemId];
    if (owner === undefined || !seen.has(owner)) {
      run.index.removePath(member.path);
    }
  }
}

/** Enumerate one folder's delta and store what changed; checkpoints at the end. */
export async function syncMailFolder(
  run: BackupRun,
  folder: PlannedFolder,
  options: MailPhaseOptions,
): Promise<void> {
  const folderId = folder.node.id;
  const logger = run.logger.child({ folderId });
  const before = { ...run.counters };
  run.report(EXCHANGE_PHASES.mail);
  run.setPosition(folderId);

  const store = new RecordDeltaTokenStore(run.state.mailDeltaLinks);
  /** Messages the folder currently holds, as far as this enumeration has seen. */
  const seen = new Set<string>();
  /** Every message id the delta mentioned, removals included. */
  const listed = new Set<string>();
  const failed = new Set<string>();
  let mode: DeltaMode = "incremental";
  let countedFull = false;

  const generator = messagesDelta(run.client, store, run.userId, folderId, {
    key: folderId,
    extraSelect: [...MAIL_EXTRA_SELECT],
    maxPageSize: options.deltaPageSize,
    onResync: () => {
      logger.info("delta link no longer valid, enumerating this folder from scratch");
      run.report(EXCHANGE_PHASES.resync);
    },
  });

  let next = await generator.next();
  while (!next.done) {
    const batch = next.value;
    if (batch.reset) {
      // A resync started mid-run: the full enumeration that follows is the truth.
      seen.clear();
      listed.clear();
      failed.clear();
    }
    mode = batch.mode;
    if (mode === "incremental") {
      run.expectMore(batch.items.length);
    } else if (!countedFull) {
      run.expectMore(folder.node.totalItemCount);
      countedFull = true;
    }
    for (const entry of batch.items as MailDeltaEntry[]) {
      run.throwIfAborted();
      listed.add(entry.id);
      const outcome = await processEntry(run, folder, entry, seen);
      if (outcome === "failed") {
        failed.add(entry.id);
      } else {
        failed.delete(entry.id);
      }
      run.setPosition(folderId, entry.id);
      await run.maybeCheckpoint();
    }
    next = await generator.next();
  }

  if (mode === "incremental") {
    const pending = (run.state.mailRetry[folderId] ?? []).filter((id) => !listed.has(id));
    await retryFailedMessages(run, folder, pending, seen, failed);
  } else {
    // A full enumeration lists everything, earlier failures included.
    removeUnseen(run, folder, seen);
  }
  rememberFailures(run, folderId, failed);
  run.deltaTokens[folderId] = next.value.deltaLink;
  run.progress.completedFolders.push(folderId);
  run.setPosition(undefined);
  run.report(EXCHANGE_PHASES.mail);
  await run.checkpoint();

  logger.info("mail folder done", {
    mode,
    pages: next.value.pages,
    entries: next.value.items,
    written: run.counters.written - before.written,
    updated: run.counters.updated - before.updated,
    unchanged: run.counters.unchanged - before.unchanged,
    removed: run.counters.removed - before.removed,
    vanished: run.counters.vanished - before.vanished,
    failed: run.counters.failed - before.failed,
  });
}

/** The whole mail phase: tree, reconciliation, one delta run per folder. */
export async function backupMail(run: BackupRun, options: MailPhaseOptions): Promise<void> {
  run.enterPhase("mail", EXCHANGE_PHASES.folders);
  let tree: MailFolderNode[];
  try {
    tree = await listMailFolderTree(run.client, run.userId, {
      includeHidden: options.includeHiddenFolders,
    });
  } catch (error) {
    throw toMailboxAccessError(error, "mail folders");
  }
  const planned = planMailFolders(tree, options.skipWellKnownFolders);
  reconcileMailFolders(run, planned);
  run.logger.info("mail folders enumerated", {
    folders: planned.length,
    skipped: tree.length - planned.length,
    pending: planned.filter((f) => !run.progress.completedFolders.includes(f.node.id)).length,
  });
  await run.checkpoint();

  for (const folder of planned) {
    run.throwIfAborted();
    if (run.progress.completedFolders.includes(folder.node.id)) {
      continue;
    }
    try {
      await syncMailFolder(run, folder, options);
    } catch (error) {
      if (error instanceof JobAbortedError) {
        throw error;
      }
      run.setPosition(undefined);
      if (isVanished(error)) {
        // Deleted between the tree listing and its enumeration: gone from the mailbox.
        run.logger.info("mail folder deleted while the backup ran", { folderId: folder.node.id });
        dropGroup(run, mailGroup(folder.node.id));
        forgetFolder(run, folder.node.id);
        continue;
      }
      if (!isItemLevelError(error)) {
        throw error;
      }
      // A folder that cannot be enumerated is one failure, not a failed mailbox;
      // its objects stay as they were and its delta link is kept for the next run.
      run.fail(folder.path, error);
    }
  }
}
