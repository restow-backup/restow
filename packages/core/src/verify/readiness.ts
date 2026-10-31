/**
 * Recovery readiness: the green / yellow / red verdict a verify run hands the
 * operator, with every reason that led to it.
 *
 *   red     a restore of this object would fail or be incomplete today: no
 *           backup, unreadable manifest, sampled items that do not come back
 *           byte-exact, storage the scrub found corrupt (or could not read in
 *           several checks over more than a day), a failed test restore,
 *           or a latest backup so old that recent data is not recoverable
 *   yellow  restorable, but something needs attention: the latest backup is
 *           getting old, the storage check could not read a pack of it yet, the
 *           snapshot is empty (only default folders or system pages, 0 bytes) or
 *           holds data of no type a check can read back, or a test restore
 *           landed without the target confirming it
 *   green   every sampled item came back byte-exact from a current backup
 *
 * The verdict is the worst severity among the reasons. Reasons are machine
 * codes with parameters; the UI translates them.
 */
import type { RecoveryReadiness } from "../engine/types.js";
import type { ItemCheckStatus } from "./check.js";

export type ReadinessReasonCode =
  | "no_snapshot"
  | "manifest_unreadable"
  | "items_missing"
  | "items_unreadable"
  | "items_mismatched"
  | "storage_corrupt"
  | "storage_unreadable"
  | "storage_unreadable_persistent"
  | "test_restore_failed"
  | "snapshot_outdated"
  | "snapshot_stale"
  | "snapshot_empty"
  | "nothing_to_verify"
  | "test_restore_unconfirmed";

export type ReadinessSeverity = "yellow" | "red";

export type ReadinessReason = {
  code: ReadinessReasonCode;
  severity: ReadinessSeverity;
  /** How many items, packs or targets the reason concerns, where that applies. */
  count?: number;
  /** Age of the latest snapshot in hours, for the freshness reasons. */
  ageHours?: number;
  /** Bytes of content the snapshot holds, for `nothing_to_verify`. */
  bytes?: number;
};

export type ReadinessPolicy = {
  /** Latest backup older than this turns the rating yellow. */
  staleAfterHours: number;
  /** Latest backup older than this turns it red: recent data would be lost. */
  outdatedAfterHours: number;
};

export const DEFAULT_READINESS_POLICY: ReadinessPolicy = {
  staleAfterHours: 48,
  outdatedAfterHours: 7 * 24,
};

export type ReadinessFacts = {
  /** Completion time of the latest snapshot; null when no snapshot exists. */
  snapshotCompletedAt: Date | null;
  hasSnapshot: boolean;
  manifestReadable: boolean;
  /** Objects that were read back. */
  checked: number;
  /**
   * What the snapshot holds besides folders and placeholders (packages, shortcuts): the bytes
   * and the number of such objects. Zero bytes with nothing read back is an empty object (an
   * empty mailbox or OneDrive, a site with system pages only), not a gap of the check.
   */
  contentBytes: number;
  contentObjects: number;
  /** Every object the snapshot lists (folders included), for the text of an empty one. */
  itemCount?: number;
  outcomes: Readonly<Record<ItemCheckStatus, number>>;
  /** Packs of the snapshot that the latest scrub reported corrupt and could not repair. */
  damagedPacks: number;
  /**
   * Packs of the snapshot the storage check could not read lately, not yet
   * for long (attention), and for long enough to count like damage.
   */
  unreadablePacks?: number;
  persistentlyUnreadablePacks?: number;
  /** Test-restore outcome, when one ran. */
  testRestore: { failed: number; unconfirmed: number } | null;
  now: Date;
};

export type ReadinessAssessment = {
  readiness: RecoveryReadiness;
  reasons: ReadinessReason[];
};

const RANK: Record<RecoveryReadiness, number> = { green: 0, yellow: 1, red: 2 };

/** The worse of several ratings (green when the list is empty). */
export function worstReadiness(ratings: Iterable<RecoveryReadiness>): RecoveryReadiness {
  let worst: RecoveryReadiness = "green";
  for (const rating of ratings) {
    if (RANK[rating] > RANK[worst]) {
      worst = rating;
    }
  }
  return worst;
}

