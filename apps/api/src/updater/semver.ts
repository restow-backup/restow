/**
 * Semantic versions for the updater: parsing, ordering and the forms a version
 * takes in image tags. Self-contained on purpose (the updater imports nothing
 * from the application, see boundary.test.ts); the ordering follows
 * https://semver.org/#spec-item-11 and matches routes/v1/version.ts.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse `1.2.3`, `v1.2.3-rc.1` (build metadata ignored); null for anything else. */
export function parseVersion(value: string): SemVer | null {
  const match = SEMVER.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) {
    return Number(a) - Number(b);
  }
  if (numericA !== numericB) {
    return numericA ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semantic version precedence: negative when `a` is older than `b`. */
export function compareVersions(a: SemVer, b: SemVer): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) {
    return core;
  }
  // A pre-release precedes its release.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) {
      return left === undefined ? -1 : 1;
    }
    const order = compareIdentifiers(left, right);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

/**
 * The version as image tags and build arguments carry it: no leading `v`, no
 * surrounding space. `v0.1.0` and `0.1.0` name the same release.
 */
export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/, "");
}

/**
 * A version the updater accepts as an update target: strict `MAJOR.MINOR.PATCH`
 * with an optional pre-release, no build metadata (`+` is not valid in an image
 * tag). Returns the normalized form, or null.
 */
export function targetVersionOf(value: string): string | null {
  const normalized = normalizeVersion(value);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) {
    return null;
  }
  return parseVersion(normalized) ? normalized : null;
}

/** Whether `candidate` is strictly newer than `running`; null when either is not a version. */
export function isNewerVersion(running: string, candidate: string): boolean | null {
  const current = parseVersion(running);
  const next = parseVersion(candidate);
  if (!current || !next) {
    return null;
  }
  return compareVersions(current, next) < 0;
}

/** Whether two version strings name the same release (`v` prefix and build metadata ignored). */
export function sameVersion(a: string, b: string): boolean {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left && right) {
    return compareVersions(left, right) === 0;
  }
  return normalizeVersion(a) === normalizeVersion(b);
}
