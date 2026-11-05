import type { DeletionPass } from "./deletion-guard.js";

/**
 * Every place in the server's code that deletes storage data, by `file#function#call`, and the
 * deletion pass it runs under (deletion-guard.ts). deletion-sites.test.ts finds the places with
 * the TypeScript compiler and fails for one that is missing here, and for an entry here whose
 * place is gone. Besides a pass an entry may say why it needs none:
 *
 *   delegate    a storage backend (or a wrapper of one) handing the delete on: the backend
 *               checks it
 *   helper      a function that deletes on behalf of its caller; the caller's site names the pass
 *   always      restic lock files and probe objects (isAlwaysDeletable)
 *   own_writes  an object the same operation wrote itself (withStorageOperation)
 */
export const DELETION_SITES: Readonly<
  Record<string, DeletionPass | "delegate" | "helper" | "always" | "own_writes">
> = {
  // --- apps/api ----------------------------------------------------------------------------
  "apps/api/src/features/endpoints/agent-service.ts#enrollEndpoint#removeRepositoryObjects":
    "enrollment_cleanup",
  "apps/api/src/features/endpoints/repository.ts#removeRepositoryObjects#.delete": "helper",
  "apps/api/src/features/imports/service.ts#deleteStagedSegments#.delete": "import_staging",
  "apps/api/src/features/pve/repository.ts#createRepository#.delete": "pve_chain_clear",
  "apps/api/src/features/pve/repository.ts#createRepository#moveRepositoryAside": "pve_chain_clear",
  "apps/api/src/features/pve/repository.ts#moveRepositoryAside#.delete": "helper",
  // --- apps/worker -------------------------------------------------------------------------
  "apps/worker/src/endpoints/removal.ts#deleteUnder#.delete": "helper",
  "apps/worker/src/endpoints/removal.ts#endpointRemoval#deleteUnder": "endpoint_removal",
  "apps/worker/src/endpoints/retention.ts#retain#resticForget": "endpoint_retention",
  "apps/worker/src/endpoints/retention.ts#retain#resticPrune": "endpoint_retention",
  "apps/worker/src/file-shares/maintenance.ts#retain#resticForget": "file_share_retention",
  "apps/worker/src/file-shares/maintenance.ts#retain#resticPrune": "file_share_retention",
  "apps/worker/src/file-shares/purge.ts#purgeShare#.delete": "file_share_purge",
  "apps/worker/src/handlers/export.ts#execute#.delete": "export_reset",
  "apps/worker/src/handlers/export.ts#run#.delete": "export_reset",
  "apps/worker/src/handlers/framework.ts#discardAbandonedSnapshots#discardUncommittedSnapshot":
    "abandoned_checkpoint",
  "apps/worker/src/handlers/import.ts#deleteStaging#.delete": "import_staging",
  "apps/worker/src/handlers/mail-files-cleanup.ts#removeScope#.delete": "mail_files_cleanup",
  "apps/worker/src/handlers/repository-repair.ts#applyRepairWithPermit#moveAside":
    "repository_repair_apply",
  "apps/worker/src/handlers/repository-repair.ts#fail#moveAside": "repository_repair_apply",
  "apps/worker/src/handlers/repository-repair.ts#moveAside#.delete": "helper",
  "apps/worker/src/handlers/retention.ts#pruneSnapshot#.delete": "snapshot_retention",
  "apps/worker/src/pve/maintenance.ts#pruneSnapshot#deleteOnAllTargets": "pve_retention",
  "apps/worker/src/pve/maintenance.ts#reconcileGuestRepository#resticForget":
    "pve_reconcile_forget",
  "apps/worker/src/pve/maintenance.ts#reconcileGuestRepository#resticPrune": "pve_reconcile_forget",
  // --- ee/worker ---------------------------------------------------------------------------
  "ee/worker/src/archive-retention/archive-retention.ts#deleteItem#delete(archiveItems)":
    "archive_retention",
  // --- packages/core -----------------------------------------------------------------------
  "packages/core/src/backup/onedrive/testing.ts#delete#.delete": "delegate",
  "packages/core/src/endpoints/repository-storage.ts#removeLockFiles#.delete": "always",
  // restic's own deletes through the loopback carry the permit of the pass that started restic.
  "packages/core/src/endpoints/restic-rest.ts#handleResticRequest#.delete": "delegate",
  "packages/core/src/engine/discard.ts#deleteOnAllTargets#.delete": "helper",
  "packages/core/src/engine/discard.ts#deletePartialManifest#deleteOnAllTargets":
    "job_checkpoint_discard",
  "packages/core/src/engine/discard.ts#discardUncommittedSnapshot#deleteOnAllTargets":
    "job_checkpoint_discard",
  "packages/core/src/engine/snapshot.ts#SnapshotWriter.abort#discardUncommittedSnapshot":
    "job_checkpoint_discard",
  "packages/core/src/engine/snapshot.ts#SnapshotWriter.deletePartial#deletePartialManifest":
    "job_checkpoint_discard",
  "packages/core/src/engine/snapshot.ts#SnapshotWriter.discardStale#discardUncommittedSnapshot":
    "job_checkpoint_discard",
  "packages/core/src/mailfiles/segments.ts#SegmentStore.delete#.delete": "helper",
  "packages/core/src/restore/download.ts#DownloadRestoreEngine.run#.delete": "own_writes",
  "packages/core/src/storage/copy.ts#delete#.delete": "delegate",
  "packages/core/src/storage/factory.ts#cleanUp#.delete": "always",
  "packages/core/src/storage/factory.ts#probeStorageBackend#.delete": "always",
  "packages/core/src/storage/immutability.ts#ImmutableStorageBackend.delete#.delete": "delegate",
  "packages/core/src/storage/immutability.ts#ImmutableStorageBackend.delete#.deleteAllVersions":
    "delegate",
  "packages/core/src/storage/progress-marker.ts#delete#.delete": "delegate",
  "packages/core/src/storage/progress-marker.ts#pruneProgressMarkers#.delete":
    "progress_marker_prune",
  "packages/core/src/verify/gc.ts#chunksHeldByPartialManifests#deleteOnAllTargets":
    "abandoned_checkpoint",
  "packages/core/src/verify/gc.ts#deleteEverywhere#.delete": "helper",
  "packages/core/src/verify/gc.ts#releaseAll#deleteEverywhere": "superseded_release",
  "packages/core/src/verify/gc.ts#repackOne#deleteEverywhere": "gc_repack",
  "packages/core/src/verify/gc.ts#sweepWithPermit#.delete": "orphan_sweep",
};
