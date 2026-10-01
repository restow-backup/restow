import { z } from "zod";
import { component } from "./components.js";
import { timestampSchema } from "./schemas.js";

/**
 * The running version and the opt-in update hint (docs/ARCHITECTURE.md,
 * Updates): RMM systems mark outdated installations from `/api/v1/status`.
 *
 * - The running version is stamped into the image at build time
 *   (`RESTOW_VERSION`, the release tag). A build without it reports null
 *   rather than a made-up number.
 * - The update check is off until an administrator turns it on under
 *   Settings, Updates (or the operator sets `RESTOW_UPDATE_CHECK_URL`, which
 *   wins). It only reads a release list: no request carries any data about the
 *   installation. The result is cached by features/updates; a status call
 *   never waits for the network.
 * - Fields were only ever added to this document, never renamed or removed:
 *   an integration written against an earlier version keeps working.
 */

export const updateCheckStateSchema = component(
  "UpdateCheckState",
  z
    .enum(["disabled", "pending", "ok", "failed"])
    .describe(
      "`disabled` unless an administrator or the operator turned the check on; `pending` until the first check finished; `failed` when the release list could not be read (the last good result stays).",
    ),
);

export const versionInfoSchema = component(
  "VersionInfo",
  z.object({
    running: z
      .string()
      .nullable()
      .describe("Version of the running build; null for builds without a release tag."),
    commit: z
      .string()
      .nullable()
      .describe(
        "Short git revision the running build was made from; null when the build does not carry it.",
      ),
    latest: z
      .string()
      .nullable()
      .describe("Newest published release of the channel, when the check ran."),
    updateAvailable: z
      .boolean()
      .nullable()
      .describe("Whether a newer release exists; null when that is not known."),
    releaseUrl: z.string().nullable().describe("Release notes of the newest release."),
    updateCheck: updateCheckStateSchema,
    checkedAt: timestampSchema.nullable(),
    channel: z
      .enum(["stable", "beta"])
      .describe("Release channel of the check; `beta` also offers pre-releases."),
    latestTag: z.string().nullable().describe("The tag of `latest` as published, e.g. `v1.2.3`."),
    publishedAt: timestampSchema.nullable().describe("When `latest` was published."),
    checkError: z
      .string()
      .nullable()
      .describe(
        "Why the last check failed (`rate_limited`, `unauthorized`, `not_found`, `forbidden`, `server_error`, `network`, `timeout`, `invalid_response`, `no_release`, `redirect`); null when it did not.",
      ),
    maintenance: z
      .object({
        phase: z.enum(["scheduled", "running"]),
        targetVersion: z.string(),
        startsAt: timestampSchema,
      })
      .nullable()
      .describe(
        "An update announced or running through the updater; null otherwise. The installation is briefly unavailable while it runs.",
      ),
  }),
);
export type VersionInfo = z.infer<typeof versionInfoSchema>;

export interface VersionSource {
  /** The version state as known now; starts a background refresh when due. */
  current(): VersionInfo;
}

// ---------------------------------------------------------------------------
// Semantic versions
// ---------------------------------------------------------------------------

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

/** Whether `latest` is newer than `running`; null when either is not a version. */
export function isUpdateAvailable(running: string | null, latest: string | null): boolean | null {
  const current = running ? parseVersion(running) : null;
  const newest = latest ? parseVersion(latest) : null;
  if (!current || !newest) {
    return null;
  }
  return compareVersions(current, newest) < 0;
}

const REVISION = /^[0-9a-f]{7,40}$/i;

/** The revision stamped into the image (`RESTOW_REVISION`), shortened to 7 digits, or null. */
export function runningCommitFrom(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const value = env.RESTOW_REVISION?.trim() ?? "";
  return REVISION.test(value) ? value.slice(0, 7).toLowerCase() : null;
}

/** The version stamped into the image (`RESTOW_VERSION`, tag prefix `v` dropped), or null. */
export function runningVersionFrom(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const value = env.RESTOW_VERSION?.trim();
  return value ? value.replace(/^v/, "") : null;
}
