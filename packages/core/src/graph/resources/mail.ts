/**
 * Exchange Online mail resources: folder tree, per-folder message delta, MIME
 * download with the attachment-by-attachment fallback for oversized messages,
 * mailbox settings, and the restore primitives (create from MIME, patch flags,
 * ensure folder path, duplicate check by internetMessageId).
 *
 * The backup format for a message is its MIME (RFC 5322) plus the metadata from
 * the delta entry; flag/category changes only touch metadata (docs/MICROSOFT.md).
 */
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type {
  Attachment,
  FollowupFlag,
  Importance,
  MailboxSettings,
  MailFolder,
  Message,
} from "@microsoft/microsoft-graph-types";
import { JobAbortedError } from "../../engine/chunkstore.js";
import { pauseBeforeRetry } from "../../storage/transfer.js";
import type { BatchRequest, GraphClient, GraphRequest } from "../client.js";
import { type DeltaBatch, type DeltaSummary, type DeltaTokenStore, syncDelta } from "../delta.js";
import { GraphError, isGraphError, isMailboxUnavailable, isNotFound } from "../errors.js";
import {
  bodyOrThrow,
  collect,
  isWriteOutcomeUnknown,
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
  uploadToSessionOrCancel,
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
  /**
   * Names whose lookup was refused with a 4xx other than 404 and 429 (a 400 for a
   * name this mailbox type does not support, a 403). They are treated as absent;
   * the caller may log them as a warning. Throttling and 5xx answers throw instead.
   */
  unresolved?: Map<WellKnownFolderName, GraphError>;
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
 * mailbox does not have (404) are simply absent from the result. A definite
 * refusal of a name (4xx, e.g. a name this mailbox type does not support)
 * makes that one name absent too and is listed in `unresolved`: the lookups
 * only label folders (and pick the skipped search folders), so one refused
 * name must never fail the whole mailbox before a single folder was listed. A
 * mailbox that is really off limits fails right after, on the folder listing
 * itself. Throttling (429) and server errors (5xx) throw: they are transient,
 * and the run retries instead of going on with labels missing.
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
  const unresolved = new Map<WellKnownFolderName, GraphError>();
  for (const response of await client.batch(requests)) {
    const name = response.id as WellKnownFolderName;
    if (response.status === 404) {
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new GraphError({
        status: response.status,
        method: "GET",
        url: `${userPath(userId)}/mailFolders/${name}`,
        headers: response.headers,
        payload: response.body,
      });
      // Throttling the client retried in vain and server errors are transient:
      // treating the name as absent would back up a skipped folder and drop the
      // well-known labels for this run only. Fail so the run retries and resumes.
      if (response.status === 429 || response.status >= 500) {
        throw error;
      }
      unresolved.set(name, error);
      continue;
    }
    const id = (response.body as { id?: string } | undefined)?.id;
    if (id) {
      byName.set(name, id);
      byId.set(id, name);
    }
  }
  return { byName, byId, unresolved };
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
  /**
   * Called for a folder whose child listing answered 404 (the folder was deleted
   * after its parent listed it, or Graph answered a spurious 404), so its
   * subfolders are missing from the tree, or only partly listed. The caller
   * decides what to do with that subtree; the tree is not proof that it is gone.
   */
  onVanishedFolder?: (folder: MailFolderNode, error: unknown) => void;
  /**
   * Called for a folder whose child listing got no usable answer: a server error or
   * throttling the client retried in vain, or no answer at all inside the `$batch` (a
   * synthetic 502). Its subfolders are missing from the tree and nothing says whether they
   * exist. Without this callback such an answer throws, as it always did. A refusal of the
   * mailbox (401, 403, "no mailbox") throws either way.
   */
  onUnlistedFolder?: (folder: MailFolderNode, error: GraphError) => void;
}

type RawFolder = Pick<MailFolder, (typeof MAIL_FOLDER_SELECT)[number]> & { id: string };

/** A folder that no longer exists (deleted or moved after it was listed), not a missing mailbox. */
function isVanishedFolder(error: unknown): boolean {
  return isNotFound(error) && !isMailboxUnavailable(error);
}

