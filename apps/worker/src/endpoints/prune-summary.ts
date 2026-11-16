/**
 * What a retention report says about its prune (docs/STORAGE.md, "A full target"), the
 * same for machines and file shares: whether restic's normal prune ran or one that only deleted
 * because space was short, whether a prune is still due, and "target full" when not even the
 * delete-only prune could free space.
 */
import { type PruneOutcome, ResticError } from "@restow/core";

/** Whether `error` is restic giving up because the storage target (or the server's disk) is full. */
export function targetFull(error: unknown): boolean {
  return error instanceof ResticError && error.failure === "storage_full";
}

/** The report fields of a prune that ran (none when nothing was pruned). */
export function pruneSummary(prune: PruneOutcome | null): {
  pruneMode?: PruneOutcome["mode"];
  pruneReason?: NonNullable<PruneOutcome["reason"]>;
  prunePending?: boolean;
} {
  if (!prune) {
    return {};
  }
  return {
    pruneMode: prune.mode,
    ...(prune.reason ? { pruneReason: prune.reason } : {}),
    ...(prune.repackDeferred ? { prunePending: true } : {}),
  };
}

/**
 * The report fields of a retention run that failed: a full target is said as such, and the prune
 * stays due, since its snapshots may be forgotten already (the next run has nothing to forget).
 */
export function pruneFailureSummary(error: unknown): { targetFull?: true; prunePending?: true } {
  return targetFull(error) ? { targetFull: true, prunePending: true } : {};
}
