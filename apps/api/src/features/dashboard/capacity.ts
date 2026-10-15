import { statfs } from "node:fs/promises";
import { type StorageLocation, validateStorageLocation } from "@restow/core";
import type { StorageCapacityFacts } from "./queries.js";

/**
 * The capacity of a tenant's repository, where Restow can know it. Only a
 * local filesystem has one: the API reads its free space (statfs) of the
 * directory the repository lives in. An S3 bucket reports no limit, and a
 * quota of the service is not visible through the S3 API, so there is none.
 *
 * The installation default is shared by every tenant without a target of its
 * own: its free space is reported only to a tenant that has it to itself, so
 * no customer reads the provider's disk, and no date is computed from one
 * tenant's growth while others fill the same disk.
 */

export interface FilesystemSpace {
  freeBytes: number;
  totalBytes: number;
}

/** Reads the free space of the filesystem a path is on; null when that is not possible. */
export type FilesystemSpaceReader = (path: string) => Promise<FilesystemSpace | null>;

/** How long the page waits for a filesystem (a hung network mount) before it goes on without. */
const STATFS_TIMEOUT_MS = 2000;

/** statfs of `path`, bounded by {@link STATFS_TIMEOUT_MS}; null when it fails or takes too long. */
export async function statfsSpace(path: string): Promise<FilesystemSpace | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), STATFS_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([
      statfs(path).then((stats) => ({
        // Blocks an unprivileged writer may still use, not the ones reserved for root.
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
      })),
      timeout,
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The local directory whose free space counts for the tenant, or null when
 * none does: an S3 repository, an unusable configuration, or the installation
 * default while other tenants write to it as well.
 */
export function capacityPath(
  facts: Pick<StorageCapacityFacts, "ownTarget">,
  installationDefault: StorageLocation | null,
  soleTenantOnDefault: boolean,
): string | null {
  let location: StorageLocation | null = null;
  if (facts.ownTarget) {
    const validated = validateStorageLocation(facts.ownTarget.kind, facts.ownTarget.config);
    location = validated.ok ? validated.location : null;
  } else if (soleTenantOnDefault) {
    location = installationDefault;
  }
  return location?.kind === "local" ? location.basePath : null;
}
