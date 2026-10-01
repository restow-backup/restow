/**
 * Group lookup for the protection rules editor: an admin picks the group by
 * name instead of pasting an object id. Graph supports `startswith` on
 * `displayName` for groups without advanced query headers, which is all a
 * type-ahead needs; an object id typed in directly is resolved as such.
 */
import type { GraphClient } from "../graph/client.js";
import { isNotFound } from "../graph/errors.js";
import { odataString, query, requestOk } from "../graph/resources/common.js";

/** Largest result list a type-ahead shows. */
export const GROUP_SEARCH_LIMIT = 25;

const GROUP_FIELDS = "id,displayName,description,mail,mailEnabled,securityEnabled,groupTypes";

const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GroupKind = "microsoft365" | "security" | "mail_security" | "distribution";

export interface GroupSummary {
  readonly id: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly mail: string | null;
  readonly kind: GroupKind;
}

interface GraphGroup {
  id: string;
  displayName?: string | null;
  description?: string | null;
  mail?: string | null;
  mailEnabled?: boolean | null;
  securityEnabled?: boolean | null;
  groupTypes?: string[] | null;
}

/** Classify a group the way the Entra admin center labels it. */
export function groupKindOf(
  group: Pick<GraphGroup, "groupTypes" | "mailEnabled" | "securityEnabled">,
): GroupKind {
  if ((group.groupTypes ?? []).some((type) => type.toLowerCase() === "unified")) {
    return "microsoft365";
  }
  if (group.securityEnabled) {
    return group.mailEnabled ? "mail_security" : "security";
  }
  return "distribution";
}

function toSummary(group: GraphGroup): GroupSummary {
  return {
    id: group.id,
    displayName: group.displayName ?? null,
    description: group.description ?? null,
    mail: group.mail ?? null,
    kind: groupKindOf(group),
  };
}

function byName(a: GroupSummary, b: GroupSummary): number {
  return (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id, undefined, {
    sensitivity: "base",
  });
}

/** One group by object id; null when it does not exist. */
export async function getGroup(client: GraphClient, groupId: string): Promise<GroupSummary | null> {
  try {
    const group = await requestOk<GraphGroup>(client, {
      method: "GET",
      url: `/groups/${encodeURIComponent(groupId)}${query({ $select: GROUP_FIELDS })}`,
    });
    return toSummary(group);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Groups whose display name starts with `text` (case-insensitive in Graph),
 * or the group with that object id. An empty text lists the first groups.
 */
export async function searchGroups(
  client: GraphClient,
  text: string,
  limit: number = GROUP_SEARCH_LIMIT,
): Promise<GroupSummary[]> {
  const term = text.trim();
  if (OBJECT_ID.test(term)) {
    const group = await getGroup(client, term);
    return group ? [group] : [];
  }
  const page = await requestOk<{ value?: GraphGroup[] }>(client, {
    method: "GET",
    url: `/groups${query({
      $select: GROUP_FIELDS,
      $top: Math.max(1, Math.min(limit, 100)),
      $filter: term ? `startswith(displayName,${odataString(term)})` : undefined,
    })}`,
  });
  return (page.value ?? []).map(toSummary).sort(byName);
}
