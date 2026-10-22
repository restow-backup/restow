import { DEFAULT_LICENSE_SERIES } from "./token.js";

/**
 * Update entitlement: whether a licence key covers a given release
 * (docs/LICENSING.md, "Updates"). Pure: it compares the key's terms with the
 * release's own version and release date and never reads the clock, so a
 * release that is covered once stays covered forever. Nothing at runtime ever
 * stops because of it; it decides only
 *
 * - which release the updater offers and installs (apps/api features/updates),
 * - whether the api of a new release starts with a Business or Service Provider
 *   key that does not cover it (./startup-check.ts, before any migration),
 * - whether a key can be installed on the running release.
 *
 * Rules, for a key with
 *
 * - no `updates_until` (the beta licences sold before 1.0, and every key issued
 *   before 0.4.5): covered iff the release's major version is the key's series;
 *   series "1" also covers every 0.x pre-release;
 * - `updates_until`: covered iff the release was made up to the end of that day
 *   (UTC), whatever its version.
 *
 * A development build (no release date, or no release version) is always
 * covered: it is nothing the vendor released.
 */

/** A key's terms that decide its updates: a verified key, or an installed row. */
export interface UpdateTerms {
  /** The series; null for keys without the member (`"1"`). */
  series: string | null;
  /** Last day of the update period (`YYYY-MM-DD`), or null. */
  updatesUntil: string | null;
}

/** The release in question: the running build, or a release the updater could install. */
export interface ReleaseBuild {
  /** `1.2.3` or `1.2.3-rc.1` (a leading `v` is ignored); null for a build without one. */
  version: string | null;
  /** When the release was made; null for a development build. */
  releasedAt: Date | string | null;
}

export type EntitlementReason =
  /** No key is installed: Community needs no update entitlement. */
  | "no_key"
  /** A development build (no release date or version): always covered. */
  | "development_build"
  /** A key without update period whose series includes the release. */
  | "series"
  /** A key without update period whose series does not include the release. */
  | "outside_series"
  /** The release was made within the update period. */
  | "within_period"
  /** The release was made after the update period ended. */
  | "after_period";

export interface UpdateEntitlement {
  /** Whether the Business and Service Provider modules of the key work with this release. */
  entitled: boolean;
  reason: EntitlementReason;
  /** The last day of the update period (`YYYY-MM-DD`), null without one. */
  coveredUntil: string | null;
  /** The key's series; null without a key. */
  series: string | null;
}

const VERSION = /^v?(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The major version of `version`, or null when it is not a release version. */
export function majorVersionOf(version: string | null): number | null {
  const match = version ? VERSION.exec(version.trim()) : null;
  return match ? Number(match[1]) : null;
}

/** The series a release belongs to: its major version, 0.x pre-releases counting as "1". */
export function seriesOfVersion(major: number): string {
  return String(Math.max(major, 1));
}

/** The end of the last day of the period, UTC: the latest instant a covered release can carry. */
export function endOfUpdatePeriod(updatesUntil: string): Date {
  const [year, month, day] = updatesUntil.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
}

function instantOf(value: Date | string | null): number | null {
  if (value === null) {
    return null;
  }
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Whether `license` covers `build` (see the rules above). Never consults the clock. */
export function updateEntitlement(
  license: UpdateTerms | null,
  build: ReleaseBuild,
): UpdateEntitlement {
  if (!license) {
    return { entitled: true, reason: "no_key", coveredUntil: null, series: null };
  }
  const series = license.series ?? DEFAULT_LICENSE_SERIES;
  const coveredUntil = license.updatesUntil;
  const result = (entitled: boolean, reason: EntitlementReason): UpdateEntitlement => ({
    entitled,
    reason,
    coveredUntil,
    series,
  });
  if (coveredUntil === null) {
    const major = majorVersionOf(build.version);
    if (major === null) {
      return result(true, "development_build");
    }
    return seriesOfVersion(major) === series
      ? result(true, "series")
      : result(false, "outside_series");
  }
  const releasedAt = instantOf(build.releasedAt);
  if (releasedAt === null) {
    return result(true, "development_build");
  }
  return releasedAt <= endOfUpdatePeriod(coveredUntil).getTime()
    ? result(true, "within_period")
    : result(false, "after_period");
}

/** Environment variable carrying the release date of the build (Dockerfile, from RESTOW_CREATED). */
export const RELEASED_AT_ENV = "RESTOW_RELEASED_AT";

/** The running build, from the environment the image was built with. */
export function runningBuildOf(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReleaseBuild {
  const version = env.RESTOW_VERSION?.trim().replace(/^v/, "") || null;
  const raw = env[RELEASED_AT_ENV]?.trim() ?? "";
  const time = raw ? Date.parse(raw) : Number.NaN;
  return { version, releasedAt: Number.isNaN(time) ? null : new Date(time) };
}
