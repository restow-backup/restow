import { fullBuildRepositories, imageNamesOf } from "./image-variant.js";
import type { Logger } from "./logger.js";
import type { DockerOps, LocalImage } from "./ops.js";
import type { Redactor } from "./redact.js";
import { compareVersions, parseVersion, type SemVer } from "./semver.js";

/**
 * Removing the images of earlier releases after an update succeeded (docs/UPDATING.md,
 * "Old images"). Every update pulls (or builds) two new images of a few hundred MB to
 * a few GB, and nothing ever removed the old ones: over a year of releases they fill
 * the disk, and a full disk stops PostgreSQL.
 *
 * Only after the run is recorded as succeeded, and with these rules, all of which must
 * hold for an image to be removed:
 *
 *   - every reference of the image (`name:tag`, `name@sha256:...`) is in a repository of
 *     this installation: the configured application and web repositories, their full and
 *     Community twins, the local names `source` mode builds (`restow`, `restow-web` and
 *     their `-community` twins) and the repositories of the images the compose project
 *     is configured with (api, edge, updater, mounter). An image without any reference
 *     (dangling) or with a reference anywhere else is never touched;
 *   - its release is known (the version label, RESTOW_VERSION or a version tag) and older
 *     than the previous version: the images of the version that runs now and of the
 *     version before it stay, so a manual rollback needs no download;
 *   - no container of the Docker host uses it, running or stopped;
 *   - the compose project is not configured with it (api, worker, scheduler, edge,
 *     updater, mounter), and it is not one of the images the run replaced.
 *
 * It is removed by its ID, never forced. Anything that goes wrong is logged and ends
 * the cleanup; it never changes the outcome of the update.
 */

export interface ImageCleanupInput {
  images: readonly LocalImage[];
  /** IDs of the images any container uses. */
  inUse: ReadonlySet<string>;
  /** The repositories of this installation (normalized, see {@link normalizeRepository}). */
  repositories: ReadonlySet<string>;
  /** Image references that are kept whatever their version (configured, replaced). */
  keep: readonly (string | null)[];
  /** The version that runs now. */
  currentVersion: string;
  /** The version that ran before the update; null when it is not known. */
  previousVersion: string | null;
}

export type KeepReason =
  | "foreign"
  | "in_use"
  | "configured"
  | "unknown_version"
  | "current_or_previous";

export interface ImageCleanupPlan {
  remove: LocalImage[];
  /** Images of this installation that stay, with why. */
  kept: { image: LocalImage; reason: Exclude<KeepReason, "foreign"> }[];
  /** The version below which images are removed; null: nothing is removed. */
  cutoff: string | null;
}

/** `docker.io/library/x` and `x` are the same repository; names are compared in lower case. */
export function normalizeRepository(name: string): string {
  let value = name.trim().toLowerCase();
  if (value.startsWith("docker.io/")) {
    value = value.slice("docker.io/".length);
  }
  if (value.startsWith("library/")) {
    value = value.slice("library/".length);
  }
  return value;
}

/** The repository of an image reference: without the digest and without the tag. */
export function repositoryOf(reference: string): string {
  let name = reference.trim();
  const at = name.indexOf("@");
  if (at >= 0) {
    name = name.slice(0, at);
  }
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  if (colon > slash) {
    name = name.slice(0, colon);
  }
  return normalizeRepository(name);
}

/**
 * The repositories of this installation: the configured ones, the other build's twins
 * of each, the local names `source` mode builds, and those of the given references.
 */
export function installationRepositories(input: {
  imageRepository: string;
  webImageRepository: string;
  references: readonly (string | null)[];
}): Set<string> {
  const names = new Set<string>();
  const add = (name: string): void => {
    const normalized = normalizeRepository(name);
    if (normalized) {
      names.add(normalized);
    }
  };
  for (const repository of [input.imageRepository, input.webImageRepository]) {
    add(repository);
    add(repository.endsWith("-community") ? repository : `${repository}-community`);
  }
  const full = fullBuildRepositories({
    app: input.imageRepository,
    web: input.webImageRepository,
  });
  if (full) {
    add(full.app);
    add(full.web);
  }
  for (const variant of ["full", "community"] as const) {
    const local = imageNamesOf(variant);
    add(local.app);
    add(local.web);
  }
  for (const reference of input.references) {
    if (reference && !/^sha256:[0-9a-f]{64}$/.test(reference)) {
      add(repositoryOf(reference));
    }
  }
  return names;
}

function referencesOf(image: LocalImage): string[] {
  return [...image.tags, ...image.digests];
}

/** Whether `reference` (`name:tag`, `name@digest`, `name:tag@digest`, `name` or an ID) names the image. */
export function referenceMatches(reference: string, image: LocalImage): boolean {
  const value = reference.trim();
  if (!value) {
    return false;
  }
  if (/^sha256:[0-9a-f]{64}$/.test(value)) {
    return value === image.id;
  }
  const repository = repositoryOf(value);
  const at = value.indexOf("@");
  if (at >= 0) {
    const digest = value.slice(at + 1);
    return image.digests.some(
      (entry) =>
        repositoryOf(entry) === repository && entry.slice(entry.indexOf("@") + 1) === digest,
    );
  }
  const slash = value.lastIndexOf("/");
  const colon = value.lastIndexOf(":");
  const tag = colon > slash ? value.slice(colon + 1) : "latest";
  return image.tags.some((entry) => {
    const entryColon = entry.lastIndexOf(":");
    return (
      repositoryOf(entry) === repository &&
      entryColon > entry.lastIndexOf("/") &&
      entry.slice(entryColon + 1) === tag
    );
  });
}