function ageInHours(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 3_600_000));
}

function freshnessReason(
  completedAt: Date | null,
  now: Date,
  policy: ReadinessPolicy,
): ReadinessReason | null {
  if (!completedAt) {
    return null;
  }
  const ageHours = ageInHours(completedAt, now);
  if (ageHours >= policy.outdatedAfterHours) {
    return { code: "snapshot_outdated", severity: "red", ageHours };
  }
  if (ageHours >= policy.staleAfterHours) {
    return { code: "snapshot_stale", severity: "yellow", ageHours };
  }
  return null;
}

/** Turn what a verify run observed into a rating with reasons (red reasons first). */
export function assessReadiness(
  facts: ReadinessFacts,
  policy: ReadinessPolicy = DEFAULT_READINESS_POLICY,
): ReadinessAssessment {
  if (!facts.hasSnapshot) {
    return { readiness: "red", reasons: [{ code: "no_snapshot", severity: "red" }] };
  }
  const reasons: ReadinessReason[] = [];
  const add = (code: ReadinessReasonCode, severity: ReadinessSeverity, count: number) => {
    if (count > 0) {
      reasons.push({ code, severity, count });
    }
  };

  if (!facts.manifestReadable) {
    reasons.push({ code: "manifest_unreadable", severity: "red" });
  }
  add("items_missing", "red", facts.outcomes.missing);
  add("items_unreadable", "red", facts.outcomes.unreadable);
  add("items_mismatched", "red", facts.outcomes.mismatch);
  add("storage_corrupt", "red", facts.damagedPacks);
  add("storage_unreadable_persistent", "red", facts.persistentlyUnreadablePacks ?? 0);
  add("test_restore_failed", "red", facts.testRestore?.failed ?? 0);

  const freshness = freshnessReason(facts.snapshotCompletedAt, facts.now, policy);
  if (freshness) {
    reasons.push(freshness);
  }
  if (facts.manifestReadable && facts.checked === 0) {
    reasons.push(
      facts.contentBytes === 0
        ? {
            code: "snapshot_empty",
            severity: "yellow",
            count: facts.itemCount ?? facts.contentObjects,
          }
        : { code: "nothing_to_verify", severity: "yellow", bytes: facts.contentBytes },
    );
  }
  add("test_restore_unconfirmed", "yellow", facts.testRestore?.unconfirmed ?? 0);
  add("storage_unreadable", "yellow", facts.unreadablePacks ?? 0);

  reasons.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return { readiness: worstReadiness(reasons.map((reason) => reason.severity)), reasons };
}

/** The reasons that only say how old the latest backup is. */
const FRESHNESS_REASONS: ReadonlySet<string> = new Set(["snapshot_outdated", "snapshot_stale"]);

/**
 * The rating of an object that can no longer be backed up (removed from its source, a
 * mailbox Microsoft 365 deleted): its last backup is all there will be, so only whether it
 * restores counts, not its age. The worst severity of the other reasons; green without any.
 */
export function readinessWithoutFreshness(
  reasons: readonly { readonly code: string; readonly severity: string }[],
): RecoveryReadiness {
  let worst: RecoveryReadiness = "green";
  for (const reason of reasons) {
    if (FRESHNESS_REASONS.has(reason.code)) {
      continue;
    }
    if (reason.severity === "red") {
      return "red";
    }
    if (reason.severity === "yellow") {
      worst = "yellow";
    }
  }
  return worst;
}

/** The reason of a check that found the object empty (only default folders, 0 bytes). */
export const EMPTY_REASON = "snapshot_empty";

/**
 * Whether a report says no more than "this object is empty": its rating rests on the empty
 * reason alone. Only such a report can be confirmed as empty by an admin, and a confirmation
 * counts only while the newest report still says so (any other finding, or content, ends it).
 */
export function isEmptyFinding(reasons: readonly { readonly code: string }[]): boolean {
  return reasons.length > 0 && reasons.every((reason) => reason.code === EMPTY_REASON);
}
