import { type InstallationDefaultStorage, installationDefaultStorage } from "@restow/core";
import type { Database } from "@restow/db";
import {
  type FilesystemSpace,
  type FilesystemSpaceReader,
  primaryLocation,
  statfsSpace,
} from "./capacity.js";
import type { StorageGrowthWidget } from "./dto.js";
import { runsFull, type StorageSeries, storageBuckets, storageForecast } from "./growth.js";
import { loadStorageCapacityFacts, soleTenantOnDefault } from "./queries.js";

/**
 * What the storage growth chart of the start page and the capacity page (features/capacity) have
 * in common, in one place so that both say the same about a tenant: how a series becomes the
 * chart's figures, the estimate and the day the repository runs full (`buildStorageGrowth`), and
 * what limit the tenant's repository has (`resolveStorageLimit`).
 */

export interface StorageLimitDeps {
  /** The application pool (Row Level Security applies). */
  db: Database;
  /** The installation pool, for the question whether the tenant is alone on the default. */
  providerDb: Database;
  /** Environment of the installation default storage (used when `installationDefault` is absent). */
  env: NodeJS.ProcessEnv;
  /**
   * The installation default that applies right now (saved, else the environment); omitted,
   * the environment alone decides.
   */
  installationDefault?: () => Promise<InstallationDefaultStorage | null>;
  /** Free space of the filesystem a local repository is on (statfs); omitted, `statfsSpace`. */
  filesystemSpace?: FilesystemSpaceReader;
}

/** The installation default's primary location, or null when there is no usable default. */
export async function defaultLocation(deps: Pick<StorageLimitDeps, "env" | "installationDefault">) {
  if (deps.installationDefault) {
    return (await deps.installationDefault())?.primary ?? null;
  }
  try {
    return installationDefaultStorage(deps.env).primary;
  } catch {
    return null;
  }
}

/**
 * What limits the tenant's repository:
 *
 *   filesystem      a local directory whose free space is known (`space`)
 *   s3              an S3 bucket: no limit is visible through the S3 API
 *   shared_default  the installation default, which other tenants write to as well: its free
 *                   space is the provider's disk, not this tenant's
 *   unknown         a local directory whose filesystem could not be read, an unusable
 *                   configuration, or no default at all
 */
export type StorageLimitKind = "filesystem" | "s3" | "shared_default" | "unknown";

export interface StorageLimit {
  kind: StorageLimitKind;
  /** The free space, for `filesystem` only. */
  space: FilesystemSpace | null;
  /**
   * Machines, VMs and containers or file shares of the tenant keep restic repositories in the
   * same repository; a history of the pack dates alone does not count their data.
   */
  otherData: boolean;
}

/**
 * The limit of the tenant's repository (capacity.ts for the rules). `soleOnDefault` answers
 * whether the tenant is the only one on the installation default; a caller that asks for many
 * tenants passes one shared answer instead of a query per tenant.
 */
export async function resolveStorageLimit(
  deps: StorageLimitDeps,
  tenantId: string,
  soleOnDefault: () => Promise<boolean> = () => soleTenantOnDefault(deps.providerDb, tenantId),
): Promise<StorageLimit> {
  const facts = await loadStorageCapacityFacts(deps.db, tenantId);
  const { otherData } = facts;
  const location = primaryLocation(facts, await defaultLocation(deps));
  if (!location) {
    return { kind: "unknown", space: null, otherData };
  }
  if (location.kind !== "local") {
    return { kind: "s3", space: null, otherData };
  }
  if (!facts.ownTarget && !(await soleOnDefault())) {
    return { kind: "shared_default", space: null, otherData };
  }
  const space = await (deps.filesystemSpace ?? statfsSpace)(location.basePath);
  return space
    ? { kind: "filesystem", space, otherData }
    : { kind: "unknown", space: null, otherData };
}

/**
 * The widget of the storage growth chart from a series (the pack dates, or the size samples),
 * the days the estimate looks ahead and, where the repository's free space is known, when it runs
 * out. The day is left out (`runsFull: null`) while data the series does not count is written
 * to the repository as well (`space.otherData`).
 */
export function buildStorageGrowth(
  series: StorageSeries,
  forecastDays: number,
  space: (FilesystemSpace & { otherData: boolean }) | null,
): StorageGrowthWidget {
  const { window, baseline, written } = series;
  const buckets = storageBuckets(window, baseline, written);
  const forecast = storageForecast(window, buckets, forecastDays);
  const today = buckets.at(-1)?.date;
  return {
    days: window.days,
    requestedDays: window.requestedDays,
    granularity: window.granularity,
    series: buckets.map(({ date, bytes }) => ({ date, bytes })),
    growthBytes: (buckets.at(-1)?.bytes ?? baseline) - baseline,
    forecast,
    capacity:
      space && today
        ? {
            source: "filesystem" as const,
            freeBytes: space.freeBytes,
            totalBytes: space.totalBytes,
            runsFull: space.otherData ? null : runsFull(today, space.freeBytes, forecast),
          }
        : null,
  };
}
