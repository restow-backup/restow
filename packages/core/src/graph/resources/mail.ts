/**
 * Exchange Online mail resources: folder tree, per-folder message delta, MIME
 * download with the attachment-by-attachment fallback for oversized messages,
 * mailbox settings, and the restore primitives (create from MIME, patch flags,
 * ensure folder path, duplicate check by internetMessageId).
 *
 * The backup format for a message is its MIME (RFC 5322) plus the metadata from
 * the delta entry; flag/category changes only touch metadata (docs/MICROSOFT.md).
 */
import type { Readable } from "node:stream";
import type {
  Attachment,
  FollowupFlag,
  Importance,
  MailFolder,
  MailboxSettings,
  Message,
} from "@microsoft/microsoft-graph-types";
import type { BatchRequest, GraphClient, GraphRequest } from "../client.js";
import { type DeltaBatch, type DeltaSummary, type DeltaTokenStore, syncDelta } from "../delta.js";
import { GraphError, isGraphError, isNotFound } from "../errors.js";
import {
  bodyOrThrow,
  collect,
  odataString,
  paginate,
  query,
  requestOk,
  splitPath,
  stripReadOnly,
  userPath,
} from "./common.js";
import {
  OUTLOOK_FRAGMENT_BOUNDS,
  type UploadOptions,
  type UploadSessionInfo,
  type UploadSource,
  uploadToSession,
} from "./upload-session.js";

// ---------------------------------------------------------------------------
// Folders

export const MAIL_FOLDER_SELECT = [
  "id",
  "displayName",
  "parentFolderId",
  "childFolderCount",
  "totalItemCount",
  "unreadItemCount",
  "isHidden",
] as const;

/**
 * Well-known folder names addressable as `/mailFolders/{name}` in Graph v1.0. The
 * `wellKnownName` property itself is beta-only, so ids are resolved by name.
 */
export const WELL_KNOWN_FOLDER_NAMES = [
  "archive",
  "clutter",
  "conflicts",
  "conversationhistory",
  "deleteditems",
  "drafts",
  "inbox",
  "junkemail",
  "localfailures",
  "msgfolderroot",
  "outbox",
  "recoverableitemsdeletions",
  "scheduled",
  "searchfolders",
  "sentitems",
  "serverfailures",
  "syncissues",
] as const;

export type WellKnownFolderName = (typeof WELL_KNOWN_FOLDER_NAMES)[number];

/** Folder ids by well-known name and the reverse map, for one mailbox. */
export interface WellKnownFolders {
  byName: Map<WellKnownFolderName, string>;
  byId: Map<string, WellKnownFolderName>;
}

const MAIL_FOLDER_PAGE_SIZE = 100;

function folderListQuery(includeHidden: boolean): string {
  return query({
    includeHiddenFolders: includeHidden ? true : undefined,
    $select: MAIL_FOLDER_SELECT.join(","),
    $top: MAIL_FOLDER_PAGE_SIZE,
  });
}

/**
 * Resolve the well-known folders of a mailbox with a single $batch. Names a
 * mailbox does not have (404) are simply absent from the result.
 */
export async function resolveWellKnownFolders(
  client: GraphClient,
  userId: string,
): Promise<WellKnownFolders> {
  const requests: BatchRequest[] = WELL_KNOWN_FOLDER_NAMES.map((name) => ({
    id: name,
    method: "GET",
    url: `${userPath(userId)}/mailFolders/${name}${query({ $select: "id" })}`,
  }));
  const byName = new Map<WellKnownFolderName, string>();
  const byId = new Map<string, WellKnownFolderName>();
  for (const response of await client.batch(requests)) {
    const name = response.id as WellKnownFolderName;
    if (response.status === 404) {
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new GraphError({
        status: response.status,
        method: "GET",
        url: `${userPath(userId)}/mailFolders/${name}`,
        headers: response.headers,
        payload: response.body,
      });
    }
    const id = (response.body as { id?: string } | undefined)?.id;
    if (id) {
      byName.set(name, id);
      byId.set(id, name);
    }
  }
  return { byName, byId };
}

