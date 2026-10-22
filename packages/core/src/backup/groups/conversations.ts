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
 * (`missingAttachments`), so nothing is lost silently.
 */
import { createHash } from "node:crypto";
import type { Attachment, FileAttachment, Recipient } from "@microsoft/microsoft-graph-types";
import { isNotFound } from "../../graph/errors.js";
import {
  isAttachmentExpansionRefused,
  listPosts,
  listThreads,
  type PostWithAttachments,
  type ThreadInfo,
} from "../../graph/resources/groups.js";
import {
  encodeHeaderText,
  filePart,
  formatMailbox,
  type HeaderField,
  type MimePart,
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
  /** Names of file attachments Graph did not hand out (expansion refused). */
  missingAttachments: "missingAttachments",
} as const;

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

export interface BuiltPost {
  readonly bytes: Buffer;
  /** File attachments written as MIME parts. */
  readonly attachments: number;
  /** Attachments named in the post that could not be included (link or item attachments). */
  readonly skippedAttachments: readonly string[];
}

/** The RFC 5322 message of one post. Deterministic: no generated ids, no clock. */
export function buildPostMessage(
  post: PostWithAttachments,
  thread: Pick<ThreadInfo, "id" | "topic">,
  group: GroupAddress,
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
  for (const attachment of post.attachments ?? []) {
    if (isFileAttachment(attachment) && typeof attachment.contentBytes === "string") {
      parts.push(
        filePart({
          contentType: attachment.contentType ?? "application/octet-stream",
          fileName: attachment.name ?? null,
          disposition: attachment.isInline ? "inline" : "attachment",
          contentId: attachment.contentId ?? null,
          data: Buffer.from(attachment.contentBytes, "base64"),
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
    skippedAttachments: skipped,
  };
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
    }
    return metadata;
  }

  private async storePost(post: PostWithAttachments, thread: ThreadInfo): Promise<void> {
    const run = this.run;
    const path = mailObjectPath(CONVERSATIONS_PATH, thread.topic, post.id);
    const mtime = toMillis(post.receivedDateTime) || toMillis(post.createdDateTime);
    const fingerprint = postFingerprint(post, this.expand);
    const existing = run.index.get(OBJECT_TYPES.mail, post.id);
    if (run.reusable(existing, fingerprint)) {
      run.carryForward(existing, {
        path,
        mtime,
        metadata: this.metadataOf(post, thread, fingerprint, this.missingOf(existing)),
      });
      return;
    }
    const built = buildPostMessage(post, thread, this.options.group);
    const missing =
      !this.expand && post.hasAttachments === true
        ? ["(attachments not available to the app)"]
        : built.skippedAttachments;
    await run.storeBytes(built.bytes, {
      path,
      id: post.id,
      type: OBJECT_TYPES.mail,
      mtime,
      metadata: this.metadataOf(post, thread, fingerprint, missing),
    });
  }

  private missingOf(existing: { metadata?: Record<string, string> }): string[] {
    const raw = existing.metadata?.[POST_META.missingAttachments];
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
      const unchanged =
        !run.full &&
        delivered !== "" &&
        previous[thread.id] === delivered &&
        run.index.members(threadGroup(thread.id)).length > 0;
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
