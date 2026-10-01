/**
 * Cleaning up snapshots that will never be committed.
 *
 * A backup checkpoints its partial manifest (`<snapshot>.partial`) so a retry
 * can resume. Once nothing can resume it any more (the job ended for good, the
 * checkpoint turned out to be unreadable, the row is gone), the partial is a
 * leftover: garbage collection would otherwise keep every chunk it names
 * forever, and an unreadable one would block collection for the whole tenant
 * (verify/gc.ts). These helpers remove such leftovers from every storage
 * target and drop the in-progress row.
 *
 * Packs are never touched here. Chunks only the abandoned snapshot used have
 * no references, and garbage collection reclaims them after its grace period.
 */
import type { StorageBackend } from "../storage/backend.js";
import { manifestKey, partialManifestKey } from "./layout.js";
import type { Logger, SnapshotIndex, StorageTargets } from "./types.js";

export interface SnapshotCleanupEnv {
  readonly tenantId: string;
  readonly storage: StorageTargets;
  readonly logger: Logger;
}

/** What {@link discardUncommittedSnapshot} found and did. */
export type SnapshotDiscardOutcome =
  /** The row was in progress: its manifests and the row are gone now. */
  | "discarded"
  /** The snapshot is committed: only a leftover partial manifest was removed. */
  | "committed"
  /** No row exists: only a leftover partial manifest was removed. */
  | "missing";

/**
 * Delete one key on every target. A failure is logged and reported as false,
 * never thrown: whatever stays behind is picked up by the next cleanup.
 */
export async function deleteOnAllTargets(
  storage: StorageTargets,
  key: string,
  logger: Logger,
): Promise<boolean> {
  const targets: readonly StorageBackend[] = [storage.primary, ...storage.copies];
  const results = await Promise.all(
    targets.map((target) =>
      target.delete(key).then(
        () => true,
        (error: unknown) => {
          logger.warn("could not delete a manifest file", { key, error });
          return false;
        },
      ),
    ),
  );
  return results.every(Boolean);
}

/** Delete a snapshot's checkpoint (partial manifest) on every target. */
export function deletePartialManifest(
  env: SnapshotCleanupEnv,
  snapshotId: string,
): Promise<boolean> {
  return deleteOnAllTargets(env.storage, partialManifestKey(env.tenantId, snapshotId), env.logger);
}

/**
 * Give up on a snapshot for good. Its partial manifest is always removed. When
 * the row is still in progress, a final manifest that a failed commit may have
 * written is removed too, and then the row. A committed snapshot keeps its
 * manifest and row: only the leftover partial goes.
 */
export async function discardUncommittedSnapshot(
  env: SnapshotCleanupEnv & { readonly snapshots: Pick<SnapshotIndex, "get" | "discard"> },
  snapshotId: string,
): Promise<SnapshotDiscardOutcome> {
  const record = await env.snapshots.get(snapshotId);
  await deletePartialManifest(env, snapshotId);
  if (!record) {
    return "missing";
  }
  if (record.manifestPath !== null) {
    return "committed";
  }
  await deleteOnAllTargets(env.storage, manifestKey(env.tenantId, snapshotId), env.logger);
  await env.snapshots.discard(snapshotId);
  return "discarded";
}
