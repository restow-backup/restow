/**
 * Recovery readiness: the green / yellow / red verdict a verify run hands the
 * operator, with every reason that led to it.
 *
 *   red     a restore of this object would fail or be incomplete today: no
 *           backup, unreadable manifest, sampled items that do not come back
 *           byte-exact, storage the scrub found corrupt, a failed test restore,
 *           or a latest backup so old that recent data is not recoverable
 *   yellow  restorable, but something needs attention: the latest backup is
 *           getting old, the snapshot holds nothing that could be verified, or
 *           a test restore landed without the target confirming it
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
  | "test_restore_failed"
  | "snapshot_outdated"
  | "snapshot_stale"
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
  outcomes: Readonly<Record<ItemCheckStatus, number>>;
  /** Packs of the snapshot that the latest scrub reported corrupt and could not repair. */
  damagedPacks: number;
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
  add("test_restore_failed", "red", facts.testRestore?.failed ?? 0);

  const freshness = freshnessReason(facts.snapshotCompletedAt, facts.now, policy);
  if (freshness) {
    reasons.push(freshness);
  }
  if (facts.manifestReadable && facts.checked === 0) {
    reasons.push({ code: "nothing_to_verify", severity: "yellow" });
  }
  add("test_restore_unconfirmed", "yellow", facts.testRestore?.unconfirmed ?? 0);

  reasons.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return { readiness: worstReadiness(reasons.map((reason) => reason.severity)), reasons };
}
