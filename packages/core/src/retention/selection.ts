import type { RetentionTier } from "./tiers.js";

/**
 * A protected object's restore point, as the retention rule needs to see it.
 * `verified` is whether at least one recovery-readiness check rated this
 * exact restore point green (docs/TESTING.md: a backup without a verified
 * restore counts as failed, so it is never the one guard against, but it is
 * always the one the policy must not remove if it is the only one).
 */
export interface SnapshotCandidate {
  readonly id: string;
  readonly protectedObjectId: string;
  /** Monotonic sequence number within the object; higher is newer. */
  readonly sequence: number;
  readonly byteSize: number;
  readonly completedAt: Date | null;
  readonly verified: boolean;
}

/** A resolved snapshot retention policy, ready to evaluate against candidates. */
export interface SnapshotRetentionPolicy {
  readonly policyId: string;
  readonly tiers: readonly RetentionTier[];
  /** Objects the policy is limited to; null applies to every object of the tenant. */
  readonly protectedObjectIds: readonly string[] | null;
  readonly isDefault: boolean;
  /**
   * The newest N restore points of an object are always kept, whatever the
   * tiers say; undefined (or 1) matches the tiered rule's own guard (the
   * newest one only). Only a row saved before presets existed carries its own
   * value here (@restow/core `parseSnapshotPolicy`, the pre-preset
   * `keepLast` column) — a preset-based policy never sets this.
   */
  readonly keepLast?: number;
}

/**
 * The policy governing one object: an object-scoped policy wins, then the
 * tenant default, then the first tenant-wide policy. Null means keep all.
 */
export function resolvePolicyFor(
  policies: readonly SnapshotRetentionPolicy[],
  protectedObjectId: string,
): SnapshotRetentionPolicy | null {
  const scoped = policies.find((policy) => policy.protectedObjectIds?.includes(protectedObjectId));
  if (scoped) {
    return scoped;
  }
  const tenantWide = policies.filter((policy) => policy.protectedObjectIds === null);
  return tenantWide.find((policy) => policy.isDefault) ?? tenantWide[0] ?? null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function ageDays(completedAt: Date, now: Date): number {
  return Math.floor((now.getTime() - completedAt.getTime()) / MS_PER_DAY);
}

/**
 * A restore point's position on a fixed calendar timeline, in whole days
 * since the epoch. Bucketing a thinning tier by this (rather than by age
 * relative to `now`) is what keeps a survivor's bucket the same on every
 * run: age moves forward by exactly one day between two runs a day apart,
 * so an age-relative bucket would too, letting each new candidate that
 * enters the tier land in the same bucket as yesterday's survivor and push
 * it out — collapsing a "one per week" tier to a single lifetime survivor
 * over time. The calendar day of `completedAt` never changes, so once a
 * bucket's survivor is chosen the losers are gone for good and no later
 * candidate can ever re-enter that same bucket.
 */
function epochDay(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

function tierFor(age: number, tiers: readonly RetentionTier[]): RetentionTier | null {
  return (
    tiers.find((tier) => age >= tier.fromDays && (tier.toDays === null || age < tier.toDays)) ??
    null
  );
}

/**
 * Which of one object's restore points the policy no longer requires.
 *
 * Two guards apply before the tiers are ever consulted: the newest `keepLast`
 * restore points of the object are never selected (just the newest one,
 * unless the policy is a legacy row carrying its own `keepLast`), and neither
 * is its newest verified one, whether it is the only verified point or one of
 * several (docs/TESTING.md — a backup without a verified restore counts as
 * failed, so retention must never be the reason none is left). Everything else is judged by age: which
 * tier applies is decided by age relative to `now`, but within a thinning
 * tier (`keepEveryDays > 0`) the bucket itself is anchored to the restore
 * point's own calendar day ({@link epochDay}), not to `now`, so the newest
 * restore point of each `keepEveryDays`-wide calendar window survives and
 * the rest expire, the same way on every run; a tier with
 * `keepEveryDays === 0` keeps every one; age past every tier (or a restore
 * point still without a completion time) is left alone here — the caller
 * only ever passes completed restore points in.
 */
export function selectExpiredSnapshots(
  candidates: readonly SnapshotCandidate[],
  policy: SnapshotRetentionPolicy,
  now: Date,
): SnapshotCandidate[] {
  if (candidates.length === 0) {
    return [];
  }
  const keepLast = Math.max(1, policy.keepLast ?? 1);
  const newestFirst = [...candidates].sort((a, b) => b.sequence - a.sequence);
  const kept = new Set<string>(newestFirst.slice(0, keepLast).map((c) => c.id));
  const verified = candidates.filter((c) => c.verified);
  const newestVerified =
    verified.length > 0 ? verified.reduce((a, b) => (b.sequence > a.sequence ? b : a)) : null;
  if (newestVerified) {
    kept.add(newestVerified.id);
  }

  const expired: SnapshotCandidate[] = [];
  const buckets = new Map<string, SnapshotCandidate[]>();
  for (const candidate of candidates) {
    if (kept.has(candidate.id) || candidate.completedAt === null) {
      continue;
    }
    const age = ageDays(candidate.completedAt, now);
    const tier = tierFor(age, policy.tiers);
    if (!tier) {
      // Older than every tier the policy defines: not covered, so pruned.
      expired.push(candidate);
      continue;
    }
    if (tier.keepEveryDays <= 0) {
      continue; // this tier keeps every restore point
    }
    const bucketIndex = Math.floor(epochDay(candidate.completedAt) / tier.keepEveryDays);
    const key = `${tier.fromDays}:${bucketIndex}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(candidate);
    } else {
      buckets.set(key, [candidate]);
    }
  }
  for (const bucket of buckets.values()) {
    const survivor = bucket.reduce((a, b) => (b.sequence > a.sequence ? b : a));
    for (const candidate of bucket) {
      if (candidate.id !== survivor.id) {
        expired.push(candidate);
      }
    }
  }
  return expired;
}

/** Group candidates by protected object, preserving encounter order. */
export function groupByObject(
  candidates: readonly SnapshotCandidate[],
): Map<string, SnapshotCandidate[]> {
  const groups = new Map<string, SnapshotCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.protectedObjectId);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(candidate.protectedObjectId, [candidate]);
    }
  }
  return groups;
}
