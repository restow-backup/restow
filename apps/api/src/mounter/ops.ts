import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { findComposeFile } from "../updater/config.js";
import { EngineApiError, type EngineClient } from "../updater/engine-api.js";
import { envValueOf } from "../updater/env-file.js";
import type { Logger } from "../updater/logger.js";
import { parseComposePs } from "../updater/ops-cli.js";
import {
  type CommandResult,
  type CommandRunner,
  OpsError,
  type RunnerReadiness,
  type ServiceState,
} from "../updater/ops.js";
import type { Redactor } from "../updater/redact.js";
import { writeAtomic } from "../updater/store.js";
import { nfsDevice, nfsMountOptions } from "./override.js";
import {
  MANAGED_VOLUME_LABEL,
  type MountFailureCode,
  type MountSpec,
  PROBE_LABEL,
} from "./protocol.js";

/**
 * The seam between the mounter's engine and Docker. The engine is driven only through
 * {@link MountOps}, so every scenario (a probe that fails, a config Compose refuses, an
 * api that does not come back) can be scripted with a fake (engine.test.ts).
 *
 * {@link DockerMountOps} implements it with the updater's building blocks: Compose
 * commands through a CommandRunner (the `docker` binary or a helper container,
 * runner-local.ts and runner-helper.ts), volumes and the probe container through the
 * Engine API client (engine-api.ts). Every command is an argument vector; nothing a
 * request carries ever becomes part of a shell script.
 */

/** Compose discovers the override among these, the first that exists (compose-go DefaultOverrideFileNames). */
export const OVERRIDE_FILE_CANDIDATES = [
  "compose.override.yml",
  "compose.override.yaml",
  "docker-compose.override.yml",
  "docker-compose.override.yaml",
] as const;

/** The override the mounter creates when the project has none. */
export const DEFAULT_OVERRIDE_FILE = "docker-compose.override.yml";

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_VOLUME_LABEL = "com.docker.compose.volume";

export interface ProbeOutcome {
  ok: boolean;
  code: MountFailureCode | null;
  /** Redacted, single line. */
  detail: string | null;
  wrote: boolean;
}

export interface ManagedVolume {
  /** The Docker volume name (`<project>_restow-nfs-...`). */
  name: string;
  /** The compose volume key (`restow-nfs-...`). */
  key: string;
}

export interface MountOps {
  readonly runnerKind: "cli" | "helper";
  /** Docker answers. Throws OpsError otherwise. */
  ping(): Promise<void>;
  readiness(): Promise<RunnerReadiness>;
  /** The project's compose file (name), or null when there is none. */
  composeFile(): Promise<string | null>;
  /** `.env` sets COMPOSE_FILE: Compose would then not read the override on its own. */
  composeFileVariableSet(): Promise<boolean>;
  /** The override file's name (the one that exists, else {@link DEFAULT_OVERRIDE_FILE}). */
  overrideFile(): Promise<string>;
  /** Its text; null when it does not exist. */
  readOverride(): Promise<string | null>;
  /** Replace it atomically; null removes it. */
  writeOverride(text: string | null): Promise<void>;
  /** `docker compose config -q`: Compose accepts the project with the override. Throws OpsError. */
  validateConfig(): Promise<void>;
  /** `up -d --no-deps --no-build --pull never` for exactly these services. Throws OpsError. */
  composeUp(services: readonly string[]): Promise<void>;
  servicesState(): Promise<ServiceState[]>;
  /** Mount the share in a short-lived container and write (or, read-only, list) a file. Never throws. */
  probe(spec: MountSpec, timeoutMs: number): Promise<ProbeOutcome>;
  /** The managed volumes of this project that exist in Docker. */
  managedVolumes(): Promise<ManagedVolume[]>;
  /** Remove a volume (a missing one counts as removed). Throws when it is in use. */
  removeVolume(name: string): Promise<void>;
}

export interface DockerMountOpsOptions {
  runner: CommandRunner;
  engine: EngineClient;
  redactor: Redactor;
  logger: Logger;
  /** Where this process reads and writes the project's files. */
  projectDir: string;
  projectName: string;
  /** Image of the probe container (the Docker CLI image, pinned by digest; it has a shell). */
  probeImage: string;
}

const MINUTE = 60_000;
const SERVICE_NAME = /^[a-z][a-z0-9_-]{0,62}$/;
const PROBE_FILE = /^\.restow-probe-[0-9a-f]{16}$/;

