/**
 * Who belongs to which Microsoft 365 group (and so to its Team and its group-connected
 * SharePoint site), for the restore explorer's "Teams & sites" of a person (#89).
 *
 * Per group three reads, sent together through `$batch` (20 sub-requests per call, throttled
 * sub-responses retried by the client with Retry-After):
 *
 *   GET /groups/{id}/owners?$select=id&$top=999      owners (GroupMember.Read.All or Group.Read.All)
 *   GET /groups/{id}/members?$select=id&$top=999     direct members (groups of kind Unified do not nest)
 *   GET /groups/{id}/sites/root?$select=id           the group-connected site (Sites.Read.All)
 *
 * A listing with more than 999 entries continues on its `@odata.nextLink`, one page at a time.
 * Only users are kept (devices, contacts and service principals can be members too). Someone
 * Graph lists as owner and member is an owner.
 *
 * A group whose owners or members cannot be read (403 without the permission, a 429 or 5xx
 * that outlasted the client's retries) is reported as failed: the caller keeps its stored rows
 * and warns once, the sync goes on. A group that is gone (404) is skipped silently, the next
 * groups delta orphans it. Communication sites without a group have no membership Graph v1.0
 * exposes (their SharePoint groups are reachable only through the SharePoint REST API), so they
 * get no rows (docs/MICROSOFT.md).
 *
 * Nothing here touches a database; ./sync.ts hands the result to the repository group by group
 * as each is read, and writes whenever the rows it holds reach {@link MEMBERSHIP_FLUSH_ROWS}, so
 * memory stays at the first pages of one chunk plus the largest single group.
 */
import type { BatchRequest, BatchResponse, GraphClient } from "../graph/client.js";
import { isGraphError } from "../graph/errors.js";
import { type CollectionPage, paginate } from "../graph/resources/common.js";
import {
  type DirectoryObjectRef,
  groupMembersUrl,
  groupOwnersUrl,
  groupRootSiteUrl,
  isUserObject,
} from "../graph/resources/groups.js";

/** Groups read per chunk (three sub-requests each, so a chunk is a handful of `$batch` calls). */
export const MEMBERSHIP_CHUNK = 50;

/**
 * Membership rows (people per group, twice for a group with a site) the sync holds before it
 * writes them, so a chunk of "all employees" groups with tens of thousands of members each is
 * written in parts instead of all at once.
 */
export const MEMBERSHIP_FLUSH_ROWS = 20_000;

/** The membership of one Microsoft 365 group as Graph listed it. */
export interface GroupMembership {
  /** Entra object id of the group: the external id of its `group` object. */
  readonly groupId: string;
  /** Entra object ids of the users who own the group. */
  readonly owners: readonly string[];
  /** Entra object ids of the users who are members (owners may appear here as well). */
  readonly members: readonly string[];
  /**
   * Graph id of the group-connected site (the external id of its `site` object); null when the
   * group has none, undefined when it could not be read (the site keeps its stored rows).
   */
  readonly siteId?: string | null;
}

/** Why the membership of a group could not be read. */
export interface MembershipFailure {
  readonly groupId: string;
  readonly status: number;
  readonly code: string | null;
  readonly message: string;
}

export interface MembershipChunk {
  readonly read: readonly GroupMembership[];
  readonly failed: readonly MembershipFailure[];
}

/** One group of a chunk, as soon as it is read: its membership, or why it could not be read. */
export type MembershipOutcome =
  | { readonly read: GroupMembership; readonly failed?: undefined }
  | { readonly read?: undefined; readonly failed: MembershipFailure };

/** The rows a membership becomes: one per person, for the group and again for its site. */
export function membershipRowCount(membership: GroupMembership): number {
  const people = membership.owners.length + membership.members.length;
  return membership.siteId ? people * 2 : people;
}

type Role = "owner" | "member";

/** Every person of one group with their role; `owner` wins over `member`. */
export function membershipRoles(membership: GroupMembership): Map<string, Role> {
  const roles = new Map<string, Role>();
  for (const id of membership.members) {
    roles.set(id, "member");
  }
  for (const id of membership.owners) {
    roles.set(id, "owner");
  }
  return roles;
}

function failureOf(groupId: string, response: BatchResponse | null, error?: unknown) {
  if (error !== undefined && isGraphError(error)) {
    return {
      groupId,
      status: error.status,
      code: error.code ?? null,
      message: error.message.slice(0, 300),
    };
  }
  const body = response?.body as { error?: { code?: unknown; message?: unknown } } | undefined;
  const status = response?.status ?? 0;
  return {
    groupId,
    status,
    code: typeof body?.error?.code === "string" ? body.error.code : null,
    message: (typeof body?.error?.message === "string"
      ? body.error.message
      : `HTTP ${status}`
    ).slice(0, 300),
  };
}

