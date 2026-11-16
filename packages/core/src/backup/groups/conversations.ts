/**
 * Conversations phase of a group mailbox backup: every post of every thread,
 * stored as an RFC 5322 message in the mail area so everything that handles
 * mail handles group conversations too: the restore explorer lists them, a
 * download gives `.eml` files, an export gives MBOX or PST, and a restore
 * into a user mailbox imports them like any other message.
 *
 *   mail/Conversations/<topic>.<post id digest>.eml
 *
 * Graph has no MIME for posts, so the message is built here, deterministically
 * (mailfiles/mime-writer.ts): the same post always yields the same bytes and
 * deduplicates. Headers: From (and Sender when it differs), To = the group,
 * Cc = participants a post added, Subject = the thread topic, Date = when the
 * post was delivered, a Message-ID derived from the post id, and Thread-Topic
 * so mail clients group a thread. The body is the post's HTML or text; file
 * attachments become MIME parts when Graph hands out their bytes.
 *
 * Incremental: threads have no delta, so every run lists the threads (one
 * page per few hundred threads) and lists posts only of threads whose
 * `lastDeliveredDateTime` moved since the last run (or of every thread in a
 * full run). A post whose id and change key are unchanged keeps its stored
 * bytes. Threads that disappeared take their posts with them.
 *
 * Attachments: Graph documents listing post attachments as delegated only.
 * The posts are asked for with `$expand=attachments`; when Graph refuses that
 * to the app, the run continues without the expansion for this group and
 * every post with attachments records the names it could not fetch
 * (`missingAttachments`), so nothing is lost silently. With the expansion, a
 * file attachment comes with its bytes (or they are read through
 * `/attachments/{id}/$value`), an item attachment (a forwarded mail, an event)
 * is read as MIME through `/$value` and embedded as `message/rfc822`, and a
 * link attachment is recorded by name (`referenceAttachments`; the file lives
 * in OneDrive or SharePoint). An attachment that cannot be read leaves the post
 * marked `attachmentsNotBackedUp`: the run warns, and the next run reads the
 * thread again.
 */
import { createHash } from "node:crypto";
import type { Attachment, FileAttachment, Recipient } from "@microsoft/microsoft-graph-types";
import { buildCause } from "../../failures/classify.js";
import { isNotFound } from "../../graph/errors.js";
import {
  isAttachmentExpansionRefused,
  listPosts,
  listThreads,
  type PostWithAttachments,
  postPath,
  type ThreadInfo,
} from "../../graph/resources/groups.js";
import { openAttachmentContentAt } from "../../graph/resources/mail.js";
import {
  encodeHeaderText,
  filePart,
  formatMailbox,
  type HeaderField,
  type MimePart,
  messagePart,
  multipart,
  serializeMessage,
  textPart,
} from "../../mailfiles/mime-writer.js";
import { folderObjectAt, removeGroupItems, removeUnseenItems } from "../exchange/folders.js";
import { formatRecipient } from "../exchange/mail.js";
import { joinPath, MAIL_ROOT, mailObjectPath } from "../exchange/paths.js";
import {
  type BackupRun,
  isItemLevelError,
  isVanished,
  MESSAGE_FORMAT,
  META,
  mailGroup,
  OBJECT_TYPES,
  toMailboxAccessError,
} from "../exchange/run.js";
import { toMillis } from "../exchange/time.js";

/** The folder all posts live in, as the user sees it after a restore. */
export const CONVERSATIONS_FOLDER = "Conversations";
/** Object path of that folder. */
export const CONVERSATIONS_PATH = joinPath(MAIL_ROOT, CONVERSATIONS_FOLDER);
/** `folderId` of the folder object, and the prefix of every thread's group key. */
const CONVERSATIONS_FOLDER_ID = "conversations";
const THREAD_GROUP_PREFIX = "thread:";

