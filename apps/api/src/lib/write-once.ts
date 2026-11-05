import { describeStorageLocation, type StorageLocation, type WriteOnceFinding } from "@restow/core";
import { type DefaultStorageWriteOnce, settings } from "@restow/db";
import { providerDb } from "../db.js";
import { currentInstallationDefault } from "./installation-default.js";
import type { DbExecutor } from "./tenant-context.js";

/**
 * The write-once finding of the installation default (docs/STORAGE.md, "Write-once storage").
 * A tenant target keeps its finding with its last probe (`storage_targets.config.lastProbe`);
 * the default has no row of its own, so every probe of it (Installation › Default repository,
 * "Test" on a tenant's storage page, saving it) records it in `settings`, together with the
 * location it was found on. It applies only while the default still describes that location.
 */

const CACHE_MS = 30_000;
let cached: { finding: WriteOnceFinding | null; until: number } | null = null;

/** Record the finding of a probe of the default's location (a probe that got that far). */
export async function recordDefaultWriteOnce(
  location: StorageLocation,
  finding: WriteOnceFinding | null | undefined,
  db: DbExecutor = providerDb,
): Promise<void> {
  if (!finding) {
    return;
  }
  const value: DefaultStorageWriteOnce = {
    location: describeStorageLocation(location),
    writeOnce: finding.writeOnce,
    refused: [...finding.refused],
    code: finding.code,
    checkedAt: finding.checkedAt,
  };
  await db.update(settings).set({ defaultStorageWriteOnce: value });
  cached = null;
}

/** The finding of the default as it is configured now, or null when its location was never probed. */
export async function defaultWriteOnceFinding(now = Date.now()): Promise<WriteOnceFinding | null> {
  if (cached && cached.until > now) {
    return cached.finding;
  }
  // A finding that cannot be read is no finding: the pages that show it keep working.
  const row = await providerDb
    .select({ value: settings.defaultStorageWriteOnce })
    .from(settings)
    .limit(1)
    .then((rows) => rows[0])
    .catch(() => undefined);
  const current = await currentInstallationDefault().catch(() => null);
  const value = row?.value ?? null;
  const finding =
    value && current && value.location === describeStorageLocation(current.primary)
      ? {
          writeOnce: value.writeOnce,
          refused: value.refused,
          code: value.code,
          checkedAt: value.checkedAt,
        }
      : null;
  cached = { finding, until: now + CACHE_MS };
  return finding;
}

/** Whether the installation default is write-once (for `resolveStorageTargets`). */
export async function defaultWriteOnce(): Promise<boolean> {
  return (await defaultWriteOnceFinding())?.writeOnce === true;
}

/** Forget the cached finding (tests). */
export function forgetDefaultWriteOnce(): void {
  cached = null;
}
