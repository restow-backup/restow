import { type LegalHoldScope, isHeld } from "./holds.js";
import {
  type SnapshotCandidate,
  type SnapshotRetentionPolicy,
  groupByObject,
  resolvePolicyFor,
  selectExpiredSnapshots,
} from "./selection.js";

/**
 * The outcome of evaluating a set of policies against a tenant's restore
 * point history, without touching storage. `apps/worker/src/handlers/retention.ts`
 * runs this to decide what to prune (for real, or as a dry run); the retention
 * API's preview endpoint runs the exact same function against a draft policy,
 * so what an administrator is shown before saving is what the worker would do.
 */
export interface RetentionPlan {
  /** Objects whose restore points were evaluated (had at least one candidate). */
  readonly objectsEvaluated: number;
  /** Restore points a policy applied to (whether or not they are held). */
  readonly candidatesConsidered: number;
  /** Restore points due for pruning; empty when nothing is left to do. */
  readonly expired: readonly SnapshotCandidate[];
  /** Restore points that would expire but are suspended by a legal hold. */
  readonly held: readonly SnapshotCandidate[];
}

/**
 * Plan a retention run: group restore points by object, resolve each
 * object's policy, select what it no longer requires, and set aside anything
 * a legal hold currently suspends. An object with no resolved policy keeps
 * everything.
 */
export function planRetentionRun(
  history: readonly SnapshotCandidate[],
  policies: readonly SnapshotRetentionPolicy[],
  holds: LegalHoldScope,
  now: Date,
): RetentionPlan {
  const groups = groupByObject(history);
  const expired: SnapshotCandidate[] = [];
  const held: SnapshotCandidate[] = [];
  let candidatesConsidered = 0;

  for (const [protectedObjectId, group] of groups) {
    const policy = resolvePolicyFor(policies, protectedObjectId);
    if (!policy) {
      continue;
    }
    candidatesConsidered += group.length;
    const due = selectExpiredSnapshots(group, policy, now);
    if (due.length === 0) {
      continue;
    }
    if (isHeld(holds, protectedObjectId)) {
      held.push(...due);
    } else {
      expired.push(...due);
    }
  }

  return { objectsEvaluated: groups.size, candidatesConsidered, expired, held };
}

/** Total logical bytes of a set of restore points, for a preview's rough size estimate. */
export function totalBytes(candidates: readonly SnapshotCandidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidate.byteSize, 0);
}