/** The release of an image: its version, else the version tag of its references. */
export function releaseOf(image: LocalImage): SemVer | null {
  if (image.version) {
    const parsed = parseVersion(image.version);
    if (parsed) {
      return parsed;
    }
  }
  for (const tag of image.tags) {
    const colon = tag.lastIndexOf(":");
    if (colon > tag.lastIndexOf("/")) {
      const parsed = parseVersion(tag.slice(colon + 1));
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

function formatVersion(version: SemVer): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length > 0 ? `${core}-${version.prerelease.join(".")}` : core;
}

/** Which images go (pure). */
export function planImageCleanup(input: ImageCleanupInput): ImageCleanupPlan {
  const current = parseVersion(input.currentVersion);
  const own = input.images.filter((image) => {
    const references = referencesOf(image);
    return (
      references.length > 0 &&
      references.every((reference) => input.repositories.has(repositoryOf(reference)))
    );
  });

  // The version before the current one: the one the run replaced, else the newest older
  // release that is present.
  let previous = input.previousVersion ? parseVersion(input.previousVersion) : null;
  if (previous && current && compareVersions(previous, current) > 0) {
    previous = current;
  }
  if (!previous && current) {
    for (const image of own) {
      const release = releaseOf(image);
      if (
        release &&
        compareVersions(release, current) < 0 &&
        (!previous || compareVersions(release, previous) > 0)
      ) {
        previous = release;
      }
    }
  }
  const cutoff = current ? (previous ?? current) : null;

  const plan: ImageCleanupPlan = {
    remove: [],
    kept: [],
    cutoff: cutoff ? formatVersion(cutoff) : null,
  };
  const keep = input.keep.filter((reference): reference is string => !!reference);
  for (const image of own) {
    if (input.inUse.has(image.id)) {
      plan.kept.push({ image, reason: "in_use" });
      continue;
    }
    if (keep.some((reference) => referenceMatches(reference, image))) {
      plan.kept.push({ image, reason: "configured" });
      continue;
    }
    const release = releaseOf(image);
    if (!release) {
      plan.kept.push({ image, reason: "unknown_version" });
      continue;
    }
    if (!cutoff || compareVersions(release, cutoff) >= 0) {
      plan.kept.push({ image, reason: "current_or_previous" });
      continue;
    }
    plan.remove.push(image);
  }
  return plan;
}

export interface ImageCleanupResult {
  /** Images removed. */
  removed: number;
  /** Their sizes together (layers they shared with images that stay are not freed). */
  bytes: number;
  /** Images that were to be removed but Docker refused or the cleanup stopped first. */
  failed: number;
  /** Images of this installation that stay. */
  kept: number;
}

export interface ImageCleanupDeps {
  ops: Pick<
    DockerOps,
    | "listImages"
    | "containerImageIds"
    | "removeImage"
    | "configImages"
    | "configUpdaterImage"
    | "configMounterImage"
  >;
  logger: Logger;
  redactor: Redactor;
}

export interface ImageCleanupRequest {
  imageRepository: string;
  webImageRepository: string;
  currentVersion: string;
  previousVersion: string | null;
  /** References the run replaced or installed (kept whatever their version). */
  keep: readonly (string | null)[];
  /** Checked before every removal: false stops the cleanup (a new run began, shutdown). */
  proceed: () => boolean;
}

/**
 * Remove the images of earlier releases. Throws only when what is configured or what
 * is present could not be read (then nothing was removed); a single image Docker
 * refuses to remove is logged and counted as failed.
 */
export async function removeOldImages(
  deps: ImageCleanupDeps,
  request: ImageCleanupRequest,
): Promise<ImageCleanupResult> {
  const { ops, logger, redactor } = deps;
  // What the project is configured with now (the variables as .env has them).
  const configured = await ops.configImages({});
  const updater = await ops.configUpdaterImage({});
  const mounter = await ops.configMounterImage({});
  const keep = [
    configured.api,
    configured.caddy,
    configured.worker,
    configured.scheduler,
    updater,
    mounter,
    ...request.keep,
  ];
  const repositories = installationRepositories({
    imageRepository: request.imageRepository,
    webImageRepository: request.webImageRepository,
    references: keep,
  });
  const images = await ops.listImages();
  const inUse = await ops.containerImageIds();
  const plan = planImageCleanup({
    images,
    inUse,
    repositories,
    keep,
    currentVersion: request.currentVersion,
    previousVersion: request.previousVersion,
  });

  const result: ImageCleanupResult = { removed: 0, bytes: 0, failed: 0, kept: plan.kept.length };
  for (const image of plan.remove) {
    if (!request.proceed()) {
      result.failed += plan.remove.length - result.removed - result.failed;
      break;
    }
    const name = referencesOf(image)[0] ?? image.id;
    try {
      await ops.removeImage(image.id);
      result.removed += 1;
      result.bytes += image.bytes;
      logger.info(`Removed the old image ${name} (${image.id.slice(7, 19)}).`);
    } catch (error) {
      result.failed += 1;
      logger.warn(
        `Could not remove the old image ${name}: ${redactor.oneLine(describeError(error), 300)}`,
      );
    }
  }
  return result;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const detail = (error as { detail?: unknown }).detail;
    return typeof detail === "string" && detail ? `${error.message} ${detail}` : error.message;
  }
  return String(error);
}

/** `1.2 GB`, `340 MB`: for the log line. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