/** A child listing that says nothing about the folder: throttled or a server error. */
function isUnknownChildListing(error: unknown): error is GraphError {
  if (!isGraphError(error)) {
    return false;
  }
  const status = error.status;
  return (status === 429 || status >= 500) && !isMailboxUnavailable(error);
}

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

  // Graph's paging can list a folder twice (a folder created or moved while the
  // pages are read); each folder goes into the tree once.
  const seen = new Set<string>();
  let frontier: MailFolderNode[] = [];
  for await (const raw of paginate<RawFolder>(client, `${userPath(userId)}/mailFolders${suffix}`)) {
    if (seen.has(raw.id)) {
      continue;
    }
    seen.add(raw.id);
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
      let page: { value?: RawFolder[]; "@odata.nextLink"?: string } | undefined;
      try {
        page = bodyOrThrow(
          { status: response.status, headers: response.headers ?? {}, body: response.body },
          req,
        ) as typeof page;
      } catch (error) {
        // The parent was probably deleted after it was listed, but the 404 alone
        // does not prove it: leave the subtree out and let the caller decide
        // (the parent's own enumeration then sees a real 404 and drops it). "No
        // mailbox" codes that also come as 404 stay fatal.
        if (isVanishedFolder(error)) {
          options.onVanishedFolder?.(parent, error);
          continue;
        }
        // Not an answer about the folder at all (5xx, throttled, missing in the $batch):
        // the subtree is unknown, which the caller must not take for "no subfolders".
        if (options.onUnlistedFolder && isUnknownChildListing(error)) {
          options.onUnlistedFolder(parent, error);
          continue;
        }
        throw error;
      }
      const children: RawFolder[] = [...(page?.value ?? [])];
      const nextLink = page?.["@odata.nextLink"];
      if (nextLink) {
        try {
          for await (const raw of paginate<RawFolder>(client, nextLink)) {
            children.push(raw);
          }
        } catch (error) {
          // Vanished while its later pages were read: keep the children already seen.
          if (!isVanishedFolder(error)) {
            throw error;
          }
          options.onVanishedFolder?.(parent, error);
        }
      }
      for (const raw of children) {
        if (seen.has(raw.id)) {
          continue;
        }
        seen.add(raw.id);
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

/**
 * What a message's content is, apart from its flags: the body as text and the list of its
 * attachments (id, name, size, inline), without their bytes. Subject, `hasAttachments` and
 * `bodyPreview` (the first 255 characters) stay the same when an attachment of a received
 * mail is removed or its body is edited further down; this does not. It also does not move
 * when a flag, the read state, a category or a retention tag changes, which PidTagMessageSize
 * (0x0E08) does: Exchange counts every MAPI property into the size.
 */
export function messageContentCheckUrl(userId: string, messageId: string): string {
  return `${userPath(userId)}/messages/${encodeURIComponent(messageId)}${query({
    $select: "id,body",
    $expand: "attachments($select=id,name,size,isInline)",
  })}`;
}

/** The body as text: smaller than HTML and enough to tell an edit. */
export const MESSAGE_CONTENT_CHECK_HEADERS: Readonly<Record<string, string>> = {
  Prefer: 'outlook.body-content-type="text"',
};

/**
 * The content signature of a {@link messageContentCheckUrl} answer (SHA-256 over the body
 * text and the sorted attachment list), or undefined when the answer lacks either.
 */
export function messageContentSignature(body: unknown): string | undefined {
  const answer = body as
    | { body?: { content?: unknown } | null; attachments?: unknown }
    | null
    | undefined;
  const content = answer?.body?.content;
  if (typeof content !== "string" || !Array.isArray(answer?.attachments)) {
    return undefined;
  }
  const attachments = (answer.attachments as Array<Record<string, unknown>>)
    .map((attachment) => [
      String(attachment?.id ?? ""),
      String(attachment?.name ?? ""),
      Number(attachment?.size ?? -1),
      attachment?.isInline === true,
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify({ body: content, attachments }), "utf8")
    .digest("hex");
}

export interface MessageContentSignatures {
  /** By message id. */
  readonly signatures: ReadonlyMap<string, string>;
  /** Messages Graph did not answer for (throttled, server error, gone): unknown, not unchanged. */
  readonly unanswered: ReadonlySet<string>;
}

/**
 * {@link messageContentSignature} of several messages through `$batch` (20 per request).
 * Every id is either signed or unanswered.
 */
export async function getMessageContentSignatures(
  client: GraphClient,
  userId: string,
  messageIds: readonly string[],
): Promise<MessageContentSignatures> {
  const signatures = new Map<string, string>();
  const unanswered = new Set<string>();
  if (messageIds.length === 0) {
    return { signatures, unanswered };
  }
  const responses = await client.batch(
    messageIds.map((id, index) => ({
      id: String(index),
      method: "GET",
      url: messageContentCheckUrl(userId, id),
      headers: { ...MESSAGE_CONTENT_CHECK_HEADERS },
    })),
  );
  const answered = new Set<string>();
  for (const response of responses) {
    const id = messageIds[Number(response.id)];
    if (id === undefined || response.status < 200 || response.status >= 300) {
      continue;
    }
    const signature = messageContentSignature(response.body);
    if (signature !== undefined) {
      signatures.set(id, signature);
      answered.add(id);
    }
  }
  for (const id of messageIds) {
    if (!answered.has(id)) {
      unanswered.add(id);
    }
  }
  return { signatures, unanswered };
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

/**
 * `contentId` lives on the derived fileAttachment type, not on attachment: it is selected in the
 * type-cast form. It is what an inline image's `cid:` reference in the HTML body names.
 */
export const ATTACHMENT_CONTENT_ID_SELECT = "microsoft.graph.fileAttachment/contentId";

export type AttachmentMeta = Pick<Attachment, (typeof ATTACHMENT_SELECT)[number]> & {
  id: string;
  /** `#microsoft.graph.fileAttachment`, `#microsoft.graph.itemAttachment` or `#microsoft.graph.referenceAttachment`. */
  "@odata.type"?: string;
  /** File attachments only: the Content-ID an inline image is referenced by (`cid:`). */
  contentId?: string | null;
};

/** The attachments of an item (`<parent>/attachments`): a message, an event or a post. */
export function listAttachmentsAt(
  client: GraphClient,
  parentPath: string,
  options: { readonly contentId?: boolean } = {},
): AsyncGenerator<AttachmentMeta, void, unknown> {
  const select = [
    ...ATTACHMENT_SELECT,
    ...(options.contentId ? [ATTACHMENT_CONTENT_ID_SELECT] : []),
  ];
  return paginate<AttachmentMeta>(
    client,
    `${parentPath}/attachments${query({ $select: select.join(",") })}`,
  );
}

export function listAttachments(
  client: GraphClient,
  userId: string,
  messageId: string,
  options: { readonly contentId?: boolean } = {},
): AsyncGenerator<AttachmentMeta, void, unknown> {
  return listAttachmentsAt(client, messagePath(userId, messageId), options);
}

function messagePath(userId: string, messageId: string): string {
  return `${userPath(userId)}/messages/${encodeURIComponent(messageId)}`;
}

/**
 * The attachments of an item with their Content-ID. Should Graph refuse the type-cast
 * `$select` (400), they are listed without it, and `contentIdUnavailable` says so: the caller
 * records that inline images may not resolve after a restore instead of staying silent.
 */
export async function listAttachmentsWithContentIdAt(
  client: GraphClient,
  parentPath: string,
): Promise<{ attachments: AttachmentMeta[]; contentIdUnavailable: boolean }> {
  try {
    return {
      attachments: await collect(listAttachmentsAt(client, parentPath, { contentId: true })),
      contentIdUnavailable: false,
    };
  } catch (error) {
    if (!(isGraphError(error) && error.status === 400)) {
      throw error;
    }
    return {
      attachments: await collect(listAttachmentsAt(client, parentPath)),
      contentIdUnavailable: true,
    };
  }
}

export function listAttachmentsWithContentId(
  client: GraphClient,
  userId: string,
  messageId: string,
): Promise<{ attachments: AttachmentMeta[]; contentIdUnavailable: boolean }> {
  return listAttachmentsWithContentIdAt(client, messagePath(userId, messageId));
}

/** Stream the raw bytes of an attachment of an item (`<parent>/attachments/{id}/$value`). */
export async function openAttachmentContentAt(
  client: GraphClient,
  parentPath: string,
  attachmentId: string,
): Promise<Readable> {
  const req: GraphRequest = {
    method: "GET",
    url: `${parentPath}/attachments/${encodeURIComponent(attachmentId)}/$value`,
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

/** Stream the raw bytes of a file attachment (or the MIME of an item attachment). */
export function openAttachmentContent(
  client: GraphClient,
  userId: string,
  messageId: string,
  attachmentId: string,
): Promise<Readable> {
  return openAttachmentContentAt(client, messagePath(userId, messageId), attachmentId);
}

/** `$value` fails for very large messages (docs say above ~150 MB). */
export const MIME_FALLBACK_THRESHOLD_BYTES = 150 * 1024 * 1024;

/** Why a message is stored as Graph JSON plus attachments instead of its MIME. */
export type MimeFallbackReason =
  /** `$value` refused the message as too large (413, size codes, or known size > 150 MB). */
  | "too_large"
  /** Exchange cannot convert the item to MIME (a conversion or corrupt-data code). */
  | "conversion_refused"
  /**
   * `$value` answered a plain 500 on every attempt and the caller asked for the JSON then
   * (`jsonAfterServerError`): the content is safe, the MIME is tried again later.
   */
  | "server_error";

export type MessageContent =
  | { kind: "mime"; stream: Readable }
  | {
      kind: "parts";
      /** Message JSON including the body, for messages whose MIME cannot be fetched. */
      message: Message;
      attachments: Array<{ meta: AttachmentMeta; open: () => Promise<Readable> }>;
      fallbackReason: MimeFallbackReason;
      /** Graph refused to name the attachments' Content-IDs ({@link listAttachmentsWithContentId}). */
      contentIdUnavailable?: boolean;
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

const CONVERSION_WORDING = /MimeContentConversion|ConversionFailed|CorruptData/i;

/**
 * Errors from `$value` where the JSON + attachments export is the answer: the message
 * is too big, or Exchange says it cannot convert the item to MIME (IRM, corrupt or
 * special item classes, named by a conversion code). A plain 500 is not one of them:
 * it is a server error like any other and may be gone a second later (see
 * {@link isMimeServerError}). "Gone", "forbidden", "unauthorised" and throttling are
 * never mistaken for it.
 */
export function isMimeExportRefusedError(error: unknown): boolean {
  return mimeRefusalReason(error) !== null;
}

/** The reason a `$value` error means "store as JSON", or null when it does not. */
export function mimeRefusalReason(
  error: unknown,
): Exclude<MimeFallbackReason, "server_error"> | null {
  if (!isGraphError(error)) {
    return null;
  }
  if (isMimeTooLargeError(error)) {
    return "too_large";
  }
  if ([401, 403, 404, 410, 429].includes(error.status)) {
    return null;
  }
  const wording = `${error.code ?? ""} ${error.innerCode ?? ""} ${error.message}`;
  return CONVERSION_WORDING.test(wording) ? "conversion_refused" : null;
}

/** A 500 from `$value` without a conversion code: a server error, asked again with backoff. */
export function isMimeServerError(error: unknown): error is GraphError {
  return isGraphError(error) && error.status === 500 && mimeRefusalReason(error) === null;
}

/** Default number of `$value` attempts in all when it answers a plain 500. */
export const MIME_SERVER_ERROR_ATTEMPTS = 3;
/** Default base of the exponential backoff between those attempts. */
export const MIME_SERVER_ERROR_BACKOFF_MS = 1000;
/** Longest wait between two of those attempts, also for a server's Retry-After. */
const MIME_SERVER_ERROR_MAX_WAIT_MS = 30_000;

export interface FetchMessageContentOptions {
  knownSizeBytes?: number;
  fallbackThresholdBytes?: number;
  /** `$value` attempts in all when it answers a plain 500 (default 3, at least 1). */
  serverErrorAttempts?: number;
  /** Base of the exponential backoff (with jitter) between those attempts (default 1 s). */
  serverErrorBackoffMs?: number;
  /**
   * After the last plain 500, fetch the JSON + attachments (reason `server_error`)
   * instead of throwing the 500. Default false: a plain 500 is an item failure the
   * next run retries, never a reason to give up the MIME.
   */
  jsonAfterServerError?: boolean;
  /** Ends a backoff wait early (the job's signal). */
  signal?: AbortSignal;
  /** Injectable wait (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable RNG in [0, 1) for the jitter (tests). */
  random?: () => number;
}

/**
 * Fetch a message's content as MIME, falling back to JSON body plus individual
 * attachments when Graph refuses the MIME export (oversized message, or an item
 * Exchange cannot convert to MIME). A plain 500 is asked again with backoff and,
 * when it stays, thrown (or, with `jsonAfterServerError`, answered with the JSON).
 */
export async function fetchMessageContent(
  client: GraphClient,
  userId: string,
  messageId: string,
  options: FetchMessageContentOptions = {},
): Promise<MessageContent> {
  const threshold = options.fallbackThresholdBytes ?? MIME_FALLBACK_THRESHOLD_BYTES;
  const knownTooLarge = options.knownSizeBytes !== undefined && options.knownSizeBytes > threshold;
  if (knownTooLarge) {
    return fetchMessageParts(client, userId, messageId, "too_large");
  }
  const attempts = Math.max(
    1,
    Math.floor(options.serverErrorAttempts ?? MIME_SERVER_ERROR_ATTEMPTS),
  );
  const baseMs = Math.max(0, options.serverErrorBackoffMs ?? MIME_SERVER_ERROR_BACKOFF_MS);
  const sleep = options.sleep ?? waitBeforeAskingAgain;
  const random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return { kind: "mime", stream: await openMessageMime(client, userId, messageId) };
    } catch (error) {
      const reason = mimeRefusalReason(error);
      if (reason !== null) {
        return fetchMessageParts(client, userId, messageId, reason);
      }
      if (!isMimeServerError(error)) {
        throw error;
      }
      if (attempt >= attempts) {
        if (options.jsonAfterServerError) {
          return fetchMessageParts(client, userId, messageId, "server_error");
        }
        throw error;
      }
      const asked = error.retryAfterMs;
      const backoff = baseMs * 2 ** (attempt - 1) + random() * baseMs;
      await sleep(Math.min(MIME_SERVER_ERROR_MAX_WAIT_MS, asked ?? backoff), options.signal);
    }
  }
}

/** A backoff wait that ends with {@link JobAbortedError} when the job is cancelled. */
async function waitBeforeAskingAgain(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await pauseBeforeRetry(ms, signal);
  } catch (error) {
    throw signal?.aborted ? new JobAbortedError() : error;
  }
}

/** The JSON body plus attachments of a message whose MIME is not stored (see the reason). */
export async function fetchMessageParts(
  client: GraphClient,
  userId: string,
  messageId: string,
  fallbackReason: MimeFallbackReason,
): Promise<Extract<MessageContent, { kind: "parts" }>> {
  const message = await getMessage(client, userId, messageId, {
    select: [...MESSAGE_SELECT, "body", "internetMessageHeaders"],
  });
  const listed = await listAttachmentsWithContentId(client, userId, messageId);
  const attachments = listed.attachments.map((meta) => ({
    meta,
    open: () => openAttachmentContent(client, userId, messageId, meta.id),
  }));
  return {
    kind: "parts",
    message,
    attachments,
    fallbackReason,
    ...(listed.contentIdUnavailable ? { contentIdUnavailable: true } : {}),
  };
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

/**
 * MAPI properties (MS-OXPROPS) a message created from JSON gets, so it is a
 * received or sent message with its own dates and not a draft dated today.
 * Graph honours them only on create.
 */
export const PID_TAG_MESSAGE_FLAGS = "Integer 0x0E07";
export const PID_TAG_MESSAGE_DELIVERY_TIME = "SystemTime 0x0E06";
export const PID_TAG_CLIENT_SUBMIT_TIME = "SystemTime 0x0039";
/** PidTagMessageFlags bits: read, and unsent (the draft bit, never set here). */
export const MSGFLAG_READ = 0x1;
export const MSGFLAG_UNSENT = 0x8;

/**
 * Custom headers a create may carry. Graph refuses any header whose name does
 * not start with `x-` (400 InvalidInternetMessageHeader) and limits the custom
 * headers of a message; Restow stays well below that with at most 5 headers of
 * together at most 2 KB.
 */
export const MAX_CREATE_HEADERS = 5;
export const MAX_CREATE_HEADER_BYTES = 2048;

/**
 * Headers Exchange and its filters stamp on delivery. They describe the
 * original transport, not the message, and a create must not claim them.
 */
const TRANSPORT_STAMPED_HEADER = /^x-(ms-|microsoft-|forefront-|originatororg$)/i;

/** What {@link toCreatableMessage} could not carry over. */
export interface CreatableMessageLoss {
  /** Backed-up headers left out: standard (transport) headers and x- headers over the limit. */
  readonly droppedHeaders: number;
  /** The backup does not say whether the message was a draft; it stays one (Graph's default). */
  readonly draftStateUnknown: boolean;
}

function customHeadersOf(message: Message): {
  kept: Array<{ name: string; value: string }>;
  dropped: number;
} {
  const all = Array.isArray(message.internetMessageHeaders) ? message.internetMessageHeaders : [];
  const kept: Array<{ name: string; value: string }> = [];
  let bytes = 0;
  for (const header of all) {
    const name = typeof header?.name === "string" ? header.name.trim() : "";
    const value = typeof header?.value === "string" ? header.value : "";
    if (!/^x-/i.test(name) || TRANSPORT_STAMPED_HEADER.test(name)) {
      continue;
    }
    const size = Buffer.byteLength(name) + Buffer.byteLength(value);
    if (kept.length >= MAX_CREATE_HEADERS || bytes + size > MAX_CREATE_HEADER_BYTES) {
      continue;
    }
    kept.push({ name, value });
    bytes += size;
  }
  return { kept, dropped: all.length - kept.length };
}

function isoInstant(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  return new Date(value).toISOString();
}

/**
 * The extended properties that make a message created from JSON what it was:
 * not a draft (PidTagMessageFlags without the unsent bit, with the read bit
 * from `isRead`), received and sent at its own times. Only for a message the
 * backup recorded as not a draft; a draft stays a draft without dates.
 */
export function restoredMessageProperties(
  message: Pick<Message, "isRead" | "receivedDateTime" | "sentDateTime">,
): Array<{ id: string; value: string }> {
  const properties = [
    { id: PID_TAG_MESSAGE_FLAGS, value: String(message.isRead === true ? MSGFLAG_READ : 0) },
  ];
  const received = isoInstant(message.receivedDateTime);
  if (received !== undefined) {
    properties.push({ id: PID_TAG_MESSAGE_DELIVERY_TIME, value: received });
  }
  const sent = isoInstant(message.sentDateTime);
  if (sent !== undefined) {
    properties.push({ id: PID_TAG_CLIENT_SUBMIT_TIME, value: sent });
  }
  return properties;
}

/**
 * Turn a backed-up message JSON into a body Graph accepts on create: read-only
 * properties stripped, only the custom `x-` headers Graph takes (never the
 * transport headers the backup fetched with the message), and, for a message
 * that was not a draft (`isDraft` false in the JSON or, when the JSON lacks it,
 * in `options.isDraft`), the extended properties of
 * {@link restoredMessageProperties}.
 */
export function toCreatableMessage(
  message: Message,
  options: { isDraft?: boolean } = {},
): Partial<Message> {
  return prepareMessageCreate(message, options).body;
}

/** {@link toCreatableMessage}, also saying what could not be carried over. */
export function prepareMessageCreate(
  message: Message,
  options: { isDraft?: boolean } = {},
): { body: Partial<Message>; loss: CreatableMessageLoss } {
  const { internetMessageHeaders: _headers, ...rest } = message;
  const body = stripReadOnly(
    rest as Record<string, unknown>,
    MESSAGE_READ_ONLY,
  ) as Partial<Message>;
  const headers = customHeadersOf(message);
  if (headers.kept.length > 0) {
    body.internetMessageHeaders = headers.kept;
  }
  const isDraft = typeof message.isDraft === "boolean" ? message.isDraft : options.isDraft;
  if (isDraft === false) {
    body.singleValueExtendedProperties = restoredMessageProperties(message);
  }
  return {
    body,
    loss: { droppedHeaders: headers.dropped, draftStateUnknown: isDraft === undefined },
  };
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

/**
 * Attachments below this size are posted inline as base64 `contentBytes`;
 * Graph takes one of this size or larger (up to 150 MB) only through an
 * upload session, and refuses an upload session for a smaller one.
 */
export const INLINE_ATTACHMENT_LIMIT_BYTES = 3 * 1024 * 1024;

/**
 * Largest base64 MIME Restow imports in one request: Graph refuses a request
 * body over 4 MB (413), so a larger message is created without its
 * attachments and gets them one by one (restore/exchange.ts).
 */
export const MIME_IMPORT_LIMIT_BASE64_BYTES = 3.5 * 1024 * 1024;

/** Length of the base64 form of `bytes` bytes. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * Add a file attachment to an existing message: inline for small files, via an
 * upload session for anything larger (Graph allows up to 150 MB per attachment).
 */
export async function addFileAttachment(
  client: GraphClient,
  userId: string,
  messageId: string,
  file: FileAttachmentFacts,
  source: UploadSource,
  options: UploadOptions = {},
): Promise<{ id: string | undefined; location: string | undefined }> {
  return addFileAttachmentAt(
    client,
    `${userPath(userId)}/messages/${encodeURIComponent(messageId)}/attachments`,
    file,
    source,
    options,
  );
}

/** What a file attachment is created with. */
export interface FileAttachmentFacts {
  name: string;
  contentType?: string;
  size: number;
  isInline?: boolean;
  contentId?: string;
}

/**
 * Add a file attachment to the item whose `attachments` collection is `base`
 * (a message or an event): a POST under 3 MB, else an upload session (up to
 * 150 MB, fragments resumed after a failure and cancelled when it gives up).
 */
export async function addFileAttachmentAt(
  client: GraphClient,
  base: string,
  file: FileAttachmentFacts,
  source: UploadSource,
  options: UploadOptions = {},
): Promise<{ id: string | undefined; location: string | undefined }> {
  if (file.size < INLINE_ATTACHMENT_LIMIT_BYTES) {
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
    // A second session is harmless (the unused one expires); the attachment is not created yet.
    idempotent: true,
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
  const outcome = await uploadToSessionOrCancel(client, session, source, file.size, {
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
 * Create a folder without ever creating it twice: when Graph answers 409 (it
 * exists, for example because an earlier POST went through unanswered) or the
 * outcome of the POST is unknown, the folder is looked up again and taken;
 * only a folder that is still missing after an unknown outcome is created
 * once more. Exchange refuses a second folder of the same name, so that
 * create cannot make a twin: when the first one went through meanwhile (it
 * was still being made when its answer was lost) it answers 409, and the
 * folder is looked up once more.
 */
async function createChildFolderOnce(
  client: GraphClient,
  userId: string,
  parentFolderId: string | undefined,
  displayName: string,
): Promise<string> {
  const isExists = (error: unknown) => isGraphError(error) && error.status === 409;
  try {
    return await createChildFolder(client, userId, parentFolderId, displayName);
  } catch (error) {
    const exists = isExists(error);
    if (!exists && !isWriteOutcomeUnknown(error)) {
      throw error;
    }
    const found = await findChildFolder(client, userId, parentFolderId, displayName);
    if (found !== null) {
      return found;
    }
    if (exists) {
      throw error;
    }
    try {
      return await createChildFolder(client, userId, parentFolderId, displayName);
    } catch (retryError) {
      if (!isExists(retryError)) {
        throw retryError;
      }
      const late = await findChildFolder(client, userId, parentFolderId, displayName);
      if (late === null) {
        throw retryError;
      }
      return late;
    }
  }
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
      (await createChildFolderOnce(client, userId, parentId, segment));
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
