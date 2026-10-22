/**
 * Group mailbox discovery: the Microsoft 365 groups (Teams included) of a
 * tenant as protected objects of kind `group`, next to the users' mailboxes
 * and OneDrives and the SharePoint sites.
 *
 * Groups come from their own delta stream (`groups/delta`), stored next to
 * the users' delta link: the first run (and every full sync) enumerates all
 * groups of the tenant page by page, later runs read only the changed and
 * removed ones, so a tenant with thousands of groups costs a few pages per
 * run. Only Microsoft 365 groups (`groupTypes` contains `Unified`) have a
 * group mailbox; security and distribution groups are skipped.
 *
 * Planning is pure, like ./sites.ts: each group's status comes from its
 * override and the groups mode of the rules (`evaluateGroupMailboxProtection`,
 * opt-in by default). A removed group, and on a full enumeration a known
 * group the listing no longer has, is orphaned; its restore points stay.
 * Unchanged known groups are re-evaluated on every run, so a rule or
 * override change reaches them without a Graph call.
 *
 * Reading groups needs `Group.Read.All`, which the app has always required;
 * a refusal is reported as a warning and leaves the known groups as they are.
 */
import type { GraphClient } from "../graph/client.js";
import { type DeltaMode, InMemoryDeltaTokenStore } from "../graph/delta.js";
import { isGraphError } from "../graph/errors.js";
import {
  type GroupDeltaEntry,
  groupsDelta,
  isTeamGroup,
  isUnifiedGroup,
} from "../graph/resources/groups.js";
import {
  evaluateGroupMailboxProtection,
  type ProtectionOverrides,
  type ProtectionReason,
  type ProtectionRules,
} from "./rules.js";

/** Delta stream key of a source's groups. */
export const GROUPS_DELTA_KEY = "directory:groups";

/** A Microsoft 365 group the delta reported (created or changed). */
export interface DiscoveredGroupMailbox {
  /** Entra object id: the protected object's external id. */
  readonly id: string;
  readonly displayName: string | null;
  readonly mail: string | null;
  readonly isTeam: boolean;
}

/** A `group` object of the source as known before the run. */
export interface KnownGroupMailbox {
  readonly externalId: string;
  readonly status: "active" | "excluded" | "orphaned";
  readonly origin: "directory_sync" | "manual";
  readonly displayName: string | null;
}

/** A group row to insert or update. */
export interface PlannedGroupMailbox {
  readonly externalId: string;
  readonly displayName: string | null;
  readonly status: "active" | "excluded";
  readonly reason: ProtectionReason;
  readonly change: "created" | "updated" | "rescoped";
}

export interface GroupMailboxPlan {
  readonly groups: readonly PlannedGroupMailbox[];
  /** External ids of directory-sync groups to mark orphaned. */
  readonly orphanExternalIds: readonly string[];
  /** Microsoft 365 groups the delta reported; null when it could not be read. */
  readonly discovered: number | null;
}

/** What one read of the groups delta produced. */
export interface GroupDiscovery {
  readonly mode: DeltaMode;
  /** Microsoft 365 groups created or changed (the last entry per id wins). */
  readonly groups: readonly DiscoveredGroupMailbox[];
  /** Groups removed, or no longer Microsoft 365 groups. */
  readonly removedIds: readonly string[];
  /** The new delta link, committed with the rows. */
  readonly deltaLink: string;
  readonly pages: number;
}

/** Why groups could not be listed (a missing `Group.Read.All`, mostly). */
export interface GroupDiscoveryFailure {
  readonly status: number;
  readonly code: string | null;
  readonly message: string;
}

export type GroupDiscoveryResult =
  | ({ readonly ok: true } & GroupDiscovery)
  | { readonly ok: false; readonly failure: GroupDiscoveryFailure };

function isRemoved(entry: GroupDeltaEntry): boolean {
  return entry["@removed"] !== undefined;
}

/**
 * Read the groups delta from `deltaLink` (null: enumerate everything). A
 * refusal (401/403/400) comes back as a failure for the run to report;
 * throttling and server errors propagate and fail the run, which retries.
 * Memory: one small record per Microsoft 365 group the stream reports.
 */
