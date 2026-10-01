/**
 * Directory resources: users (full list and delta), groups and their members,
 * deleted users, and the organisation record.
 *
 * Shared mailboxes and room/equipment mailboxes are ordinary user objects with
 * `accountEnabled = false` and no licence, so the user list is never filtered on
 * `accountEnabled`; protection rules decide what to back up (docs/MICROSOFT.md).
 */
import type { Group, Organization, User } from "@microsoft/microsoft-graph-types";
import type { GraphClient } from "../client.js";
import { type DeltaBatch, type DeltaSummary, type DeltaTokenStore, syncDelta } from "../delta.js";
import { collect, odataString, paginate, query, requestOk } from "./common.js";

/** Properties Restow needs per user for directory sync and protection rules. */
export const USER_SELECT = [
  "id",
  "userPrincipalName",
  "displayName",
  "givenName",
  "surname",
  "mail",
  "mailNickname",
  "proxyAddresses",
  "accountEnabled",
  "userType",
  "jobTitle",
  "department",
  "assignedLicenses",
  "assignedPlans",
  "onPremisesSyncEnabled",
  "createdDateTime",
  "deletedDateTime",
] as const;

/** The subset of {@link User} the select list guarantees. */
export type DirectoryUser = Pick<User, (typeof USER_SELECT)[number]> & { id: string };

/** Largest page size Graph allows for users. */
const USERS_PAGE_SIZE = 999;

/** Enumerate every user object (members, guests, disabled accounts) of the tenant. */
export function listUsers(client: GraphClient): AsyncGenerator<DirectoryUser, void, unknown> {
  const url = `/users${query({ $select: USER_SELECT.join(","), $top: USERS_PAGE_SIZE })}`;
  return paginate<DirectoryUser>(client, url);
}

export async function getUser(client: GraphClient, userId: string): Promise<DirectoryUser> {
  return requestOk<DirectoryUser>(client, {
    method: "GET",
    url: `/users/${encodeURIComponent(userId)}${query({ $select: USER_SELECT.join(",") })}`,
  });
}

/** The URL of a full users/delta enumeration. */
export function usersDeltaUrl(): string {
  return `/users/delta${query({ $select: USER_SELECT.join(",") })}`;
}

/** Delta entries carry the user or, for deletions, only the id plus `@removed`. */
export type UserDeltaEntry = Partial<DirectoryUser> & {
  id: string;
  "@removed"?: { reason?: string };
};

/**
 * Users delta stream (initial full enumeration, then only changes and removals).
 * The key `directory:users` is stored in the given store.
 */
export function usersDelta(
  client: GraphClient,
  store: DeltaTokenStore,
  options: { key?: string; onResync?: () => void } = {},
): AsyncGenerator<DeltaBatch<UserDeltaEntry>, DeltaSummary, unknown> {
  return syncDelta<UserDeltaEntry>({
    client,
    store,
    key: options.key ?? "directory:users",
    initialUrl: usersDeltaUrl(),
    onResync: options.onResync,
  });
}

/**
 * Heuristic for shared mailboxes: Graph does not expose the Exchange recipient type,
 * but shared and resource mailboxes are member accounts that are sign-in disabled and
 * still have an SMTP address. Licensed users that were merely blocked look the same;
 * the UI labels this as "shared or blocked" and lets the admin decide.
 */
export function looksLikeSharedMailbox(
  user: Pick<User, "accountEnabled" | "mail" | "userType">,
): boolean {
  return user.accountEnabled === false && !!user.mail && (user.userType ?? "Member") === "Member";
}

/** True when the user has at least one assigned licence (any SKU). */
export function isLicensed(user: Pick<User, "assignedLicenses">): boolean {
  return (user.assignedLicenses?.length ?? 0) > 0;
}

/**
 * True when an Exchange Online plan is provisioned and enabled for the user. Shared
 * mailboxes have no plan and still have a mailbox, so this is a hint, not a gate.
 */