/** Write, read back and remove a file (the name arrives as `$1`, never as script). */
const PROBE_WRITE_SCRIPT =
  'set -eu; f="/probe/$1"; echo restow > "$f"; test -s "$f"; rm -f "$f"; echo ok';
const PROBE_LIST_SCRIPT = "set -eu; ls -A /probe > /dev/null; echo ok";

export class DockerMountOps implements MountOps {
  constructor(private readonly options: DockerMountOpsOptions) {}

  get runnerKind(): "cli" | "helper" {
    return this.options.runner.kind;
  }

  async ping(): Promise<void> {
    try {
      await this.options.engine.ping();
    } catch (error) {
      throw new OpsError(
        "Docker is not reachable.",
        this.options.redactor.oneLine((error as Error).message, 500),
      );
    }
  }

  readiness(): Promise<RunnerReadiness> {
    return this.options.runner.readiness();
  }

  composeFile(): Promise<string | null> {
    return findComposeFile(this.options.projectDir, null);
  }

  async composeFileVariableSet(): Promise<boolean> {
    try {
      const text = await fs.readFile(path.join(this.options.projectDir, ".env"), "utf8");
      const value = envValueOf(text, "COMPOSE_FILE");
      return value !== null && value.trim() !== "";
    } catch {
      return false;
    }
  }

  async overrideFile(): Promise<string> {
    for (const name of OVERRIDE_FILE_CANDIDATES) {
      try {
        const stat = await fs.stat(path.join(this.options.projectDir, name));
        if (stat.isFile()) {
          return name;
        }
      } catch {
        // Try the next one.
      }
    }
    return DEFAULT_OVERRIDE_FILE;
  }

  async readOverride(): Promise<string | null> {
    const file = path.join(this.options.projectDir, await this.overrideFile());
    try {
      return await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new OpsError("The compose override could not be read.", (error as Error).message);
    }
  }

  async writeOverride(text: string | null): Promise<void> {
    const file = path.join(this.options.projectDir, await this.overrideFile());
    try {
      if (text === null) {
        await fs.rm(file, { force: true });
        return;
      }
      let mode = 0o644;
      try {
        mode = (await fs.stat(file)).mode & 0o777;
      } catch {
        // A new file: readable for whoever runs `docker compose` in the directory.
      }
      await writeAtomic(file, text, mode);
    } catch (error) {
      throw new OpsError(
        "The compose override could not be written.",
        this.options.redactor.oneLine((error as Error).message, 500),
      );
    }
  }

  async validateConfig(): Promise<void> {
    const result = await this.compose(["config", "-q"], MINUTE);
    this.expectSuccess(result, "Checking the compose configuration");
  }

  async composeUp(services: readonly string[]): Promise<void> {
    if (services.length === 0 || services.some((service) => !SERVICE_NAME.test(service))) {
      throw new OpsError("A service name is not valid.");
    }
    const result = await this.compose(
      ["up", "-d", "--no-deps", "--no-build", "--pull", "never", ...services],
      15 * MINUTE,
    );
    this.expectSuccess(result, "Recreating the services");
  }

  async servicesState(): Promise<ServiceState[]> {
    const result = await this.compose(["ps", "-a", "--format", "json"], 30_000);
    this.expectSuccess(result, "Reading the service states");
    return parseComposePs(result.stdout);
  }

  async managedVolumes(): Promise<ManagedVolume[]> {
    const volumes = await this.options.engine.listVolumes([
      `${COMPOSE_PROJECT_LABEL}=${this.options.projectName}`,
      MANAGED_VOLUME_LABEL,
    ]);
    return volumes
      .map((volume) => ({ name: volume.Name, key: volume.Labels?.[COMPOSE_VOLUME_LABEL] ?? "" }))
      .filter((volume) => volume.key !== "");
  }

  async removeVolume(name: string): Promise<void> {
    await this.options.engine.removeVolume(name);
  }

  /** Remove probe containers and volumes a crashed mounter left behind. */
  async removeStaleProbes(): Promise<void> {
    const { engine, logger } = this.options;
    try {
      for (const id of await engine.listContainersByLabel(`${PROBE_LABEL}=1`)) {
        await engine.removeContainer(id);
      }
      for (const volume of await engine.listVolumes([`${PROBE_LABEL}=1`])) {
        await engine.removeVolume(volume.Name);
      }
    } catch (error) {
      logger.warn(
        `Could not remove stale probe containers or volumes: ${(error as Error).message}`,
      );
    }
  }