/** Metadata keys of a post besides the mail vocabulary of ../exchange/run.ts. */
export const POST_META = {
  /** Graph id of the thread; `folderId` carries it too (with a prefix) for grouping. */
  threadId: "conversationThreadId",
  postId: "postId",
  /** Names of attachments not in the backup (expansion refused, or not readable). */
  missingAttachments: "missingAttachments",
  /**
   * "true": the post has attachments (`hasAttachments` as Graph says) that are not in the
   * backup, because Graph refused them to the app or they could not be read. Every run with
   * such posts warns.
   */
  attachmentsNotBackedUp: "attachmentsNotBackedUp",
} as const;

/** What `missingAttachments` says when Graph refused the attachment expansion. */
const REFUSED_ATTACHMENTS = "(attachments not available to the app)";

/** The group a backup run writes into the `To` header of every post. */
export interface GroupAddress {
  readonly displayName: string | null;
  readonly mail: string | null;
}

export interface ConversationsPhaseOptions {
  readonly groupId: string;
  readonly group: GroupAddress;
}

/** The group key of a thread's posts in the object index. */
function threadGroup(threadId: string): string {
  return mailGroup(`${THREAD_GROUP_PREFIX}${threadId}`);
}

// ---------------------------------------------------------------------------
// MIME

/** RFC 5322 date (`Tue, 01 Oct 2024 08:30:00 +0000`) of an ISO timestamp; null when unusable. */
export function rfc5322Date(iso: string | null | undefined): string | null {
  const millis = toMillis(iso ?? undefined);
  if (!millis) {
    return null;
  }
  // toUTCString gives `Tue, 01 Oct 2024 08:30:00 GMT`; RFC 5322 prefers a numeric zone.
  return new Date(millis).toUTCString().replace(/GMT$/, "+0000");
}

/** A stable Message-ID for a post: Graph's post ids are not RFC 5322 ids. */
export function postMessageId(postId: string): string {
  return `<${createHash("sha256").update(postId, "utf8").digest("hex").slice(0, 32)}@group-conversation.invalid>`;
}

function mailboxOf(recipient: Recipient | null | undefined): string | null {
  const address = recipient?.emailAddress?.address?.trim();
  const name = recipient?.emailAddress?.name?.trim();
  if (!address && !name) {
    return null;
  }
  return formatMailbox(name ?? null, address ?? null);
}

function sameAddress(a: Recipient | null | undefined, b: Recipient | null | undefined): boolean {
  const left = a?.emailAddress?.address?.trim().toLowerCase();
  const right = b?.emailAddress?.address?.trim().toLowerCase();
  return !!left && left === right;
}

function isFileAttachment(attachment: Attachment): attachment is FileAttachment {
  return (
    (attachment as { "@odata.type"?: string })["@odata.type"] === "#microsoft.graph.fileAttachment"
  );
}

const ITEM_ATTACHMENT = "#microsoft.graph.itemAttachment";
const REFERENCE_ATTACHMENT = "#microsoft.graph.referenceAttachment";

function attachmentType(attachment: Attachment): string {
  return (
    (attachment as { "@odata.type"?: string })["@odata.type"] ?? "#microsoft.graph.fileAttachment"
  );
}

/** Bytes of an attachment read on its own (`/$value`): a file's content, an item's MIME. */
export interface FetchedAttachment {
  readonly bytes: Buffer;
  readonly contentType: string;
}

export interface BuiltPost {
  readonly bytes: Buffer;
  /** Attachments written as MIME parts (files, and items as message/rfc822). */
  readonly attachments: number;
  /** Link attachments, by name: their file lives in OneDrive or SharePoint. */
  readonly referenceAttachments: readonly string[];
  /** Attachments named in the post that are not in the message (could not be read). */
  readonly skippedAttachments: readonly string[];
}

