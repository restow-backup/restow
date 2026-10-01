/**
 * Planning: turn one users/delta run into the row changes the directory needs.
 *
 * Pure functions over plain data. The orchestrator (./sync.ts) feeds them the
 * delta entries, the probe results and what earlier runs stored; they answer
 * with the users to upsert, the protected objects that changed, the objects to
 * mark orphaned and the next shared/blocked set. Nothing here talks to Graph
 * or a database, which is what makes the delta semantics testable with fixtures.
 *
 * Identity of a protected object (`external_id`):
 *   - mailbox:  the user's Entra object id. Stable across renames, and Graph
 *               accepts it wherever it accepts an address (`/users/{id}/...`).
 *               The address lives on the linked `users` row.
 *   - onedrive: the drive id (`/drives/{id}/root/delta`).
 * A guest has neither a mailbox nor a OneDrive in the tenant, so the sync
 * records the user and creates no objects.
 *
 * Every run re-evaluates every known object, not only those of the users the
 * delta reported: rule edits, override resets and group membership changes
 * (which users/delta never reports) must reach unchanged users as well. Their
 * facts come from what the sync stored before ({@link KnownOwner} and the
 * shared/blocked set), so no extra Graph call is needed.
 */
import type { DeltaMode } from "../graph/delta.js";
import type { UserDeltaEntry } from "../graph/resources/users.js";
import {
  type ProtectionDecision,
  type ProtectionOverrides,
  type ProtectionReason,
  type ProtectionRules,
  type ProtectionSubject,
  evaluateProtection,
  isSharedOrBlocked,
} from "./rules.js";

export type DirectoryObjectKind = "mailbox" | "onedrive";
export type ObjectStatus = "active" | "excluded" | "orphaned";
export type ObjectOrigin = "directory_sync" | "manual";

/** A user as the sync stores it: the `users` row plus the facts the rules need. */
export interface DirectoryUserRecord {
  readonly entraObjectId: string;
  /** Primary address: `mail`, falling back to the UPN. Never empty. */
  readonly email: string;
  readonly upn: string | null;
  readonly mail: string | null;
  readonly displayName: string | null;
  /** Null when unknown. */
  readonly accountEnabled: boolean | null;
  /** `Member` or `Guest`; null when unknown. */
  readonly userType: string | null;
}

/** The directory user a known object belongs to, as stored by an earlier run. */
export interface KnownOwner {
  readonly entraObjectId: string;
  readonly upn: string | null;
  readonly email: string;
}

/** A protected object of the source as known before the run. */
export interface KnownObject {
  readonly externalId: string;
  readonly kind: DirectoryObjectKind;
  readonly status: ObjectStatus;
  readonly origin: ObjectOrigin;
  readonly displayName: string | null;
  /** Null when the link to its user is gone. */
  readonly owner: KnownOwner | null;
}

/** What the probes found out about one user. `undefined` means "unknown". */
export interface UserProbe {
  /** Whether Exchange Online hosts a mailbox for the user. */
  readonly mailbox?: boolean;
  /** Drive id of the user's OneDrive, or null when none is provisioned. */
  readonly driveId?: string | null;
}

/**
 * How an object entered the plan: new, changed with its user (the delta
 * reported the user), or re-scoped although its user did not change (rules,
 * overrides or group membership moved).
 */
export type ObjectChange = "created" | "updated" | "rescoped";

/** A protected object row to insert or update. */
export interface PlannedObject {
  readonly kind: DirectoryObjectKind;
  readonly externalId: string;
  /** Entra object id of the owning user. */
  readonly ownerId: string;
  readonly displayName: string | null;
  readonly status: "active" | "excluded";
  readonly reason: ProtectionReason;
  readonly change: ObjectChange;
}

export interface PlanCounts {
  /** Complete user records processed in this run. */
  readonly users: number;
  readonly removedUsers: number;
  /** Guests seen (recorded, never protected). */
  readonly guests: number;
  readonly created: number;
  readonly updated: number;
  readonly rescoped: number;
  /** Objects newly marked orphaned. */
  readonly orphaned: number;
}

export interface DirectoryPlan {
  /** Users seen in this run, complete, to upsert. */
  readonly users: readonly DirectoryUserRecord[];
  /** Entra object ids the directory reported as removed. */
  readonly removedUserIds: readonly string[];
  /** Objects to insert or update; unchanged objects are left out. */
  readonly objects: readonly PlannedObject[];
  /** External ids of directory-sync objects to mark orphaned. */
  readonly orphanExternalIds: readonly string[];
  /** Users that are sign-in disabled members with an address, after this run. */
  readonly sharedOrBlockedIds: readonly string[];
  readonly counts: PlanCounts;
}

