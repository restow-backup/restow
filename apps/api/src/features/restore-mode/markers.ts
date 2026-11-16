import {
  deletionEnforcementInstalled,
  type StorageBackend,
  withProgressMarkers,
} from "@restow/core";
import { allocateStorageProgress, readInstallationIdentity } from "@restow/db";
import { providerDb } from "../../db.js";
import { apiRestoreModeGuard } from "./instance.js";

/**
 * Progress markers for what the api writes itself (docs/STORAGE.md, "Restore mode and progress
 * markers"): the restic repositories of machines, file shares and containers through the restic
 * routes, and the blocks of Proxmox VE VMs. Like the worker's, a marker is written before the
 * first write of a tenant's data to a target and again at most once a minute. Only in the
 * running api (server.ts installs the deletion guard); route tests without a guard write none.
 */

let installation: Promise<string | null> | null = null;

function installationId(): Promise<string | null> {
  installation ??= readInstallationIdentity(providerDb.$client).catch((error) => {
    installation = null;
    throw error;
  });
  return installation;
}

/** `backend` with the api's progress markers for `tenantId` on the target `targetId`. */
export function withApiProgressMarkers(
  backend: StorageBackend,
  tenantId: string,
  targetId: string,
): StorageBackend {
  const marked = withProgressMarkers(backend, {
    tenantId,
    targetId,
    allocate: (id) => allocateStorageProgress(providerDb.$client, id),
    installationId,
    writer: "api",
    version: process.env.RESTOW_VERSION ?? null,
    // A marker value of this installation taken already: the storage is ahead.
    onCollision: async (id, seq, collision) => {
      await apiRestoreModeGuard().markerCollision(
        id,
        { id: targetId, backend },
        seq,
        collision.ours,
      );
    },
    // The api serves at once (server.ts): its first allocation for a tenant waits for one full
    // comparison of the tenant's targets, so it never raises the value before storage was seen.
    beforeFirstAllocation: (id) => apiRestoreModeGuard().compareBeforeFirstAllocation(id),
  });
  return {
    ...marked,
    put: (key, data, options) =>
      deletionEnforcementInstalled()
        ? marked.put(key, data, options)
        : backend.put(key, data, options),
  };
}

/**
 * Every backend in `backends` wrapped once (the same object keeps its identity across the
 * lists a caller builds from it); `idOf` names its target.
 */
export function markerWrapper(
  tenantId: string,
  idOf: (backend: StorageBackend, fallback: string) => string,
): (backend: StorageBackend, fallback: string) => StorageBackend {
  const wrapped = new Map<StorageBackend, StorageBackend>();
  return (backend, fallback) => {
    let result = wrapped.get(backend);
    if (!result) {
      result = withApiProgressMarkers(backend, tenantId, idOf(backend, fallback));
      wrapped.set(backend, result);
    }
    return result;
  };
}
