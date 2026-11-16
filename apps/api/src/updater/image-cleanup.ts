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
 *     this installation: the Restow repositories (the configured application and web
 *     repositories, their full and Community twins, the local names `source` mode builds:
 *     `restow`, `restow-web` and their `-community` twins) or the repositories of the
 *     Restow images the compose project is configured with (api, worker, scheduler,
 *     updater, mounter) and the run used. The edge image is never one of them: an
 *     override may run a stock Caddy there, and Caddy's versions are not Restow's. An
 *     image without any reference (dangling) or with a reference anywhere else is never
 *     touched;
 *   - its release is known and older than the previous version: the images of the
 *     version that runs now and of the version before it stay, so a manual rollback needs
 *     no download. The release is the image's version label or RESTOW_VERSION; a version
 *     tag counts only for an image whose names are all in the Restow repositories, as a
 *     repository that is only known from the compose configuration may hold other
 *     things with tags of their own;
 *   - no container of the Docker host uses it, running or stopped;
 *   - the compose project is not configured with it (api, worker, scheduler, edge,
 *     updater, mounter), and it is not one of the images the run replaced.
 *
 * It is removed by its ID, never forced. Docker refuses that for an image with more than
 * one name, so its other names are taken off first, one by one and each only after
 * checking that it still names that image; the last name goes with the image. Anything
 * that goes wrong is logged; it never changes the outcome of the update.
 */

export interface ImageCleanupInput {
  images: readonly LocalImage[];
  /** IDs of the images any container uses. */
  inUse: ReadonlySet<string>;
  /** The Restow repositories (normalized, see {@link normalizeRepository}). */
  repositories: ReadonlySet<string>;
  /**
   * Further repositories of this installation, known only from what it is configured
   * with: their images go only by their version label or RESTOW_VERSION, never by a tag.
   */
  configuredRepositories?: ReadonlySet<string>;
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
 * The Restow repositories of this installation: the configured ones, the other build's
 * twins of each and the local names `source` mode builds.
 */
export function installationRepositories(input: {
  imageRepository: string;
  webImageRepository: string;
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
  return names;
}

/** The repositories of the given references (`name:tag`, `name@digest`; IDs and null skipped). */
export function repositoriesOf(references: readonly (string | null)[]): Set<string> {
  const names = new Set<string>();
  for (const reference of references) {
    if (reference && !/^sha256:[0-9a-f]{64}$/.test(reference)) {
      const repository = repositoryOf(reference);
      if (repository) {
        names.add(repository);
      }
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

/**
 * The release of an image: its version (label or RESTOW_VERSION), else, with `byTag`, the
 * version tag of its references.
 */
export function releaseOf(image: LocalImage, byTag = true): SemVer | null {
  if (image.version) {
    const parsed = parseVersion(image.version);
    if (parsed) {
      return parsed;
    }
  }
  if (!byTag) {
    return null;
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
  const configured = input.configuredRepositories ?? new Set<string>();
  const inRestow = (image: LocalImage): boolean =>
    referencesOf(image).every((reference) => input.repositories.has(repositoryOf(reference)));
  const own = input.images.filter((image) => {
    const references = referencesOf(image);
    return (
      references.length > 0 &&
      references.every((reference) => {
        const repository = repositoryOf(reference);
        return input.repositories.has(repository) || configured.has(repository);
      })
    );
  });
  // A version tag tells the release only in a Restow repository.
  const release = (image: LocalImage): SemVer | null => releaseOf(image, inRestow(image));

  // The version before the current one: the one the run replaced, else the newest older
  // release that is present.
  let previous = input.previousVersion ? parseVersion(input.previousVersion) : null;
  if (previous && current && compareVersions(previous, current) > 0) {
    previous = current;
  }
  if (!previous && current) {
    for (const image of own) {
      const version = release(image);
      if (
        version &&
        compareVersions(version, current) < 0 &&
        (!previous || compareVersions(version, previous) > 0)
      ) {
        previous = version;
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
    const version = release(image);
    if (!version) {
      plan.kept.push({ image, reason: "unknown_version" });
      continue;
    }
    if (!cutoff || compareVersions(version, cutoff) >= 0) {
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
    | "untagImage"
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
  /** Restow images the run replaced or installed (kept whatever their version). */
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
  // The Restow images the project names; their repositories belong to the installation.
  const restow = [
    configured.api,
    configured.worker,
    configured.scheduler,
    updater,
    mounter,
    ...request.keep,
  ];
  const repositories = installationRepositories({
    imageRepository: request.imageRepository,
    webImageRepository: request.webImageRepository,
  });
  // The edge image is only kept: its repository is not taken for Restow's.
  const keep = [...restow, configured.caddy];
  const images = await ops.listImages();
  const inUse = await ops.containerImageIds();
  const plan = planImageCleanup({
    images,
    inUse,
    repositories,
    configuredRepositories: repositoriesOf(restow),
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
      for (const reference of extraNames(image)) {
        await ops.untagImage(reference, image.id);
      }
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

/**
 * The names to take off an image before Docker removes it by ID without `--force`: all
 * tags but the first, and the digests of any other repository. What stays is one tag
 * and digests of its repository (or the digests of one repository), which Docker
 * accepts. Each name taken off leaves the image at least one other.
 */
export function extraNames(image: LocalImage): string[] {
  const anchor = image.tags[0] ?? image.digests[0];
  if (!anchor) {
    return [];
  }
  const repository = repositoryOf(anchor);
  return [
    ...image.tags.slice(1),
    ...image.digests.filter((digest) => repositoryOf(digest) !== repository),
  ];
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