  async probe(spec: MountSpec, timeoutMs: number): Promise<ProbeOutcome> {
    const { engine, redactor, logger, probeImage } = this.options;
    const suffix = randomBytes(8).toString("hex");
    const volumeName = `restow-mounter-probe-${suffix}`;
    const file = `.restow-probe-${suffix}`;
    if (!PROBE_FILE.test(file)) {
      return { ok: false, code: "probe.failed", detail: "Invalid probe file name.", wrote: false };
    }
    const fail = (code: MountFailureCode, detail: string): ProbeOutcome => ({
      ok: false,
      code,
      detail: redactor.oneLine(detail, 500),
      wrote: false,
    });

    let containerId: string | null = null;
    let volumeCreated = false;
    try {
      if (!(await engine.imageExists(probeImage))) {
        logger.info(`Pulling ${probeImage} for the share test.`);
        await engine.pullImage(probeImage);
      }
      await engine.createVolume({
        Name: volumeName,
        Driver: "local",
        DriverOpts: { type: "nfs", o: nfsMountOptions(spec, "probe"), device: nfsDevice(spec) },
        Labels: { [PROBE_LABEL]: "1" },
      });
      volumeCreated = true;
      containerId = await engine.createContainer(
        {
          Image: probeImage,
          Entrypoint: [],
          Cmd: spec.readOnly
            ? ["sh", "-c", PROBE_LIST_SCRIPT]
            : ["sh", "-c", PROBE_WRITE_SCRIPT, "sh", file],
          Labels: { [PROBE_LABEL]: "1" },
          NetworkDisabled: true,
          HostConfig: {
            Binds: [`${volumeName}:/probe${spec.readOnly ? ":ro" : ""}`],
            NetworkMode: "none",
            AutoRemove: false,
            Privileged: false,
            SecurityOpt: ["no-new-privileges:true"],
          },
        },
        `restow-mounter-probe-${suffix}`,
      );
      // Docker mounts the share when the container starts: an unreachable server, a
      // refused export or a wrong NFS version fail here.
      try {
        await engine.startContainer(containerId);
      } catch (error) {
        const message = (error as Error).message;
        if (/timed out/i.test(message)) {
          return fail("probe.timeout", message);
        }
        return fail("probe.mount_failed", message);
      }
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        void engine.killContainer(containerId as string).catch(() => undefined);
      }, timeoutMs);
      let exitCode: number;
      try {
        exitCode = await engine.waitContainer(containerId, controller.signal);
      } catch (error) {
        if (!timedOut) {
          throw error;
        }
        exitCode = 124;
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) {
        return fail("probe.timeout", "The share did not answer in time.");
      }
      if (exitCode !== 0) {
        const logs = await engine
          .containerLogs(containerId, { maxStdoutBytes: 4096, stderrTailBytes: 2048 })
          .catch(() => ({ stdout: "", stderr: "", stdoutTruncated: false }));
        const detail = (logs.stderr.trim() || logs.stdout.trim() || `exit code ${exitCode}`).trim();
        return fail(spec.readOnly ? "probe.failed" : "probe.not_writable", detail);
      }
      return { ok: true, code: null, detail: null, wrote: !spec.readOnly };
    } catch (error) {
      const message = error instanceof EngineApiError ? error.message : (error as Error).message;
      if (/timed out/i.test(message)) {
        return fail("probe.timeout", message);
      }
      return fail("probe.failed", message);
    } finally {
      if (containerId) {
        await engine.removeContainer(containerId).catch((error: Error) => {
          logger.warn(`Could not remove the probe container: ${error.message}`);
        });
      }
      if (volumeCreated) {
        await engine.removeVolume(volumeName).catch((error: Error) => {
          logger.warn(`Could not remove the probe volume ${volumeName}: ${error.message}`);
        });
      }
    }
  }

  // -- Plumbing -------------------------------------------------------------

  private compose(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    return this.options.runner.run({
      argv: ["docker", "compose", "-p", this.options.projectName, ...args],
      timeoutMs,
      maxOutputBytes: 4 * 1024 * 1024,
    });
  }

  private expectSuccess(result: CommandResult, action: string): void {
    if (result.exitCode === 0) {
      return;
    }
    throw new OpsError(
      result.timedOut ? `${action} timed out.` : `${action} failed (exit code ${result.exitCode}).`,
      result.errorTail,
    );
  }
}
