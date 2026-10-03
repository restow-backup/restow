import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  IMAGE_VARIANT_VARIABLE,
  type ImageVariant,
  defaultImageRepositories,
  parseImageVariant,
} from "./image-variant.js";
import { UPDATER_DEFAULT_PORT } from "./protocol.js";
import { DEFAULT_CLI_IMAGE, DEFAULT_COSIGN_IMAGE, DIGEST_PINNED_IMAGE } from "./signature.js";
import {
  SOURCE_ALLOWLIST_VARIABLE,
  type SourceAllowEntry,
  parseSourceAllowlist,
} from "./source-policy.js";

/**
 * Configuration of the updater process, read from its own environment. It holds
 * no application credential (no database URL, no master key): the updater has the
 * Docker socket, which is root on the host, and shares nothing else with the app.
 */

export interface UpdaterConfig {
  port: number;
  /** status.json, database dumps and fetched sources (a volume in the compose file). */
  stateDir: string;
  /** Holds the shared secret; the api mounts it read-only. */
  sharedDir: string;
  /**
   * Absolute host path of the compose project, mounted at the same path inside the
   * container (RESTOW_UPDATER_PROJECT_DIR, from RESTOW_PROJECT_DIR). null: not set; the
   * project is then mounted at {@link PROJECT_MOUNT} and its host path is read from the
   * container's own mount (resolveProjectLocation).
   */
  projectDir: string | null;
  /** Compose project name; null until it is taken from the container's own label. */
  projectName: string | null;
  /** A compose file named explicitly; null lets Compose find the default file(s) in the project. */
  composeFile: string | null;
  /** Where the api answers inside the compose network (no trailing slash). */
  apiUrl: string;
  /**
   * The build this image belongs to (RESTOW_IMAGE_VARIANT, baked into the image):
   * the default repositories and the targets `source` mode builds follow it, so a
   * Community installation stays on the Community images.
   */
  imageVariant: ImageVariant;
  imageRepository: string;
  webImageRepository: string;
  /** Image whose `docker` CLI runs the commands when the updater's own image ships none; pinned by digest. */
  cliImage: string;
  /** The cosign image that verifies release signatures; pinned by digest. */
  cosignImage: string;
  /**
   * Image mode installs only images signed by the release workflow (signature.ts).
   * False (RESTOW_UPDATER_VERIFY_SIGNATURES=false) leaves the digest check alone, for a
   * test installation or a mirror without signatures; the run records it.
   */
  verifySignatures: boolean;
  /**
   * After a successful image-mode update with verified signatures, move the updater to
   * the verified image of that release and recreate it (self-update.ts). On unless
   * RESTOW_UPDATER_SELF_UPDATE=false.
   */
  selfUpdate: boolean;
  healthTimeoutSeconds: number;
  minFreeMb: number;
  dockerSocket: string;
  /** The updater's own version (from the image); null for local builds. */
  version: string | null;
  /**
   * Hosts and repositories `source` mode may build from (RESTOW_UPDATER_SOURCE_HOSTS,
   * source-policy.ts). Empty: `source` mode is off, the default.
   */
  sourceAllowlist: SourceAllowEntry[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid updater configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

/** Switches the updater's own update off when `false` (self-update.ts). */
export const SELF_UPDATE_VARIABLE = "RESTOW_UPDATER_SELF_UPDATE";

/**
 * Where the compose files mount the project when RESTOW_PROJECT_DIR is not set
 * (`${RESTOW_PROJECT_DIR:-.}:${RESTOW_PROJECT_DIR:-/project}`): Compose resolves `.`
 * to the project's absolute host path, which the updater reads back from its own
 * container's mount.
 */
export const PROJECT_MOUNT = "/project";

export const COMPOSE_FILE_CANDIDATES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
] as const;

type Env = Readonly<Record<string, string | undefined>>;

const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const REPOSITORY = /^[a-z0-9][a-z0-9._/:-]{0,199}$/;
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function integer(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = text(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

/** A plain absolute path (no ':' or ',', which would break a bind specification); null when it is not one. */
function plainAbsolutePath(raw: string): string | null {
  if (!path.posix.isAbsolute(raw) || /[\0\n\r:,]/.test(raw) || raw.split("/").includes("..")) {
    return null;
  }
  const normalized = path.posix.normalize(raw);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function absolutePath(env: Env, name: string, fallback: string, problems: string[]): string {
  return optionalAbsolutePath(env, name, problems) ?? fallback;
}

function optionalAbsolutePath(env: Env, name: string, problems: string[]): string | null {
  const raw = text(env, name);
  if (raw === undefined) {
    return null;
  }
  const value = plainAbsolutePath(raw);
  if (value === null) {
    problems.push(`${name} must be an absolute path without ':', ',' or '..'`);
    return "/";
  }
  return value;
}

function repository(env: Env, name: string, fallback: string, problems: string[]): string {
  const value = (text(env, name) ?? fallback).replace(/\/+$/, "");
  const last = value.split("/").pop() ?? "";
  if (!REPOSITORY.test(value) || last.includes(":") || value.includes("//")) {
    problems.push(`${name} must be an image repository without tag (for example ghcr.io/org/name)`);
  }
  return value;
}

export function loadConfig(env: Env): UpdaterConfig {
  const problems: string[] = [];

  const port = integer(env, "RESTOW_UPDATER_PORT", UPDATER_DEFAULT_PORT, 1, 65535, problems);
  const stateDir = absolutePath(env, "RESTOW_UPDATER_STATE_DIR", "/state", problems);
  const sharedDir = absolutePath(env, "RESTOW_UPDATER_SHARED_DIR", "/updater-shared", problems);
  const projectDir = optionalAbsolutePath(env, "RESTOW_UPDATER_PROJECT_DIR", problems);
  const dockerSocket = absolutePath(
    env,
    "RESTOW_UPDATER_DOCKER_SOCKET",
    "/var/run/docker.sock",
    problems,
  );

  const projectName = text(env, "RESTOW_UPDATER_PROJECT_NAME") ?? null;
  if (projectName !== null && !PROJECT_NAME.test(projectName)) {
    problems.push("RESTOW_UPDATER_PROJECT_NAME must be a Compose project name (a-z, 0-9, _ and -)");
  }

  const composeFile = text(env, "RESTOW_UPDATER_COMPOSE_FILE") ?? null;
  if (composeFile !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(composeFile)) {
    problems.push("RESTOW_UPDATER_COMPOSE_FILE must be a file name inside the project directory");
  }

  const apiUrlRaw = text(env, "RESTOW_UPDATER_API_URL") ?? "http://api:3000";
  let apiUrl = apiUrlRaw;
  try {
    const parsed = new URL(apiUrlRaw);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("unsupported");
    }
    apiUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    problems.push("RESTOW_UPDATER_API_URL must be an http(s) URL without credentials or query");
  }

  const parsedVariant = parseImageVariant(text(env, IMAGE_VARIANT_VARIABLE));
  if (parsedVariant === null) {
    // Never guess: a wrong guess would install the images of the other build.
    problems.push(`${IMAGE_VARIANT_VARIABLE} must be full or community`);
  }
  const imageVariant = parsedVariant ?? "full";
  const defaults = defaultImageRepositories(imageVariant);
  const imageRepository = repository(
    env,
    "RESTOW_UPDATER_IMAGE_REPOSITORY",
    defaults.app,
    problems,
  );
  const webImageRepository = repository(
    env,
    "RESTOW_UPDATER_WEB_IMAGE_REPOSITORY",
    defaults.web,
    problems,
  );

  // Both images run with the Docker socket or decide what may run: a tag could be moved
  // under the updater, a digest cannot.
  const cliImage = text(env, "RESTOW_UPDATER_CLI_IMAGE") ?? DEFAULT_CLI_IMAGE;
  if (!IMAGE_REFERENCE.test(cliImage) || !DIGEST_PINNED_IMAGE.test(cliImage)) {
    problems.push(
      "RESTOW_UPDATER_CLI_IMAGE must be an image reference pinned by digest (name:tag@sha256:...)",
    );
  }
  const cosignImage = text(env, "RESTOW_UPDATER_COSIGN_IMAGE") ?? DEFAULT_COSIGN_IMAGE;
  if (!IMAGE_REFERENCE.test(cosignImage) || !DIGEST_PINNED_IMAGE.test(cosignImage)) {
    problems.push(
      "RESTOW_UPDATER_COSIGN_IMAGE must be an image reference pinned by digest (name:tag@sha256:...)",
    );
  }
  const verifyRaw = text(env, "RESTOW_UPDATER_VERIFY_SIGNATURES")?.toLowerCase() ?? "true";
  if (verifyRaw !== "true" && verifyRaw !== "false") {
    problems.push("RESTOW_UPDATER_VERIFY_SIGNATURES must be true or false");
  }
  const verifySignatures = verifyRaw !== "false";
  const selfUpdateRaw = text(env, SELF_UPDATE_VARIABLE)?.toLowerCase() ?? "true";
  if (selfUpdateRaw !== "true" && selfUpdateRaw !== "false") {
    problems.push(`${SELF_UPDATE_VARIABLE} must be true or false`);
  }
  const selfUpdate = selfUpdateRaw !== "false";

  const healthTimeoutSeconds = integer(
    env,
    "RESTOW_UPDATER_HEALTH_TIMEOUT_SECONDS",
    600,
    10,
    7200,
    problems,
  );
  const minFreeMb = integer(env, "RESTOW_UPDATER_MIN_FREE_MB", 1024, 0, 100_000_000, problems);

  const allowlist = parseSourceAllowlist(text(env, SOURCE_ALLOWLIST_VARIABLE));
  for (const problem of allowlist.problems) {
    problems.push(`${SOURCE_ALLOWLIST_VARIABLE}: ${problem}`);
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    port,
    stateDir,
    sharedDir,
    projectDir,
    projectName,
    composeFile,
    apiUrl,
    imageVariant,
    imageRepository,
    webImageRepository,
    cliImage,
    cosignImage,
    verifySignatures,
    selfUpdate,
    healthTimeoutSeconds,
    minFreeMb,
    dockerSocket,
    version: text(env, "RESTOW_VERSION") ?? null,
    sourceAllowlist: allowlist.entries,
  };
}

/** The compose file the project uses: the explicit one, else the first default that exists. */
export async function findComposeFile(
  projectDir: string,
  explicit: string | null,
): Promise<string | null> {
  const candidates = explicit ? [explicit] : COMPOSE_FILE_CANDIDATES;
  for (const name of candidates) {
    try {
      const stat = await fs.stat(path.join(projectDir, name));
      if (stat.isFile()) {
        return name;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Where the project is on the host (for helper containers and Compose) and inside this container (for files). */
export interface ProjectLocation {
  /** Absolute host path: helper containers bind it at the same path and run Compose there. */
  hostDir: string;
  /** Where this process reads `.env` and the compose file. Equal to `hostDir` when RESTOW_PROJECT_DIR is set. */
  localDir: string;
}

export interface SelfMounts {
  mounts: readonly { Type: string; Source: string; Destination: string }[];
}

/**
 * The project's location. RESTOW_UPDATER_PROJECT_DIR (the operator's RESTOW_PROJECT_DIR)
 * wins: mounted at the same path on both sides. Without it, the compose file mounts the
 * project directory at {@link PROJECT_MOUNT} and the bind's source is the host path.
 */
export function resolveProjectLocation(
  configured: string | null,
  self: SelfMounts | null,
): ProjectLocation | { problem: string } {
  if (configured !== null) {
    return { hostDir: configured, localDir: configured };
  }
  const mount = self?.mounts.find(
    (entry) => entry.Destination === PROJECT_MOUNT && entry.Type === "bind",
  );
  if (!mount) {
    return {
      problem: `RESTOW_UPDATER_PROJECT_DIR is not set and no project directory is mounted at ${PROJECT_MOUNT}. Use the docker-compose.yml of this release, or set RESTOW_PROJECT_DIR in .env to the absolute path of the directory that holds docker-compose.yml.`,
    };
  }
  const hostDir = plainAbsolutePath(mount.Source);
  if (hostDir === null) {
    return {
      problem: `The project directory is mounted from ${mount.Source}, which is not a plain absolute path. Set RESTOW_PROJECT_DIR in .env.`,
    };
  }
  return { hostDir, localDir: PROJECT_MOUNT };
}