const ok = (status: number) => status >= 200 && status < 300;

/**
 * The user ids of a listing: the first page from the batch, the rest on its next links. Throws
 * a GraphError when a later page fails (the caller turns it into a failed group).
 */
async function userIdsOf(client: GraphClient, first: CollectionPage<DirectoryObjectRef>) {
  const ids: string[] = [];
  for (const entry of first.value ?? []) {
    if (entry.id && isUserObject(entry)) {
      ids.push(entry.id);
    }
  }
  const next = first["@odata.nextLink"];
  if (next) {
    for await (const entry of paginate<DirectoryObjectRef>(client, next)) {
      if (entry.id && isUserObject(entry)) {
        ids.push(entry.id);
      }
    }
  }
  return ids;
}

/**
 * Read the membership of `groupIds` (one chunk; see {@link MEMBERSHIP_CHUNK}), yielding each
 * group as soon as its listings are complete, so the caller can write before the rest of the
 * chunk's large groups are paged through. Network errors and an aborted job propagate; Graph's
 * answers become `read` or `failed`; a group that is gone yields nothing.
 */
export async function* groupMembershipsOf(
  client: GraphClient,
  groupIds: readonly string[],
): AsyncGenerator<MembershipOutcome> {
  const requests: BatchRequest[] = groupIds.flatMap((groupId, index) => [
    { id: `${index}:owners`, method: "GET", url: groupOwnersUrl(groupId) },
    { id: `${index}:members`, method: "GET", url: groupMembersUrl(groupId) },
    { id: `${index}:site`, method: "GET", url: groupRootSiteUrl(groupId) },
  ]);
  let responses: BatchResponse[];
  try {
    responses = requests.length === 0 ? [] : await client.batch(requests);
  } catch (error) {
    // A `$batch` Graph refused as a whole (throttled past the retries, say): the chunk keeps
    // its stored rows and the run goes on.
    if (isGraphError(error)) {
      for (const groupId of groupIds) {
        yield { failed: failureOf(groupId, null, error) };
      }
      return;
    }
    throw error;
  }
  const byId = new Map(responses.map((response) => [response.id, response]));
  for (const [index, groupId] of groupIds.entries()) {
    const owners = byId.get(`${index}:owners`) ?? null;
    const members = byId.get(`${index}:members`) ?? null;
    const site = byId.get(`${index}:site`) ?? null;
    // The batch's answers of this group are no longer needed once it is read.
    byId.delete(`${index}:owners`);
    byId.delete(`${index}:members`);
    byId.delete(`${index}:site`);
    if (owners?.status === 404 || members?.status === 404) {
      // Deleted since the groups delta listed it; the next delta orphans it.
      continue;
    }
    const refused = [owners, members].find((response) => !response || !ok(response.status));
    if (refused !== undefined) {
      yield { failed: failureOf(groupId, refused) };
      continue;
    }
    let membership: GroupMembership;
    try {
      const ownerIds = await userIdsOf(
        client,
        (owners?.body ?? {}) as CollectionPage<DirectoryObjectRef>,
      );
      const memberIds = await userIdsOf(
        client,
        (members?.body ?? {}) as CollectionPage<DirectoryObjectRef>,
      );
      const siteId =
        site && ok(site.status)
          ? ((site.body as { id?: unknown } | undefined)?.id as string | undefined) || null
          : site?.status === 404
            ? null
            : undefined;
      membership = { groupId, owners: ownerIds, members: memberIds, siteId };
    } catch (error) {
      if (!isGraphError(error)) {
        throw error;
      }
      if (error.status === 404) {
        continue;
      }
      yield { failed: failureOf(groupId, null, error) };
      continue;
    }
    yield { read: membership };
  }
}

/** Read the membership of `groupIds` (one chunk) at once; see {@link groupMembershipsOf}. */
export async function readGroupMemberships(
  client: GraphClient,
  groupIds: readonly string[],
): Promise<MembershipChunk> {
  const read: GroupMembership[] = [];
  const failed: MembershipFailure[] = [];
  for await (const outcome of groupMembershipsOf(client, groupIds)) {
    if (outcome.read) {
      read.push(outcome.read);
    } else {
      failed.push(outcome.failed);
    }
  }
  return { read, failed };
}