/**
 * Properties a complete entry carries (null when unset). A missing one marks a
 * partial entry, which Graph sends with `Prefer: return=minimal` and for some
 * property classes; such an entry needs a follow-up read before the rules can
 * judge it, otherwise a missing `mail` would read as "no mailbox".
 */
const REQUIRED_PROPERTIES = [
  "userPrincipalName",
  "displayName",
  "mail",
  "accountEnabled",
  "userType",
] as const;

/** True for `@removed` entries: the user left the directory (or the sync scope). */
export function isRemovedEntry(entry: UserDeltaEntry): boolean {
  return entry["@removed"] !== undefined;
}

/** True when a delta entry lacks properties the rules need. */
export function isPartialEntry(entry: UserDeltaEntry): boolean {
  if (isRemovedEntry(entry)) {
    return false;
  }
  return REQUIRED_PROPERTIES.some((property) => entry[property] === undefined);
}

/** Build the stored user record from a complete entry; null for partial or removed ones. */
export function toDirectoryUser(entry: UserDeltaEntry): DirectoryUserRecord | null {
  if (isRemovedEntry(entry) || isPartialEntry(entry)) {
    return null;
  }
  const upn = entry.userPrincipalName?.trim() || null;
  const mail = entry.mail?.trim() || null;
  const email = mail ?? upn;
  if (!email) {
    return null;
  }
  return {
    entraObjectId: entry.id,
    email,
    upn,
    mail,
    displayName: entry.displayName?.trim() || null,
    accountEnabled: typeof entry.accountEnabled === "boolean" ? entry.accountEnabled : null,
    userType: entry.userType ?? null,
  };
}

export function isGuest(user: Pick<DirectoryUserRecord, "userType">): boolean {
  return (user.userType ?? "Member").toLowerCase() === "guest";
}

/** The rule subject of a user seen in this run. */
export function subjectOf(user: DirectoryUserRecord): ProtectionSubject {
  return {
    entraObjectId: user.entraObjectId,
    upn: user.upn,
    mail: user.mail,
    sharedOrBlocked: isSharedOrBlocked(user),
  };
}

/** The rule subject of an unchanged user, from what an earlier run stored. */
export function storedSubject(
  owner: KnownOwner,
  sharedOrBlockedIds: ReadonlySet<string>,
): ProtectionSubject {
  return {
    entraObjectId: owner.entraObjectId,
    upn: owner.upn,
    mail: owner.email,
    sharedOrBlocked: sharedOrBlockedIds.has(owner.entraObjectId),
  };
}

/**
 * Which users to probe. Mailboxes: members with an address (Exchange gives
 * every mailbox one). Drives: every member, blocked ones included, because a
 * departed employee's OneDrive is exactly what must not get lost.
 */
export function probeTargets(users: readonly DirectoryUserRecord[]): {
  mailbox: string[];
  drive: string[];
} {
  const members = users.filter((user) => !isGuest(user));
  return {
    mailbox: members.filter((user) => user.mail !== null).map((user) => user.entraObjectId),
    drive: members.map((user) => user.entraObjectId),
  };
}

/**
 * Whether the user gets a mailbox object. A probe answer is authoritative; a
 * failed probe falls back to the address heuristic (and the run reports it).
 */
export function hasMailbox(user: DirectoryUserRecord, probe: UserProbe | undefined): boolean {
  if (isGuest(user)) {
    return false;
  }
  return probe?.mailbox ?? user.mail !== null;
}

export interface PlanInput {
  /** `initial` and `resync` enumerated everything; `incremental` carries only changes. */
  readonly mode: DeltaMode;
  /** Complete user records seen in this run. */
  readonly users: readonly DirectoryUserRecord[];
  /** Entra object ids reported as removed in this run. */
  readonly removedUserIds: readonly string[];
  readonly known: readonly KnownObject[];
  /** The shared/blocked set as stored by the previous run. */
  readonly sharedOrBlockedIds: ReadonlySet<string>;
  /** Probe answers per Entra object id; a user without an entry was not probed. */
  readonly probes: ReadonlyMap<string, UserProbe>;
  readonly rules: ProtectionRules;
  readonly overrides: ProtectionOverrides;
  /** Transitive members of the rule group; null when unresolved or not in group mode. */
  readonly groupMemberIds: ReadonlySet<string> | null;
}

type Candidate = Omit<PlannedObject, "change">;

