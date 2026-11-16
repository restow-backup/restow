import type { StorageLocation } from "@restow/core";
import { type Database, settings } from "@restow/db";
import { onSystemDisk, type SystemDiskDeps } from "../storage/system-disk.js";
import { primaryLocation } from "./capacity.js";
import type { SystemDiskWarningDto } from "./dto.js";
import type { StorageCapacityFacts } from "./queries.js";

/**
 * The dashboard's warning about a repository on the server's system disk (storage/system-disk.ts,
 * incident of 16 October 2026): the tenant's primary repository, its own or the installation
 * default, is a directory on the disk under the operating system, Docker and PostgreSQL. Every
 * viewer of the tenant learns that; how full the disk is and where it is heading (the free space
 * the api keeps once an hour, updates/disk-watch.ts) only provider admins, since the disk is the
 * provider's server, not the tenant's.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Less history than this gives no trend: a few samples say nothing about days. */
const MIN_TREND_SPAN_MS = 6 * 60 * 60 * 1000;
/** The trend is fitted to this much of the history. */
const TREND_WINDOW_MS = 7 * DAY_MS;

/**
 * The change of the free space per day, a straight line through the samples of the last week,
 * and the day it reaches zero at that rate (null while it does not shrink). Null without six
 * hours of history.
 */
export function freeSpaceTrend(
  samples: readonly { at: string; freeBytes: number }[],
  now: Date,
): SystemDiskWarningDto["trend"] {
  const recent = samples
    .map((sample) => ({ t: Date.parse(sample.at), free: sample.freeBytes }))
    .filter((sample) => Number.isFinite(sample.t) && now.getTime() - sample.t <= TREND_WINDOW_MS)
    .sort((a, b) => a.t - b.t);
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last || recent.length < 2 || last.t - first.t < MIN_TREND_SPAN_MS) {
    return null;
  }
  const meanT = recent.reduce((sum, sample) => sum + sample.t, 0) / recent.length;
  const meanFree = recent.reduce((sum, sample) => sum + sample.free, 0) / recent.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of recent) {
    numerator += (sample.t - meanT) * (sample.free - meanFree);
    denominator += (sample.t - meanT) ** 2;
  }
  const perMs = denominator === 0 ? 0 : numerator / denominator;
  const bytesPerDay = Math.round(perMs * DAY_MS);
  const fullOn =
    bytesPerDay < 0 ? new Date(last.t + (last.free / -bytesPerDay) * DAY_MS).toISOString() : null;
  return { bytesPerDay, fullOn, basisHours: Math.round((last.t - first.t) / (60 * 60 * 1000)) };
}

export async function loadSystemDiskWarning(input: {
  facts: Pick<StorageCapacityFacts, "ownTarget">;
  installationDefault: StorageLocation | null;
  /** The installation pool: the samples are an installation setting. */
  providerDb: Database;
  isProviderAdmin: boolean;
  now: Date;
  systemDisk?: SystemDiskDeps;
}): Promise<SystemDiskWarningDto | null> {
  const location = primaryLocation(input.facts, input.installationDefault);
  if (location?.kind !== "local" || !(await onSystemDisk(location.basePath, input.systemDisk))) {
    return null;
  }
  if (!input.isProviderAdmin) {
    return { freeBytes: null, totalBytes: null, trend: null, samples: [] };
  }
  const [row] = await input.providerDb
    .select({ alerts: settings.diskAlerts })
    .from(settings)
    .limit(1);
  const system = row?.alerts?.system;
  const samples = system?.samples ?? [];
  return {
    freeBytes: system?.freeBytes ?? null,
    totalBytes: system?.totalBytes ?? null,
    trend: freeSpaceTrend(samples, input.now),
    samples: samples.filter(
      (sample) => input.now.getTime() - Date.parse(sample.at) <= TREND_WINDOW_MS,
    ),
  };
}