/** The RFC 5322 message of one post. Deterministic: no generated ids, no clock. */
export function buildPostMessage(
  post: PostWithAttachments,
  thread: Pick<ThreadInfo, "id" | "topic">,
  group: GroupAddress,
  fetched: ReadonlyMap<string, FetchedAttachment> = new Map(),
): BuiltPost {
  const headers: HeaderField[] = [];
  const from = mailboxOf(post.from) ?? mailboxOf(post.sender);
  if (from) {
    headers.push(["From", from]);
  }
  if (post.sender && post.from && !sameAddress(post.sender, post.from)) {
    const sender = mailboxOf(post.sender);
    if (sender) {
      headers.push(["Sender", sender]);
    }
  }
  if (group.mail) {
    headers.push(["To", formatMailbox(group.displayName, group.mail)]);
  }
  const cc = (post.newParticipants ?? [])
    .map(mailboxOf)
    .filter((entry): entry is string => entry !== null);
  if (cc.length > 0) {
    headers.push(["Cc", cc.join(", ")]);
  }
  const topic = thread.topic?.trim() ?? "";
  if (topic) {
    headers.push(["Subject", encodeHeaderText(topic)]);
    headers.push(["Thread-Topic", encodeHeaderText(topic)]);
  }
  const date = rfc5322Date(post.receivedDateTime ?? post.createdDateTime);
  if (date) {
    headers.push(["Date", date]);
  }
  headers.push(["Message-ID", postMessageId(post.id)]);

  const content = post.body?.content ?? "";
  const body = textPart(post.body?.contentType === "text" ? "plain" : "html", content);
  const parts: MimePart[] = [];
  const skipped: string[] = [];
  const references: string[] = [];
  for (const attachment of post.attachments ?? []) {
    const type = attachmentType(attachment);
    const read = attachment.id ? fetched.get(attachment.id) : undefined;
    if (type === REFERENCE_ATTACHMENT) {
      references.push(attachment.name ?? "(unnamed)");
    } else if (isFileAttachment(attachment) && typeof attachment.contentBytes === "string") {
      parts.push(
        filePart({
          contentType: attachment.contentType ?? "application/octet-stream",
          fileName: attachment.name ?? null,
          disposition: attachment.isInline ? "inline" : "attachment",
          contentId: attachment.contentId ?? null,
          data: Buffer.from(attachment.contentBytes, "base64"),
        }),
      );
    } else if (read && type === ITEM_ATTACHMENT) {
      // A forwarded mail (or another item) as Graph's MIME of it: an attached message.
      parts.push(messagePart(itemFileName(attachment.name), read.bytes));
    } else if (read) {
      parts.push(
        filePart({
          contentType: attachment.contentType ?? read.contentType,
          fileName: attachment.name ?? null,
          disposition: attachment.isInline ? "inline" : "attachment",
          contentId: (attachment as FileAttachment).contentId ?? null,
          data: read.bytes,
        }),
      );
    } else {
      skipped.push(attachment.name ?? "(unnamed)");
    }
  }
  const root = parts.length > 0 ? multipart("mixed", [body, ...parts]) : body;
  return {
    bytes: serializeMessage(headers, root),
    attachments: parts.length,
    referenceAttachments: references,
    skippedAttachments: skipped,
  };
}

/** File name of an attached item: its subject with `.eml`. */
function itemFileName(name: string | null | undefined): string {
  const base = (name ?? "").trim() || "attached message";
  return /\.eml$/i.test(base) ? base : `${base}.eml`;
}

/**
 * Attachments the expansion lists without their bytes: item attachments always, a file
 * attachment when Graph left out `contentBytes`. Link attachments carry no bytes at all.
 */
function attachmentsToRead(post: PostWithAttachments): Attachment[] {
  return (post.attachments ?? []).filter((attachment) => {
    const type = attachmentType(attachment);
    if (!attachment.id || type === REFERENCE_ATTACHMENT) {
      return false;
    }
    return !(isFileAttachment(attachment) && typeof attachment.contentBytes === "string");
  });
}