/** Compute the row changes of one run. */
export function planDirectory(input: PlanInput): DirectoryPlan {
  const full = input.mode !== "incremental";
  const removed = new Set(input.removedUserIds);
  const seen = new Set(input.users.map((user) => user.entraObjectId));

  const knownById = new Map<string, KnownObject>();
  const byOwner = new Map<string, KnownObject[]>();
  const unlinked: KnownObject[] = [];
  for (const known of input.known) {
    if (known.origin !== "directory_sync") {
      continue;
    }
    knownById.set(known.externalId, known);
    if (known.owner) {
      const list = byOwner.get(known.owner.entraObjectId) ?? [];
      list.push(known);
      byOwner.set(known.owner.entraObjectId, list);
    } else {
      unlinked.push(known);
    }
  }

  const objects: PlannedObject[] = [];
  const placed = new Set<string>();
  const orphan = new Set<string>();
  let guests = 0;

  const decide = (subject: ProtectionSubject, externalId: string): ProtectionDecision =>
    evaluateProtection({
      subject,
      rules: input.rules,
      override: input.overrides[externalId] ?? null,
      groupMemberIds: input.groupMemberIds,
    });

  const markOrphan = (object: KnownObject) => {
    if (object.status !== "orphaned") {
      orphan.add(object.externalId);
    }
  };

  /** Record a candidate; unchanged objects produce no write. */
  const place = (candidate: Candidate, unchangedUser: boolean) => {
    placed.add(candidate.externalId);
    const known = knownById.get(candidate.externalId);
    if (!known) {
      objects.push({ ...candidate, change: "created" });
      return;
    }
    const same =
      known.status === candidate.status &&
      known.displayName === candidate.displayName &&
      known.owner?.entraObjectId === candidate.ownerId;
    if (!same) {
      objects.push({ ...candidate, change: unchangedUser ? "rescoped" : "updated" });
    }
  };

  for (const user of input.users) {
    const owned = byOwner.get(user.entraObjectId) ?? [];
    if (isGuest(user)) {
      guests += 1;
      owned.forEach(markOrphan);
      continue;
    }
    const subject = subjectOf(user);
    const probe = input.probes.get(user.entraObjectId);
    const keep = new Set<string>();
    const add = (kind: DirectoryObjectKind, externalId: string) => {
      keep.add(externalId);
      place(
        {
          kind,
          externalId,
          ownerId: user.entraObjectId,
          displayName: user.displayName,
          ...decide(subject, externalId),
        },
        false,
      );
    };

    if (hasMailbox(user, probe)) {
      add("mailbox", user.entraObjectId);
    }
    if (typeof probe?.driveId === "string") {
      add("onedrive", probe.driveId);
    } else if (probe?.driveId === undefined) {
      // Not probed or the probe failed: keep the drive we know, never guess a new one.
      const current = owned.find((o) => o.kind === "onedrive" && o.status !== "orphaned");
      if (current) {
        add("onedrive", current.externalId);
      }
    }
    for (const object of owned) {
      if (!keep.has(object.externalId)) {
        markOrphan(object);
      }
    }
  }

  for (const [ownerId, owned] of byOwner) {
    if (seen.has(ownerId)) {
      continue;
    }
    if (full || removed.has(ownerId)) {
      // Gone from the directory (or reported removed): the objects are orphaned.
      owned.forEach(markOrphan);
      continue;
    }
    // Unchanged user in an incremental run: re-apply the rules from stored facts.
    for (const object of owned) {
      if (object.status === "orphaned" || !object.owner) {
        continue;
      }
      const subject = storedSubject(object.owner, input.sharedOrBlockedIds);
      place(
        {
          kind: object.kind,
          externalId: object.externalId,
          ownerId,
          displayName: object.displayName,
          ...decide(subject, object.externalId),
        },
        true,
      );
    }
  }
  if (full) {
    // A full enumeration cannot re-attach an object whose user link is gone.
    unlinked.forEach(markOrphan);
  }
  for (const externalId of placed) {
    orphan.delete(externalId);
  }

  const sharedOrBlocked = new Set(full ? [] : input.sharedOrBlockedIds);
  for (const userId of removed) {
    sharedOrBlocked.delete(userId);
  }
  for (const user of input.users) {
    if (subjectOf(user).sharedOrBlocked) {
      sharedOrBlocked.add(user.entraObjectId);
    } else {
      sharedOrBlocked.delete(user.entraObjectId);
    }
  }

  const countChange = (change: ObjectChange) =>
    objects.filter((object) => object.change === change).length;
  return {
    users: input.users,
    removedUserIds: [...removed],
    objects,
    orphanExternalIds: [...orphan],
    sharedOrBlockedIds: [...sharedOrBlocked].sort(),
    counts: {
      users: input.users.length,
      removedUsers: removed.size,
      guests,
      created: countChange("created"),
      updated: countChange("updated"),
      rescoped: countChange("rescoped"),
      orphaned: orphan.size,
    },
  };
}
