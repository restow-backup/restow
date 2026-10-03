import { plainAbsolutePath } from "../updater/config.js";
import { DEFAULT_CLI_IMAGE, DIGEST_PINNED_IMAGE } from "../updater/signature.js";
import { MOUNTER_DEFAULT_PORT } from "./protocol.js";

/**
 * Configuration of the mounter process, read from its own environment. Like the
 * updater it holds no application credential (no database URL, no master key): it
 * has the Docker socket, which is root on the host, and shares nothing else with the
 * application.
 */

export interface MounterConfig {
  port: number;
  /** The operation log (a volume in the compose file). */
  stateDir: string;
  /** Holds the shared secret; the api mounts it read-only. */
  sharedDir: string;
  /** RESTOW_MOUNTER_PROJECT_DIR (from RESTOW_PROJECT_DIR); null: mounted at /project. */
  projectDir: string | null;
  projectName: string | null;
  dockerSocket: string;
  /** Docker CLI image for helper containers and the share test; pinned by digest. */
  cliImage: string;
  healthTimeoutSeconds: number;
  probeTimeoutSeconds: number;
  version: string | null;
}

export class MounterConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid mounter configuration: ${problems.join("; ")}`);
    this.name = "MounterConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
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

function absolutePath(
  env: Env,
  name: string,
  fallback: string | null,
  problems: string[],
): string | null {
  const raw = text(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const value = plainAbsolutePath(raw);
  if (value === null) {
    problems.push(`${name} must be an absolute path without ':', ',' or '..'`);
    return fallback;
  }
  return value;
}

export function loadMounterConfig(env: Env): MounterConfig {
  const problems: string[] = [];
  const port = integer(env, "RESTOW_MOUNTER_PORT", MOUNTER_DEFAULT_PORT, 1, 65535, problems);
  const stateDir = absolutePath(env, "RESTOW_MOUNTER_STATE_DIR", "/state", problems) as string;
  const sharedDir = absolutePath(
    env,
    "RESTOW_MOUNTER_SHARED_DIR",
    "/mounter-shared",
    problems,
  ) as string;
  const projectDir = absolutePath(env, "RESTOW_MOUNTER_PROJECT_DIR", null, problems);
  const dockerSocket = absolutePath(
    env,
    "RESTOW_MOUNTER_DOCKER_SOCKET",
    "/var/run/docker.sock",
    problems,
  ) as string;

  const projectName = text(env, "RESTOW_MOUNTER_PROJECT_NAME") ?? null;
  if (projectName !== null && !PROJECT_NAME.test(projectName)) {
    problems.push("RESTOW_MOUNTER_PROJECT_NAME must be a Compose project name (a-z, 0-9, _ and -)");
  }

  // The image runs with the Docker socket (helpers) and mounts the share (test): a tag
  // could be moved under the mounter, a digest cannot.
  const cliImage = text(env, "RESTOW_MOUNTER_CLI_IMAGE") ?? DEFAULT_CLI_IMAGE;
  if (!IMAGE_REFERENCE.test(cliImage) || !DIGEST_PINNED_IMAGE.test(cliImage)) {
    problems.push(
      "RESTOW_MOUNTER_CLI_IMAGE must be an image reference pinned by digest (name:tag@sha256:...)",
    );
  }

  const healthTimeoutSeconds = integer(
    env,
    "RESTOW_MOUNTER_HEALTH_TIMEOUT_SECONDS",
    300,
    10,
    3600,
    problems,
  );
  const probeTimeoutSeconds = integer(
    env,
    "RESTOW_MOUNTER_PROBE_TIMEOUT_SECONDS",
    60,
    5,
    600,
    problems,
  );

  if (problems.length > 0) {
    throw new MounterConfigError(problems);
  }
  return {
    port,
    stateDir,
    sharedDir,
    projectDir,
    projectName,
    dockerSocket,
    cliImage,
    healthTimeoutSeconds,
    probeTimeoutSeconds,
    version: text(env, "RESTOW_VERSION") ?? null,
  };
}