export async function discoverGroupMailboxes(
  client: GraphClient,
  deltaLink: string | null,
  options: { onResync?: () => void; throwIfAborted?: () => void } = {},
): Promise<GroupDiscoveryResult> {
  // Staged in memory: the link reaches the database only with the committed rows.
  const staging = new InMemoryDeltaTokenStore();
  if (deltaLink) {
    await staging.set(GROUPS_DELTA_KEY, deltaLink);
  }
  const latest = new Map<string, GroupDeltaEntry>();
  const generator = groupsDelta(client, staging, {
    key: GROUPS_DELTA_KEY,
    onResync: options.onResync,
  });
  try {
    for (;;) {
      options.throwIfAborted?.();
      const next = await generator.next();
      if (next.done) {
        const groups: DiscoveredGroupMailbox[] = [];
        const removedIds: string[] = [];
        for (const entry of latest.values()) {
          if (isRemoved(entry) || !isUnifiedGroup(entry)) {
            removedIds.push(entry.id);
            continue;
          }
          groups.push({
            id: entry.id,
            displayName: entry.displayName?.trim() || entry.mail?.trim() || null,
            mail: entry.mail ?? null,
            isTeam: isTeamGroup(entry),
          });
        }
        return {
          ok: true,
          mode: next.value.mode,
          groups,
          removedIds,
          deltaLink: next.value.deltaLink,
          pages: next.value.pages,
        };
      }
      if (next.value.reset) {
        latest.clear();
      }
      for (const entry of next.value.items) {
        latest.set(entry.id, entry);
      }
    }
  } catch (error) {
    if (isGraphError(error) && error.status < 500 && error.status !== 429) {
      return {
        ok: false,
        failure: {
          status: error.status,
          code: error.code ?? null,
          message: error.message.slice(0, 300),
        },
      };
    }
    throw error;
  }
}

export interface GroupMailboxPlanInput {
  /** The delta read; null when it failed (known groups keep their place, only rules apply). */
  readonly discovery: GroupDiscovery | null;
  readonly known: readonly KnownGroupMailbox[];
  readonly rules: Pick<ProtectionRules, "groups">;
  readonly overrides: ProtectionOverrides;
}

/** The row changes for the group mailboxes of one run. Unchanged groups produce no write. */
export function planGroupMailboxes(input: GroupMailboxPlanInput): GroupMailboxPlan {
  const known = new Map(
    input.known
      .filter((group) => group.origin === "directory_sync")
      .map((group) => [group.externalId, group]),
  );
  const decide = (externalId: string) =>
    evaluateGroupMailboxProtection(input.rules, input.overrides[externalId] ?? null);
  const planned: PlannedGroupMailbox[] = [];
  const touched = new Set<string>();
  const orphanExternalIds: string[] = [];
  const discovery = input.discovery;

  if (discovery !== null) {
    for (const group of discovery.groups) {
      touched.add(group.id);
      const decision = decide(group.id);
      const before = known.get(group.id);
      if (!before) {
        planned.push({
          externalId: group.id,
          displayName: group.displayName,
          ...decision,
          change: "created",
        });
        continue;
      }
      // An orphaned group that shows up again (restored from the recycle bin) comes back:
      // its status differs from any decision.
      if (before.status !== decision.status || before.displayName !== group.displayName) {
        planned.push({
          externalId: group.id,
          displayName: group.displayName,
          ...decision,
          change: before.displayName === group.displayName ? "rescoped" : "updated",
        });
      }
    }
    for (const id of discovery.removedIds) {
      touched.add(id);
      const before = known.get(id);
      if (before && before.status !== "orphaned") {
        orphanExternalIds.push(id);
      }
    }
    if (discovery.mode !== "incremental") {
      // A full enumeration names every group: a known one it did not name is gone.
      for (const group of known.values()) {
        if (!touched.has(group.externalId) && group.status !== "orphaned") {
          touched.add(group.externalId);
          orphanExternalIds.push(group.externalId);
        }
      }
    }
  }

  // Everything else keeps its place; only a rule or override change moves it.
  for (const group of known.values()) {
    if (touched.has(group.externalId) || group.status === "orphaned") {
      continue;
    }
    const decision = decide(group.externalId);
    if (decision.status !== group.status) {
      planned.push({
        externalId: group.externalId,
        displayName: group.displayName,
        ...decision,
        change: "rescoped",
      });
    }
  }
  return {
    groups: planned,
    orphanExternalIds,
    discovered: discovery === null ? null : discovery.groups.length,
  };
}
