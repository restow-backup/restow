/**
 * Microsoft 365 group mailboxes: the groups themselves (directory sync,
 * `groups/delta`) and their conversations (threads and posts).
 *
 * A Microsoft 365 group (`groupTypes` contains `Unified`; Teams are such
 * groups with `resourceProvisioningOptions` containing `Team`) has an
 * Exchange group mailbox with one calendar and the group conversations.
 * Security and distribution groups have neither and are left out.
 *
 * Application permissions (Graph v1.0, docs/MICROSOFT.md):
 *   groups/delta, GET /groups/{id}          Group.Read.All (or Directory.Read.All)
 *   /groups/{id}/threads, .../posts         Group.Read.All (least: Group-Conversation.Read.All)
 *   /groups/{id}/calendarView               Calendars.Read(Write)
 *   POST threads, reply                     delegated only; an app cannot post
 * The calendar is handled by ./calendar.ts with a group {@link MailboxOwner}.
 */
import type { ConversationThread, Group, Post } from "@microsoft/microsoft-graph-types";
import type { GraphClient } from "../client.js";
import { type DeltaBatch, type DeltaSummary, type DeltaTokenStore, syncDelta } from "../delta.js";
import { isGraphError } from "../errors.js";
import { groupPath, paginate, query, requestOk } from "./common.js";

/** Properties the directory sync needs per group. */
export const GROUP_MAILBOX_SELECT = [
  "id",
  "displayName",
  "description",
  "mail",
  "mailEnabled",
  "groupTypes",
  "resourceProvisioningOptions",
] as const;

/**
 * The subset of {@link Group} the select list guarantees. The Graph types
 * package lacks `resourceProvisioningOptions` (it is a v1.0 property all the same).
 */
export type GroupMailboxInfo = Pick<
  Group,
  "displayName" | "description" | "mail" | "mailEnabled" | "groupTypes"
> & {
  id: string;
  resourceProvisioningOptions?: string[] | null;
};

/** Delta entries carry the group or, for deletions, only the id plus `@removed`. */
export type GroupDeltaEntry = Partial<GroupMailboxInfo> & {
  id: string;
  "@removed"?: { reason?: string };
};

/** True for a Microsoft 365 group (the only kind with a group mailbox). */
export function isUnifiedGroup(group: Pick<Group, "groupTypes">): boolean {
  return (group.groupTypes ?? []).some((type) => type.toLowerCase() === "unified");
}

/** True when the Microsoft 365 group backs a team in Microsoft Teams. */
export function isTeamGroup(group: Pick<GroupMailboxInfo, "resourceProvisioningOptions">): boolean {
  return (group.resourceProvisioningOptions ?? []).some(
    (option) => option.toLowerCase() === "team",
  );
}

/** The URL of a full groups/delta enumeration. */
export function groupsDeltaUrl(): string {
  return `/groups/delta${query({ $select: GROUP_MAILBOX_SELECT.join(",") })}`;
}

/**
 * Groups delta stream: the first run enumerates every group of the tenant
 * (paged by Graph), later runs read only the changes and removals. Membership
 * changes are not selected, so they do not wake the stream.
 */
export function groupsDelta(
  client: GraphClient,
  store: DeltaTokenStore,
  options: { key?: string; onResync?: () => void } = {},
): AsyncGenerator<DeltaBatch<GroupDeltaEntry>, DeltaSummary, unknown> {
  return syncDelta<GroupDeltaEntry>({
    client,
    store,
    key: options.key ?? "directory:groups",
    initialUrl: groupsDeltaUrl(),
    onResync: options.onResync,
  });
}

/** One group by id with the directory properties. */
export async function getGroupMailbox(
  client: GraphClient,
  groupId: string,
): Promise<GroupMailboxInfo> {
  return requestOk<GroupMailboxInfo>(client, {
    method: "GET",
    url: `${groupPath(groupId)}${query({ $select: GROUP_MAILBOX_SELECT.join(",") })}`,
  });
}

// ---------------------------------------------------------------------------
// Conversations

/** The default properties of a thread (Graph returns them without `$select`). */
export type ThreadInfo = Pick<
  ConversationThread,
  "topic" | "lastDeliveredDateTime" | "hasAttachments" | "preview" | "uniqueSenders" | "isLocked"
> & { id: string };

/** Every conversation thread of a group. */
export function listThreads(
  client: GraphClient,
  groupId: string,
): AsyncGenerator<ThreadInfo, void, unknown> {
  return paginate<ThreadInfo>(client, `${groupPath(groupId)}/threads`);
}

/** A post with its file attachments' bytes when Graph expanded them. */
export type PostWithAttachments = Post & { id: string };

/**
 * The posts of a thread. With `expandAttachments` the file attachments come
 * inline (`contentBytes`); Graph documents listing post attachments as
 * delegated only, so the caller retries without the expansion when it is
 * refused ({@link isAttachmentExpansionRefused}).
 */
export function listPosts(
  client: GraphClient,
  groupId: string,
  threadId: string,
  options: { expandAttachments: boolean },
): AsyncGenerator<PostWithAttachments, void, unknown> {
  const url = `${groupPath(groupId)}/threads/${encodeURIComponent(threadId)}/posts${query({
    $expand: options.expandAttachments ? "attachments" : undefined,
  })}`;
  return paginate<PostWithAttachments>(client, url);
}

/** The URL of a post below its group: the parent of its attachments. */
export function postPath(groupId: string, threadId: string, postId: string): string {
  return `${groupPath(groupId)}/threads/${encodeURIComponent(threadId)}/posts/${encodeURIComponent(postId)}`;
}

/** Graph refused `$expand=attachments` on posts for the app (403, or a 400 about it). */
export function isAttachmentExpansionRefused(error: unknown): boolean {
  if (!isGraphError(error)) {
    return false;
  }
  return (
    error.status === 403 ||
    (error.status === 400 && /expand|attachment|not\s*supported/i.test(error.message))
  );
}

// ---------------------------------------------------------------------------
// Membership (the restore explorer's "Teams & sites" of a person, #89)

/** Largest page Graph serves for `/members` and `/owners`. */
export const GROUP_MEMBERS_PAGE_SIZE = 999;

/**
 * The owners of a group, ids only. Application permissions: GroupMember.Read.All (least),
 * Group.Read.All, Directory.Read.All; Restow has Group.Read.All.
 */
export function groupOwnersUrl(groupId: string): string {
  return `${groupPath(groupId)}/owners${query({ $select: "id", $top: GROUP_MEMBERS_PAGE_SIZE })}`;
}

/** The direct members of a group, ids only (Microsoft 365 groups do not nest). Same permissions. */
export function groupMembersUrl(groupId: string): string {
  return `${groupPath(groupId)}/members${query({ $select: "id", $top: GROUP_MEMBERS_PAGE_SIZE })}`;
}

/** The group-connected SharePoint site of a group (Sites.Read.All). */
export function groupRootSiteUrl(groupId: string): string {
  return `${groupPath(groupId)}/sites/root${query({ $select: "id" })}`;
}

/** A directory object of a member or owner listing; `@odata.type` names users, devices, ... */
export interface DirectoryObjectRef {
  id: string;
  "@odata.type"?: string;
}

/** True for a user (the only kind of member a person's entry can show). */
export function isUserObject(entry: DirectoryObjectRef): boolean {
  const type = entry["@odata.type"];
  return type === undefined || type.toLowerCase() === "#microsoft.graph.user";
}