export function hasExchangePlan(user: Pick<User, "assignedPlans">): boolean {
  return (user.assignedPlans ?? []).some(
    (plan) =>
      plan.service?.toLowerCase() === "exchange" &&
      (plan.capabilityStatus === undefined ||
        plan.capabilityStatus === null ||
        plan.capabilityStatus === "Enabled"),
  );
}

export const GROUP_SELECT = [
  "id",
  "displayName",
  "description",
  "mail",
  "mailEnabled",
  "securityEnabled",
  "groupTypes",
  "onPremisesSyncEnabled",
] as const;

export type DirectoryGroup = Pick<Group, (typeof GROUP_SELECT)[number]> & { id: string };

export function listGroups(client: GraphClient): AsyncGenerator<DirectoryGroup, void, unknown> {
  const url = `/groups${query({ $select: GROUP_SELECT.join(","), $top: USERS_PAGE_SIZE })}`;
  return paginate<DirectoryGroup>(client, url);
}

/** Find groups by display name (exact match) for protection rules typed by an admin. */
export async function findGroupsByName(
  client: GraphClient,
  displayName: string,
): Promise<DirectoryGroup[]> {
  const url = `/groups${query({
    $select: GROUP_SELECT.join(","),
    $filter: `displayName eq ${odataString(displayName)}`,
  })}`;
  return collect(paginate<DirectoryGroup>(client, url));
}

/**
 * Members of a group that are users. `transitive` resolves nested groups, which is
 * what a protection rule "everyone in group X" means to an admin.
 */
export function listGroupMemberUsers(
  client: GraphClient,
  groupId: string,
  options: { transitive?: boolean } = {},
): AsyncGenerator<DirectoryUser, void, unknown> {
  const segment = options.transitive === false ? "members" : "transitiveMembers";
  const url = `/groups/${encodeURIComponent(groupId)}/${segment}/microsoft.graph.user${query({
    $select: USER_SELECT.join(","),
    $top: USERS_PAGE_SIZE,
  })}`;
  return paginate<DirectoryUser>(client, url);
}

/** Ids of all (transitive) user members of a group, for fast rule evaluation. */
export async function listGroupMemberIds(
  client: GraphClient,
  groupId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const url = `/groups/${encodeURIComponent(groupId)}/transitiveMembers/microsoft.graph.user${query(
    {
      $select: "id",
      $top: USERS_PAGE_SIZE,
    },
  )}`;
  for await (const member of paginate<{ id: string }>(client, url)) {
    ids.add(member.id);
  }
  return ids;
}

/** Users deleted in Entra within the last 30 days (Graph keeps them that long). */
export function listDeletedUsers(
  client: GraphClient,
): AsyncGenerator<DirectoryUser, void, unknown> {
  const url = `/directory/deletedItems/microsoft.graph.user${query({
    $select: USER_SELECT.join(","),
    $top: USERS_PAGE_SIZE,
  })}`;
  return paginate<DirectoryUser>(client, url);
}

export const ORGANIZATION_SELECT = [
  "id",
  "displayName",
  "verifiedDomains",
  "tenantType",
  "countryLetterCode",
  "preferredLanguage",
] as const;

export type TenantOrganization = Pick<Organization, (typeof ORGANIZATION_SELECT)[number]> & {
  id: string;
};

/** The organisation record of the tenant the token belongs to (there is exactly one). */
export async function getOrganization(client: GraphClient): Promise<TenantOrganization> {
  const page = await requestOk<{ value?: TenantOrganization[] }>(client, {
    method: "GET",
    url: `/organization${query({ $select: ORGANIZATION_SELECT.join(",") })}`,
  });
  const organization = page.value?.[0];
  if (!organization) {
    throw new Error("Graph returned no organization for this tenant");
  }
  return organization;
}

/** The initial (default) domain of the tenant, e.g. `contoso.onmicrosoft.com`. */
export function initialDomainOf(organization: TenantOrganization): string | undefined {
  const domains = organization.verifiedDomains ?? [];
  return (domains.find((d) => d.isInitial) ?? domains.find((d) => d.isDefault))?.name ?? undefined;
}
