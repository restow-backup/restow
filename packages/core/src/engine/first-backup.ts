/**
 * Selecting protected objects for their first backup.
 *
 * An object is protected the moment its status turns `active`; from then on
 * it should be backed up promptly rather than sit until the tenant's backup
 * schedule next runs (which can be hours away; the readiness view's grace
 * period, verify/summary.ts's `isFirstBackupOverdue`, shows the honest wait
 * in the meantime). This is the single place that decides, given a batch of
 * newly-protected objects, which of them still need that first backup
 * enqueued: one with a completed snapshot already, or with a backup already
 * queued or running for it, needs nothing more.
 */

/** What the selection needs to know about one newly-protected object. */
export interface FirstBackupCandidate {
  readonly protectedObjectId: string;
  /** A completed backup already exists (any snapshot, not only a recent one). */
  readonly hasSnapshot: boolean;
  /** A backup job for this object is already queued or running. */
  readonly hasQueuedOrActiveBackup: boolean;
}

/** Whether this object's first backup still needs to be enqueued. */
export function needsFirstBackup(candidate: FirstBackupCandidate): boolean {
  return !candidate.hasSnapshot && !candidate.hasQueuedOrActiveBackup;
}

/** The ids of the candidates that still need their first backup enqueued, in order. */
export function selectFirstBackupTargets(
  candidates: readonly FirstBackupCandidate[],
): readonly string[] {
  return candidates.filter(needsFirstBackup).map((candidate) => candidate.protectedObjectId);
}
