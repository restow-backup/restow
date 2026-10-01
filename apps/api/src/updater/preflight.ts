import type { DumpStore } from "./dumps.js";
import type { EnvFile } from "./env-file.js";
import { EnvFileError } from "./env-file.js";
import type { Clock, DockerOps } from "./ops.js";
import type { Blocker, Capabilities } from "./protocol.js";
import type { Redactor } from "./redact.js";

/**
 * Can an update start right now? The answer is what the api shows in the Updates
 * tab (`capabilities`) and what `POST /v1/schedule` and the run's first step check.
 * The result is cached for 30 seconds; `refresh` recomputes.
 *
 * One check reads the Compose configuration and is therefore made only when it
 * matters (the first check after the updater started, `refresh`, and a run's
 * first step), and remembered in between: whether the `updater` service takes
 * its own image from RESTOW_IMAGE or RESTOW_WEB_IMAGE. The updater rewrites those
 * two lines, so an updater image that follows them would be replaced by whatever
 * the updater installed the next time the profile is brought up; it must be
 * pinned on its own (RESTOW_UPDATER_IMAGE). Fixing it means recreating the
 * updater, which starts a new process and so a new check.
 */

export const PREFLIGHT_TTL_MS = 30_000;

/** Stand-ins for the two variables the updater writes, to see whether its own image follows them. */
const PROBE_MARKER = "restow-updater-probe.invalid";
export const UPDATER_IMAGE_PROBE = {
  RESTOW_IMAGE: `${PROBE_MARKER}/app:probe`,
  RESTOW_WEB_IMAGE: `${PROBE_MARKER}/web:probe`,
} as const;

/** The `updater` service resolves to a probe value: its image follows a variable the updater rewrites. */
export function updaterImageFollowsProbe(image: string | null): boolean {
  return image?.includes(PROBE_MARKER) ?? false;
}

export interface PreflightOptions {
  ops: DockerOps;
  envFile: EnvFile;
  dumps: DumpStore;
  clock: Clock;
  redactor: Redactor;
  projectDir: string;
  stateDir: string;
  minFreeMb: number;
  imageRepository: string;
  webImageRepository: string;
  /** What `source` mode may build from, as written in RESTOW_UPDATER_SOURCE_HOSTS (empty: off). */
  sourceAllowlist?: readonly string[];
}

export interface CheckOptions {
  /** Also read the Compose configuration again (see the comment at the top). */
  deep?: boolean;
}

export class Preflight {
  private cached: { at: number; value: Capabilities } | null = null;
  /** Whether the updater's own image follows RESTOW_IMAGE / RESTOW_WEB_IMAGE; null until known. */
  private updaterImage: { follows: boolean } | null = null;

  constructor(private readonly options: PreflightOptions) {}

  /** Forget the cached result (a run started or finished, so the picture changed). */
  invalidate(): void {
    this.cached = null;
  }

  async get(refresh = false): Promise<Capabilities> {
    const now = this.options.clock.now().getTime();
    if (!refresh && this.cached && now - this.cached.at < PREFLIGHT_TTL_MS) {
      return this.cached.value;
    }
    const value = await this.check({ deep: refresh });
    this.cached = { at: this.options.clock.now().getTime(), value };
    return value;
  }

  /** Compute the capabilities now. */
  async check(options: CheckOptions = {}): Promise<Capabilities> {
    const { ops, envFile, dumps, clock, redactor, projectDir, stateDir, minFreeMb } = this.options;
    const blockers: Blocker[] = [];
    const add = (code: Blocker["code"], detail: string | null = null): void => {
      blockers.push({ code, detail: detail ? redactor.oneLine(detail, 500) : null });
    };

    let dockerUp = true;
    try {
      await ops.ping();
    } catch (error) {
      dockerUp = false;
      add("docker_unreachable", messageOf(error));
    }

    let composeFile: string | null = null;
    try {
      composeFile = await ops.composeFilePresent();
    } catch {
      composeFile = null;
    }
    if (!composeFile) {
      add("compose_missing", `No compose file in ${projectDir}`);
    }

    try {
      await envFile.assertWritable();
    } catch (error) {
      add("env_unwritable", error instanceof EnvFileError ? error.message : messageOf(error));
    }

    if (dockerUp) {
      try {
        const self = await ops.inspectSelf();
        if (self?.workingDir && self.workingDir !== projectDir) {
          add(
            "project_dir_mismatch",
            `The compose project runs from ${self.workingDir}, the updater is configured for ${projectDir}`,
          );
        }
      } catch {
        // Not being able to inspect the container is not a reason to block.
      }
    }

    try {
      const free = await ops.freeBytes(stateDir);
      if (free < minFreeMb * 1024 * 1024) {
        add("disk_space", `${Math.floor(free / (1024 * 1024))} MB free, ${minFreeMb} MB required`);
      }
    } catch (error) {
      add("disk_space", `Free space could not be determined: ${messageOf(error)}`);
    }

    let runnerReady = false;
    if (dockerUp) {
      const readiness = await ops.readiness().catch((error: unknown) => ({
        ready: false,
        detail: messageOf(error),
      }));
      runnerReady = readiness.ready;
      if (!readiness.ready) {
        add("docker_cli_missing", readiness.detail);
      }
    }

    if (runnerReady && composeFile && (options.deep || this.updaterImage === null)) {
      try {
        const image = await ops.configUpdaterImage(UPDATER_IMAGE_PROBE);
        this.updaterImage = { follows: updaterImageFollowsProbe(image) };
      } catch {
        // Unknown for now: asked again by the next check, and a run's first step needs the answer.
        this.updaterImage = null;
      }
    }
    if (this.updaterImage?.follows) {
      add(
        "updater_image_unpinned",
        "The updater service takes its image from RESTOW_IMAGE or RESTOW_WEB_IMAGE. Set RESTOW_UPDATER_IMAGE in .env, use the docker-compose.yml of this release and recreate the updater.",
      );
    }

    let dumpList: Capabilities["dumps"] = [];
    try {
      dumpList = await dumps.list();
    } catch {
      dumpList = [];
    }

    return {
      ready: blockers.length === 0,
      blockers,
      runner: ops.runnerKind,
      composeFile,
      imageRepository: this.options.imageRepository,
      webImageRepository: this.options.webImageRepository,
      dumps: dumpList,
      sourceAllowlist: [...(this.options.sourceAllowlist ?? [])],
      checkedAt: clock.now().toISOString(),
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