/** One folder of the mailbox tree, with its path from the root. */
export interface MailFolderNode {
  id: string;
  displayName: string;
  parentFolderId: string | null;
  childFolderCount: number;
  totalItemCount: number;
  unreadItemCount: number;
  isHidden: boolean;
  wellKnownName: WellKnownFolderName | null;
  /** Display names from the root down to this folder, e.g. `["Inbox", "Projects"]`. */
  path: string[];
  depth: number;
}

export interface ListMailFolderTreeOptions {
  /** Include hidden folders (default true, the backup wants everything). */
  includeHidden?: boolean;
  /** Pre-resolved well-known folders; resolved on demand when omitted. */
  wellKnown?: WellKnownFolders;
}

type RawFolder = Pick<MailFolder, (typeof MAIL_FOLDER_SELECT)[number]> & { id: string };

/**
 * The full folder tree of a mailbox, breadth first. Child folder listings are
 * fetched through $batch (20 folders per round trip) to respect the per-mailbox
 * throttling budget.
 */
export async function listMailFolderTree(
  client: GraphClient,
  userId: string,
  options: ListMailFolderTreeOptions = {},
): Promise<MailFolderNode[]> {
  const includeHidden = options.includeHidden ?? true;
  const wellKnown = options.wellKnown ?? (await resolveWellKnownFolders(client, userId));
  const suffix = folderListQuery(includeHidden);
  const nodes: MailFolderNode[] = [];

  const toNode = (raw: RawFolder, parent: MailFolderNode | null): MailFolderNode => ({
    id: raw.id,
    displayName: raw.displayName ?? "",
    parentFolderId: raw.parentFolderId ?? parent?.id ?? null,
    childFolderCount: raw.childFolderCount ?? 0,
    totalItemCount: raw.totalItemCount ?? 0,
    unreadItemCount: raw.unreadItemCount ?? 0,
    isHidden: raw.isHidden ?? false,
    wellKnownName: wellKnown.byId.get(raw.id) ?? null,
    path: [...(parent?.path ?? []), raw.displayName ?? ""],
    depth: (parent?.depth ?? -1) + 1,
  });

  let frontier: MailFolderNode[] = [];
  for await (const raw of paginate<RawFolder>(client, `${userPath(userId)}/mailFolders${suffix}`)) {
    const node = toNode(raw, null);
    nodes.push(node);
    frontier.push(node);
  }

  while (frontier.length > 0) {
    const parents = frontier.filter((f) => f.childFolderCount > 0);
    frontier = [];
    if (parents.length === 0) {
      break;
    }
    const byId = new Map(parents.map((parent) => [parent.id, parent]));
    const requests: BatchRequest[] = parents.map((parent) => ({
      id: parent.id,
      method: "GET",
      url: `${userPath(userId)}/mailFolders/${encodeURIComponent(parent.id)}/childFolders${suffix}`,
    }));
    const responses = await client.batch(requests);
    for (const response of responses) {
      const parent = byId.get(response.id);
      if (!parent) {
        continue;
      }
      const req: GraphRequest = {
        method: "GET",
        url: `${userPath(userId)}/mailFolders/${encodeURIComponent(parent.id)}/childFolders`,
      };
      const page = bodyOrThrow(
        { status: response.status, headers: response.headers ?? {}, body: response.body },
        req,
      ) as { value?: RawFolder[]; "@odata.nextLink"?: string } | undefined;
      const children: RawFolder[] = [...(page?.value ?? [])];
      if (page?.["@odata.nextLink"]) {
        children.push(...(await collect(paginate<RawFolder>(client, page["@odata.nextLink"]))));
      }
      for (const raw of children) {
        const node = toNode(raw, parent);
        nodes.push(node);
        frontier.push(node);
      }
    }
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Messages: delta and content

/**
 * The metadata per message as documented in docs/MICROSOFT.md. `from`,
 * `toRecipients` and `ccRecipients` feed the mail envelope metadata contract
 * shared with the IMAP engine (../backup/exchange/mail.ts mailMetadata).
 */
export const MESSAGE_DELTA_SELECT = [
  "id",
  "internetMessageId",
  "subject",
  "receivedDateTime",
  "lastModifiedDateTime",
  "isRead",
  "flag",
  "categories",
  "hasAttachments",
  "parentFolderId",
  "from",
  "toRecipients",
  "ccRecipients",
] as const;

export type MessageDeltaEntry = Partial<Pick<Message, (typeof MESSAGE_DELTA_SELECT)[number]>> & {
  id: string;
  "@removed"?: { reason?: string };
};

export interface MessagesDeltaOptions {
  /** Store key; defaults to `mail:<userId>:<folderId>`. */
  key?: string;
  /** Extra `$select` properties (e.g. `size`, `changeKey`) on top of the documented list. */
  extraSelect?: string[];
  /** Requested page size via `Prefer: odata.maxpagesize` (Graph caps at 200). */
  maxPageSize?: number;
  onResync?: () => void;
}

export function messagesDeltaKey(userId: string, folderId: string): string {
  return `mail:${userId}:${folderId}`;
}

export function messagesDeltaUrl(
  userId: string,
  folderId: string,
  extraSelect: string[] = [],
): string {
  const select = [...MESSAGE_DELTA_SELECT, ...extraSelect].join(",");
  return `${userPath(userId)}/mailFolders/${encodeURIComponent(folderId)}/messages/delta${query({
    $select: select,
  })}`;
}

/** Delta stream of one folder's messages; the token is stored per folder. */
export function messagesDelta(
  client: GraphClient,
  store: DeltaTokenStore,
  userId: string,
  folderId: string,
  options: MessagesDeltaOptions = {},
): AsyncGenerator<DeltaBatch<MessageDeltaEntry>, DeltaSummary, unknown> {
  return syncDelta<MessageDeltaEntry>({
    client,
    store,
    key: options.key ?? messagesDeltaKey(userId, folderId),
    initialUrl: messagesDeltaUrl(userId, folderId, options.extraSelect),
    headers: { Prefer: `odata.maxpagesize=${options.maxPageSize ?? 200}` },
    onResync: options.onResync,
  });
}

/**
 * Metadata that is not part of the MIME (or is regenerated on import) and must be
 * stored next to it so a restore can put it back.
 */
export const MESSAGE_SELECT = [
  "id",
  "internetMessageId",
  "conversationId",
  "conversationIndex",
  "subject",
  "from",
  "sender",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "replyTo",
  "receivedDateTime",
  "sentDateTime",
  "createdDateTime",
  "lastModifiedDateTime",
  "isRead",
  "isDraft",
  "flag",
  "categories",
  "importance",
  "inferenceClassification",
  "hasAttachments",
  "parentFolderId",
  "webLink",
] as const;

export async function getMessage(
  client: GraphClient,
  userId: string,
  messageId: string,
  options: { select?: readonly string[] } = {},
): Promise<Message> {
  return requestOk<Message>(client, {
    method: "GET",
    url: `${userPath(userId)}/messages/${encodeURIComponent(messageId)}${query({
      $select: (options.select ?? MESSAGE_SELECT).join(","),
    })}`,
  });
}

function messageMimeUrl(userId: string, messageId: string): string {
  return `${userPath(userId)}/messages/${encodeURIComponent(messageId)}/$value`;
}

/** Stream the MIME (RFC 5322 with attachments) of a message. */
export async function openMessageMime(
  client: GraphClient,
  userId: string,
  messageId: string,
): Promise<Readable> {
  const req: GraphRequest = {
    method: "GET",
    url: messageMimeUrl(userId, messageId),
    headers: { Accept: "*/*" },
  };
  const response = await client.stream(req);
  if (!response.body) {
    throw new GraphError({
      status: response.status,
      method: req.method,
      url: req.url,
      headers: response.headers,
      payload: response.error,
    });
  }
  return response.body;
}

/** Read the whole MIME of a message into memory (small messages, tests, verify). */
export async function getMessageMime(
  client: GraphClient,
  userId: string,
  messageId: string,
): Promise<Buffer> {
  const stream = await openMessageMime(client, userId, messageId);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export const ATTACHMENT_SELECT = [
  "id",
  "name",
  "contentType",
  "size",
  "isInline",
  "lastModifiedDateTime",
] as const;

export type AttachmentMeta = Pick<Attachment, (typeof ATTACHMENT_SELECT)[number]> & {
  id: string;
  /** `#microsoft.graph.fileAttachment`, `#microsoft.graph.itemAttachment` or `#microsoft.graph.referenceAttachment`. */
  "@odata.type"?: string;
};

export function listAttachments(
  client: GraphClient,
  userId: string,
  messageId: string,
): AsyncGenerator<AttachmentMeta, void, unknown> {
  const url = `${userPath(userId)}/messages/${encodeURIComponent(messageId)}/attachments${query({
    $select: ATTACHMENT_SELECT.join(","),
  })}`;
  return paginate<AttachmentMeta>(client, url);
}

/** Stream the raw bytes of a file attachment (or the MIME of an item attachment). */
export async function openAttachmentContent(
  client: GraphClient,
  userId: string,
  messageId: string,
  attachmentId: string,
): Promise<Readable> {
  const req: GraphRequest = {
    method: "GET",
    url: `${userPath(userId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
    headers: { Accept: "*/*" },
  };
  const response = await client.stream(req);
  if (!response.body) {
    throw new GraphError({
      status: response.status,
      method: req.method,
      url: req.url,
      headers: response.headers,
      payload: response.error,
    });
  }
  return response.body;
}

/** `$value` fails for very large messages (docs say above ~150 MB). */
export const MIME_FALLBACK_THRESHOLD_BYTES = 150 * 1024 * 1024;

export type MessageContent =
  | { kind: "mime"; stream: Readable }
  | {
      kind: "parts";
      /** Message JSON including the body, for messages whose MIME cannot be fetched. */
      message: Message;
      attachments: Array<{ meta: AttachmentMeta; open: () => Promise<Readable> }>;
    };

/** Errors from `$value` that mean "too big for MIME export", not "gone" or "forbidden". */
export function isMimeTooLargeError(error: unknown): boolean {
  if (!isGraphError(error)) {
    return false;
  }
  if (error.status === 413) {
    return true;
  }
  // Never mistake "gone", "forbidden" or "unauthorised" for "too big".
  if ([401, 403, 404, 410].includes(error.status)) {
    return false;
  }
  const wording = `${error.code ?? ""} ${error.innerCode ?? ""} ${error.message}`;
  return /size\w*exceed|exceed\w*size|too\s*large|MessageSizeExceeded/i.test(wording);
}

/**
 * Fetch a message's content as MIME, falling back to JSON body plus individual
 * attachments when Graph refuses the MIME export (oversized message).
 */
export async function fetchMessageContent(
  client: GraphClient,
  userId: string,
  messageId: string,
  options: { knownSizeBytes?: number; fallbackThresholdBytes?: number } = {},
): Promise<MessageContent> {
  const threshold = options.fallbackThresholdBytes ?? MIME_FALLBACK_THRESHOLD_BYTES;
  const knownTooLarge = options.knownSizeBytes !== undefined && options.knownSizeBytes > threshold;
  if (!knownTooLarge) {
    try {
      return { kind: "mime", stream: await openMessageMime(client, userId, messageId) };
    } catch (error) {
      if (!isMimeTooLargeError(error)) {
        throw error;
      }
    }
  }
  const message = await getMessage(client, userId, messageId, {
    select: [...MESSAGE_SELECT, "body", "internetMessageHeaders"],
  });
  const attachments = (await collect(listAttachments(client, userId, messageId))).map((meta) => ({
    meta,
    open: () => openAttachmentContent(client, userId, messageId, meta.id),
  }));
  return { kind: "parts", message, attachments };
}

export async function getMailboxSettings(
  client: GraphClient,
  userId: string,
): Promise<MailboxSettings> {
  return requestOk<MailboxSettings>(client, {
    method: "GET",
    url: `${userPath(userId)}/mailboxSettings`,
  });
}

// ---------------------------------------------------------------------------
// Restore

/**
 * Create a message in a folder from base64-encoded MIME. Graph assigns a new id;
 * headers, dates and attachments come from the MIME. `isDraft` ends up false when
 * the MIME has complete headers. Flags and categories are set afterwards with
 * {@link patchMessage}.
 */
export async function createMessageFromMime(
  client: GraphClient,
  userId: string,
  folderId: string,
  mimeBase64: string,
): Promise<Message> {
  return requestOk<Message>(client, {
    method: "POST",
    url: `${userPath(userId)}/mailFolders/${encodeURIComponent(folderId)}/messages`,
    headers: { "Content-Type": "text/plain" },
    rawBody: mimeBase64,
  });
}

/** Convenience for callers holding the raw MIME bytes. */
export function createMessageFromMimeBytes(
  client: GraphClient,
  userId: string,
  folderId: string,
  mime: Uint8Array,
): Promise<Message> {
  return createMessageFromMime(client, userId, folderId, Buffer.from(mime).toString("base64"));
}

/** Properties Graph rejects or regenerates when a message is created from JSON. */
const MESSAGE_READ_ONLY = [
  "id",
  "changeKey",
  "createdDateTime",
  "lastModifiedDateTime",
  "receivedDateTime",
  "sentDateTime",
  "conversationId",
  "conversationIndex",
  "parentFolderId",
  "webLink",
  "hasAttachments",
  "bodyPreview",
  "isDraft",
  "uniqueBody",
  "attachments",
  "extensions",
  "multiValueExtendedProperties",
  "singleValueExtendedProperties",
] as const;

/** Strip read-only properties so a backed-up message JSON can be POSTed again. */
export function toCreatableMessage(message: Message): Partial<Message> {
  return stripReadOnly(message as Record<string, unknown>, MESSAGE_READ_ONLY) as Partial<Message>;
}

/** Create a message from JSON (fallback path for messages backed up as parts). */
export async function createMessageFromJson(
  client: GraphClient,
  userId: string,
  folderId: string,
  message: Partial<Message>,
): Promise<Message> {
  return requestOk<Message>(client, {
    method: "POST",
    url: `${userPath(userId)}/mailFolders/${encodeURIComponent(folderId)}/messages`,
    body: message,
  });
}

/** Attachments up to this size are posted inline as base64 `contentBytes`. */
export const INLINE_ATTACHMENT_LIMIT_BYTES = 3 * 1024 * 1024;

/**
 * Add a file attachment to an existing message: inline for small files, via an
 * upload session for anything larger (Graph allows up to 150 MB per attachment).
 */
export async function addFileAttachment(
  client: GraphClient,
  userId: string,
  messageId: string,
  file: {
    name: string;
    contentType?: string;
    size: number;
    isInline?: boolean;
    contentId?: string;
  },
  source: UploadSource,
  options: UploadOptions = {},
): Promise<{ id: string | undefined; location: string | undefined }> {
  const base = `${userPath(userId)}/messages/${encodeURIComponent(messageId)}/attachments`;
  if (file.size <= INLINE_ATTACHMENT_LIMIT_BYTES) {
    const bytes = await readAll(source, file.size);
    const created = await requestOk<{ id?: string }>(client, {
      method: "POST",
      url: base,
      body: {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: file.name,
        contentType: file.contentType,
        isInline: file.isInline ?? false,
        contentId: file.contentId,
        contentBytes: bytes.toString("base64"),
      },
    });
    return { id: created.id, location: undefined };
  }
  const session = await requestOk<UploadSessionInfo>(client, {
    method: "POST",
    url: `${base}/createUploadSession`,
    body: {
      AttachmentItem: {
        attachmentType: "file",
        name: file.name,
        size: file.size,
        contentType: file.contentType,
        isInline: file.isInline ?? false,
        contentId: file.contentId,
      },
    },
  });
  const outcome = await uploadToSession(client, session, source, file.size, {
    ...options,
    bounds: OUTLOOK_FRAGMENT_BOUNDS,
  });
  return { id: attachmentIdFromLocation(outcome.location), location: outcome.location };
}

/**
 * The Location of a finished attachment upload is written in Outlook REST style
 * (`.../Attachments('AAMk...')`); Graph style (`.../attachments/AAMk...`) is
 * accepted as well.
 */
export function attachmentIdFromLocation(location: string | undefined): string | undefined {
  if (!location) {
    return undefined;
  }
  const id =
    location.match(/attachments\('([^']+)'\)/i)?.[1] ??
    location.match(/attachments\/([^/?'()]+)/i)?.[1];
  return id ? decodeURIComponent(id) : undefined;
}

async function readAll(source: UploadSource, size: number): Promise<Buffer> {
  if (Buffer.isBuffer(source)) {
    return source;
  }
  if (typeof source === "function") {
    return source(0, size);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export interface MessagePatch {
  isRead?: boolean;
  flag?: FollowupFlag;
  categories?: string[];
  importance?: Importance;
  inferenceClassification?: Message["inferenceClassification"];
}

/** Re-apply flags/categories after a MIME import (they are not part of the MIME). */
export async function patchMessage(
  client: GraphClient,
  userId: string,
  messageId: string,
  patch: MessagePatch,
): Promise<void> {
  const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (Object.keys(body).length === 0) {
    return;
  }
  await requestOk(client, {
    method: "PATCH",
    url: `${userPath(userId)}/messages/${encodeURIComponent(messageId)}`,
    body,
  });
}

/** Messages with a given Message-ID header, for the duplicate check before an import. */
export async function findMessagesByInternetMessageId(
  client: GraphClient,
  userId: string,
  internetMessageId: string,
  options: { folderId?: string } = {},
): Promise<Array<Pick<Message, "id" | "parentFolderId" | "receivedDateTime"> & { id: string }>> {
  const base = options.folderId
    ? `${userPath(userId)}/mailFolders/${encodeURIComponent(options.folderId)}/messages`
    : `${userPath(userId)}/messages`;
  const url = `${base}${query({
    $filter: `internetMessageId eq ${odataString(internetMessageId)}`,
    $select: "id,parentFolderId,receivedDateTime",
  })}`;
  return collect(paginate(client, url));
}

export interface EnsureMailFolderPathOptions {
  /** Folder to start from; the mailbox root when omitted. */
  parentFolderId?: string;
  /** Shared across calls of one restore so each path segment is looked up once. */
  cache?: Map<string, string>;
}

async function findChildFolder(
  client: GraphClient,
  userId: string,
  parentFolderId: string | undefined,
  displayName: string,
): Promise<string | null> {
  const base = parentFolderId
    ? `${userPath(userId)}/mailFolders/${encodeURIComponent(parentFolderId)}/childFolders`
    : `${userPath(userId)}/mailFolders`;
  const url = `${base}${query({
    includeHiddenFolders: true,
    $filter: `displayName eq ${odataString(displayName)}`,
    $select: "id,displayName",
  })}`;
  for await (const folder of paginate<{ id: string; displayName?: string }>(client, url)) {
    return folder.id;
  }
  return null;
}

async function createChildFolder(
  client: GraphClient,
  userId: string,
  parentFolderId: string | undefined,
  displayName: string,
): Promise<string> {
  const url = parentFolderId
    ? `${userPath(userId)}/mailFolders/${encodeURIComponent(parentFolderId)}/childFolders`
    : `${userPath(userId)}/mailFolders`;
  const created = await requestOk<{ id: string }>(client, {
    method: "POST",
    url,
    body: { displayName },
  });
  return created.id;
}

/**
 * Walk (and create where missing) a folder path like `Inbox/Projects/2026` and
 * return the id of the last folder. Lookups are by display name, case-insensitive
 * as Graph's `$filter eq` is; existing folders are never duplicated.
 */
export async function ensureMailFolderPath(
  client: GraphClient,
  userId: string,
  path: string | string[],
  options: EnsureMailFolderPathOptions = {},
): Promise<string> {
  const segments = splitPath(path);
  const cache = options.cache ?? new Map<string, string>();
  let current: string | undefined = options.parentFolderId;
  for (const segment of segments) {
    const parentId: string | undefined = current;
    const cacheKey = `${parentId ?? ""}/${segment.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    const id: string =
      cached ??
      (await findChildFolder(client, userId, parentId, segment)) ??
      (await createChildFolder(client, userId, parentId, segment));
    cache.set(cacheKey, id);
    current = id;
  }
  if (current === undefined) {
    throw new Error("A mail folder path must have at least one segment");
  }
  return current;
}

/** Delete a message permanently (restore clean-up of a failed import). */
export async function deleteMessage(
  client: GraphClient,
  userId: string,
  messageId: string,
): Promise<void> {
  try {
    await requestOk(client, {
      method: "DELETE",
      url: `${userPath(userId)}/messages/${encodeURIComponent(messageId)}`,
    });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}
