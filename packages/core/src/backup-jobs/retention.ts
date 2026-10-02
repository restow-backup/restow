// Which snapshot retention policy governs the objects of a mail job. A job may name one of the
// tenant's snapshot policies; its objects then follow that policy, unless a policy is scoped to
// the object itself (an override made for exactly that object always wins, as before). Pure code,
// shared by the worker's retention run and the retention preview of the API, so both decide alike.

import type { SnapshotRetentionPolicy } from "../retention/index.js";
import { type ScopeMember, mailJobObjectIds } from "./scope.js";

/** The objects of one job and the policy the job names. */
export interface JobRetentionAssignment {
  readonly retentionPolicyId: string;
  readonly protectedObjectIds: readonly string[];
}

/**
 * The policies a retention run resolves against: the tenant's own plus, for every assignment, a
 * copy of the named policy limited to the job's objects that no scoped policy already claims.
 * The copies come after the originals, so an object-scoped policy is found first, and the sets of
 * two jobs never overlap (an object belongs to one job). A policy that is gone or does not govern
 * snapshots is ignored: those objects fall back to the tenant default.
 */
export function withJobRetention(
  policies: readonly SnapshotRetentionPolicy[],
  assignments: readonly JobRetentionAssignment[],
): SnapshotRetentionPolicy[] {
  const claimed = new Set<string>();
  for (const policy of policies) {
    for (const id of policy.protectedObjectIds ?? []) {
      claimed.add(id);
    }
  }
  const derived: SnapshotRetentionPolicy[] = [];
  for (const assignment of assignments) {
    const policy = policies.find(
      (candidate) => candidate.policyId === assignment.retentionPolicyId,
    );
    if (!policy) {
      continue;
    }
    const ids = assignment.protectedObjectIds.filter((id) => !claimed.has(id));
    if (ids.length === 0) {
      continue;
    }
    derived.push({ ...policy, protectedObjectIds: ids, isDefault: false });
  }
  return [...policies, ...derived];
}

/**
 * The assignments of a tenant's mail jobs: for every job that names a retention policy, the
 * objects it covers. Every object counts here whatever its status (an excluded mailbox still has
 * restore points to prune) except imported ones, which no job covers: their restore points follow
 * the tenant's policies like before.
 */
export function jobRetentionAssignments(
  jobs: readonly {
    readonly id: string;
    readonly scopeMode: "all" | "selected";
    readonly retentionPolicyId: string | null;
  }[],
  members: readonly ScopeMember[],
  objects: readonly { readonly id: string; readonly imported: boolean }[],
): JobRetentionAssignment[] {
  const scoped = objects.map((object) => ({ id: object.id, eligible: !object.imported }));
  return jobs.flatMap((job) =>
    job.retentionPolicyId === null
      ? []
      : [
          {
            retentionPolicyId: job.retentionPolicyId,
            protectedObjectIds: mailJobObjectIds(job, members, scoped),
          },
        ],
  );
}