async function readAll(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// The phase

/** Digest of what makes a post's stored bytes current. */
function postFingerprint(post: PostWithAttachments, expanded: boolean): string {
  return createHash("sha256")
    .update(
      [
        post.id,
        post.changeKey ?? "",
        post.lastModifiedDateTime ?? "",
        expanded ? "attachments" : "no-attachments",
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 16);
}

function addConversationFolders(run: BackupRun): void {
  if (!run.writer.has(MAIL_ROOT)) {
    run.index.put(folderObjectAt(MAIL_ROOT, undefined, { [META.folderKind]: "root" }));
  }
  run.index.put({
    ...folderObjectAt(CONVERSATIONS_PATH, CONVERSATIONS_FOLDER_ID, {
      [META.folderKind]: "mail",
      displayName: CONVERSATIONS_FOLDER,
      parentFolderId: "",
      isHidden: "false",
      [META.folderId]: CONVERSATIONS_FOLDER_ID,
      [META.folderPath]: CONVERSATIONS_FOLDER,
    }),
  });
}

class ConversationsPhase {
  /** Whether posts are still asked for with their attachments (cleared on the first refusal). */
  private expand = true;

  constructor(
    private readonly run: BackupRun,
    private readonly options: ConversationsPhaseOptions,
  ) {}

  private metadataOf(
    post: PostWithAttachments,
    thread: ThreadInfo,
    fingerprint: string,
    missing: readonly string[],
    references: readonly string[] = [],
  ): Record<string, string> {
    // Metadata is for display (the explorer, reports): plain text, never RFC 2047 words.
    const fromText = formatRecipient(post.from ?? post.sender);
    const cc = (post.newParticipants ?? []).map(formatRecipient).filter((e): e is string => !!e);
    const groupText = formatRecipient({
      emailAddress: {
        name: this.options.group.displayName ?? undefined,
        address: this.options.group.mail ?? undefined,
      },
    });
    const metadata: Record<string, string> = {
      [META.subject]: thread.topic ?? "",
      receivedDateTime: post.receivedDateTime ?? post.createdDateTime ?? "",
      lastModifiedDateTime: post.lastModifiedDateTime ?? "",
      // Posts have no read state; a restored conversation should not show up as unread mail.
      [META.isRead]: "true",
      [META.flagStatus]: "notFlagged",
      [META.categories]: JSON.stringify(post.categories ?? []),
      [META.hasAttachments]: String(post.hasAttachments === true),
      [META.to]: groupText ?? "",
      [META.toCount]: groupText ? "1" : "0",
      [META.cc]: cc.slice(0, 20).join(", "),
      [META.ccCount]: String(cc.length),
      [META.messageId]: postMessageId(post.id),
      [META.folderId]: `${THREAD_GROUP_PREFIX}${thread.id}`,
      [META.folderPath]: CONVERSATIONS_FOLDER,
      [META.format]: MESSAGE_FORMAT.mime,
      [META.contentType]: "message/rfc822",
      [META.fingerprint]: fingerprint,
      [POST_META.threadId]: thread.id,
      [POST_META.postId]: post.id,
    };
    if (fromText) {
      metadata[META.from] = fromText;
    }
    if (missing.length > 0) {
      metadata[POST_META.missingAttachments] = JSON.stringify(missing);
      // Refused to the app or not readable: either way not in the backup.
      metadata[POST_META.attachmentsNotBackedUp] = "true";
    }
    if (references.length > 0) {
      metadata[META.referenceAttachments] = JSON.stringify(references);
    }
    return metadata;
  }

  private async storePost(post: PostWithAttachments, thread: ThreadInfo): Promise<void> {
    const run = this.run;
    const path = mailObjectPath(CONVERSATIONS_PATH, thread.topic, post.id);
    const mtime = toMillis(post.receivedDateTime) || toMillis(post.createdDateTime);
    const fingerprint = postFingerprint(post, this.expand);
    const existing = run.index.get(OBJECT_TYPES.mail, post.id);
    // A post stored without some of its attachments is read again while the expansion works.
    if (run.reusable(existing, fingerprint) && !(this.expand && notBackedUp(existing))) {
      run.carryForward(existing, {
        path,
        mtime,
        metadata: this.metadataOf(
          post,
          thread,
          fingerprint,
          this.missingOf(existing),
          this.referencesOf(existing),
        ),
      });
      return;
    }
    const fetched = this.expand ? await this.readAttachments(post, thread) : new Map();
    const built = buildPostMessage(post, thread, this.options.group, fetched);
    const missing =
      !this.expand && post.hasAttachments === true
        ? [REFUSED_ATTACHMENTS]
        : built.skippedAttachments;
    await run.storeBytes(built.bytes, {
      path,
      id: post.id,
      type: OBJECT_TYPES.mail,
      mtime,
      metadata: this.metadataOf(post, thread, fingerprint, missing, built.referenceAttachments),
    });
  }

  /**
   * The bytes of the attachments the expansion listed without them ({@link attachmentsToRead}).
   * One that cannot be read is left out (the post records it as missing and the run warns).
   */
  private async readAttachments(
    post: PostWithAttachments,
    thread: ThreadInfo,
  ): Promise<Map<string, FetchedAttachment>> {
    const fetched = new Map<string, FetchedAttachment>();
    const parent = postPath(this.options.groupId, thread.id, post.id);
    for (const attachment of attachmentsToRead(post)) {
      this.run.throwIfAborted();
      const id = attachment.id as string;
      try {
        const bytes = await readAll(await openAttachmentContentAt(this.run.client, parent, id));
        fetched.set(id, {
          bytes,
          contentType: attachment.contentType ?? "application/octet-stream",
        });
      } catch (error) {
        if (!isItemLevelError(error) && !isVanished(error)) {
          throw error;
        }
        this.run.logger.warn("post attachment could not be read", {
          postId: post.id,
          attachmentId: id,
          type: attachmentType(attachment),
          error,
        });
      }
    }
    return fetched;
  }

  private referencesOf(existing: { metadata?: Record<string, string> }): string[] {
    return parseNames(existing.metadata?.[META.referenceAttachments]);
  }

  private missingOf(existing: { metadata?: Record<string, string> }): string[] {
    return parseNames(existing.metadata?.[POST_META.missingAttachments]);
  }

  /** Posts of a thread; switches off the attachment expansion once Graph refuses it. */
  private async *postsOf(thread: ThreadInfo): AsyncGenerator<PostWithAttachments, void, unknown> {
    const { client } = this.run;
    if (this.expand) {
      let yielded = false;
      try {
        for await (const post of listPosts(client, this.options.groupId, thread.id, {
          expandAttachments: true,
        })) {
          yielded = true;
          yield post;
        }
        return;
      } catch (error) {
        if (yielded || !isAttachmentExpansionRefused(error)) {
          throw error;
        }
        this.expand = false;
        this.run.logger.warn(
          "Graph refused post attachments to the app; posts are stored without them",
        );
      }
    }
    yield* listPosts(client, this.options.groupId, thread.id, { expandAttachments: false });
  }

  async syncThread(thread: ThreadInfo): Promise<boolean> {
    const run = this.run;
    const seen = new Set<string>();
    const ref = `${CONVERSATIONS_PATH}/${thread.topic ?? thread.id}`;
    try {
      for await (const post of this.postsOf(thread)) {
        run.throwIfAborted();
        if (!post.id) {
          continue;
        }
        seen.add(post.id);
        run.expectMore(1);
        try {
          await this.storePost(post, thread);
        } catch (error) {
          if (isItemLevelError(error)) {
            run.fail(mailObjectPath(CONVERSATIONS_PATH, thread.topic, post.id), error);
          } else {
            throw error;
          }
        }
        await run.maybeCheckpoint();
      }
    } catch (error) {
      if (isVanished(error)) {
        removeGroupItems(run, threadGroup(thread.id));
        return true;
      }
      if (!isItemLevelError(error)) {
        throw error;
      }
      // A partial view of the thread: keep what the snapshot has, prune nothing.
      run.fail(ref, error);
      return false;
    }
    removeUnseenItems(run, threadGroup(thread.id), OBJECT_TYPES.mail, seen);
    return true;
  }

  async execute(): Promise<void> {
    const run = this.run;
    addConversationFolders(run);
    const threads: ThreadInfo[] = [];
    try {
      for await (const thread of listThreads(run.client, this.options.groupId)) {
        run.throwIfAborted();
        if (thread.id) {
          threads.push(thread);
        }
      }
    } catch (error) {
      const wrapped = toMailboxAccessError(error, "group conversations");
      if (isNotFound(error) || !isItemLevelError(wrapped)) {
        throw wrapped;
      }
      run.fail(CONVERSATIONS_PATH, error);
      return;
    }
    run.logger.info("conversation threads enumerated", { threads: threads.length });

    const listed = new Set(threads.map((thread) => thread.id));
    for (const group of run.index.groups(mailGroup(THREAD_GROUP_PREFIX))) {
      const threadId = group.slice(mailGroup(THREAD_GROUP_PREFIX).length);
      if (!listed.has(threadId)) {
        removeGroupItems(run, group);
      }
    }
    const previous = run.state.conversationThreads;
    const next: Record<string, string> = {};
    for (const thread of threads) {
      run.throwIfAborted();
      const delivered = thread.lastDeliveredDateTime ?? "";
      const members = run.index.members(threadGroup(thread.id));
      const unchanged =
        !run.full &&
        delivered !== "" &&
        previous[thread.id] === delivered &&
        members.length > 0 &&
        // Posts stored without their attachments are read again while Graph may hand them out.
        !(this.expand && members.some(notBackedUp));
      if (unchanged) {
        next[thread.id] = delivered;
        continue;
      }
      if (await this.syncThread(thread)) {
        next[thread.id] = delivered;
      } else if (previous[thread.id] !== undefined) {
        // Not completely read: forget the marker so the next run lists the thread again.
        delete next[thread.id];
      }
    }
    run.state.conversationThreads = next;
    this.warnAboutRefusedAttachments();
  }

  /**
   * One warning per run while the restore point holds posts whose attachments Graph refused to
   * the app (also posts stored by an earlier run): the run is never plain green for them.
   */
  private warnAboutRefusedAttachments(): void {
    const run = this.run;
    let refused = 0;
    let unreadable = 0;
    for (const group of run.index.groups(mailGroup(THREAD_GROUP_PREFIX))) {
      for (const member of run.index.members(group).filter(notBackedUp)) {
        if (
          parseNames(member.metadata?.[POST_META.missingAttachments]).includes(REFUSED_ATTACHMENTS)
        ) {
          refused++;
        } else {
          unreadable++;
        }
      }
    }
    if (refused > 0) {
      const reason = `${refused} post(s) of the group conversations have attachments Graph did not hand to the app; they are backed up without them`;
      run.warn(
        CONVERSATIONS_PATH,
        reason,
        buildCause("graph.group_post_attachments_refused", { count: refused }, { message: reason }),
      );
    }
    if (unreadable > 0) {
      const reason = `${unreadable} post(s) of the group conversations have attachments that could not be read; they are backed up without them and read again on the next run`;
      run.warn(
        CONVERSATIONS_PATH,
        reason,
        buildCause(
          "graph.group_post_attachments_unreadable",
          { count: unreadable },
          { message: reason },
        ),
      );
    }
  }
}

function notBackedUp(object: { metadata?: Record<string, string> }): boolean {
  return object.metadata?.[POST_META.attachmentsNotBackedUp] === "true";
}

/** A JSON array of names, as stored in metadata; anything malformed reads as none. */
function parseNames(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

/** Back up the conversations of a group mailbox (resumable: skipped once done in this run). */
export async function backupConversations(
  run: BackupRun,
  options: ConversationsPhaseOptions,
): Promise<void> {
  if (run.progress.conversationsDone === true) {
    return;
  }
  run.enterPhase("conversations");
  await new ConversationsPhase(run, options).execute();
  run.progress.conversationsDone = true;
  await run.checkpoint();
}
