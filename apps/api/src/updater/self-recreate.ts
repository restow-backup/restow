import { randomBytes } from "node:crypto";
import type { CreateContainerBody, EngineClient } from "./engine-api.js";
import type { Logger } from "./logger.js";
import type { Redactor } from "./redact.js";
import type { SelfRecreateHandle, SelfRecreateLauncher } from "./self-update.js";

/**
 * The helper container that recreates the updater (self-update.ts). A process cannot
 * replace its own container: `docker compose up` stops the container it runs in, and
 * with it the command. So the command runs in a container of its own, created through
 * the Engine API, that outlives the old updater:
 *
 *   docker compose -p <project> [-f <file>] --profile updater \
 *     up -d --no-deps --no-build --pull missing updater
 *
 * It is built like the helpers of runner-helper.ts (the pinned Docker CLI image, the
 * socket and the project directory bound at the host path, no network of its own, no
 * new privileges), but carries a label of its own: the new updater removes the
 * leftovers of runner-helper.ts when it starts, and must not remove this one while it
 * is still finishing. `--pull missing` pulls nothing in practice (the update pulled and
 * verified the image); the reference names a digest, so whatever it pulls is that content.
 */

export const SELF_RECREATE_LABEL = "com.restow.updater.self-update";

/**
 * The same helper recreates the mounter when it follows the updater to a verified
 * release image (self-update.ts): `--profile mounts up -d ... mounter`, under a label of
 * its own. The updater waits for that helper and removes it itself.
 */
export const MOUNTER_RECREATE_LABEL = "com.restow.updater.mounter-update";

/** Which service a helper recreates. */
export interface RecreateTarget {
  service: "updater" | "mounter";
  profile: "updater" | "mounts";
  label: string;
  namePrefix: string;
}

export const UPDATER_RECREATE_TARGET: RecreateTarget = {
  service: "updater",
  profile: "updater",
  label: SELF_RECREATE_LABEL,
  namePrefix: "restow-updater-selfupdate",
};

export const MOUNTER_RECREATE_TARGET: RecreateTarget = {
  service: "mounter",
  profile: "mounts",
  label: MOUNTER_RECREATE_LABEL,
  namePrefix: "restow-updater-mounterupdate",
};

/** The command the helper runs. Every value is checked by the caller (config.ts, main.ts). */
export function selfRecreateCommand(
  projectName: string,
  composeFile: string | null,
  target: RecreateTarget = UPDATER_RECREATE_TARGET,
): string[] {
  return [
    "docker",
    "compose",
    "-p",
    projectName,
    ...(composeFile ? ["-f", composeFile] : []),
    "--profile",
    target.profile,
    "up",
    "-d",
    "--no-deps",
    "--no-build",
    "--pull",
    "missing",
    target.service,
  ];
}

export interface EngineSelfRecreateOptions {
  engine: EngineClient;
  redactor: Redactor;
  logger: Logger;
  /** The Docker CLI image, pinned by digest. */
  cliImage: string;
  /** Absolute host path of the compose project (bound at the same path). */
  hostProjectDir: string;
  dockerSocket: string;
  projectName: string;
  composeFile: string | null;
  /** The service the helper recreates (default: the updater itself). */
  target?: RecreateTarget;
}

export class EngineSelfRecreateLauncher implements SelfRecreateLauncher {
  constructor(private readonly options: EngineSelfRecreateOptions) {}

  private get target(): RecreateTarget {
    return this.options.target ?? UPDATER_RECREATE_TARGET;
  }

  /** The container the helper is created as (exported for tests). */
  body(): CreateContainerBody {
    const { cliImage, hostProjectDir, dockerSocket, projectName, composeFile } = this.options;
    return {
      Image: cliImage,
      Entrypoint: [],
      Cmd: selfRecreateCommand(projectName, composeFile, this.target),
      WorkingDir: hostProjectDir,
      Env: ["HOME=/tmp", "NO_COLOR=1", "COMPOSE_ANSI=never", "COMPOSE_PROGRESS=plain"],
      Labels: { [this.target.label]: "1" },
      NetworkDisabled: true,
      HostConfig: {
        Binds: [`${dockerSocket}:/var/run/docker.sock`, `${hostProjectDir}:${hostProjectDir}`],
        NetworkMode: "none",
        AutoRemove: false,
        Privileged: false,
        SecurityOpt: ["no-new-privileges:true"],
      },
    };
  }

  async launch(): Promise<SelfRecreateHandle> {
    const { engine, redactor, logger, cliImage } = this.options;
    if (!(await engine.imageExists(cliImage))) {
      await engine.pullImage(cliImage);
    }
    const id = await engine.createContainer(
      this.body(),
      `${this.target.namePrefix}-${randomBytes(6).toString("hex")}`,
    );
    try {
      await engine.startContainer(id);
    } catch (error) {
      await engine.removeContainer(id).catch(() => undefined);
      throw error;
    }
    return {
      wait: async (timeoutMs) => {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        timer.unref?.();
        let exitCode: number | null;
        try {
          exitCode = await engine.waitContainer(id, controller.signal);
        } catch (error) {
          if (!timedOut) {
            throw error;
          }
          exitCode = null;
        } finally {
          clearTimeout(timer);
        }
        let output = "";
        try {
          const logs = await engine.containerLogs(id, {
            maxStdoutBytes: 64 * 1024,
            stderrTailBytes: 16 * 1024,
          });
          output = redactor.tail(logs.stderr.trim() ? logs.stderr : logs.stdout, 800);
        } catch {
          output = "";
        }
        if (exitCode !== null) {
          await engine.removeContainer(id).catch((error: Error) => {
            logger.warn(`Could not remove the self-update helper: ${error.message}`);
          });
        }
        return { exitCode, output };
      },
    };
  }

  /** Remove helpers of an earlier self-update that have finished (the new updater calls this). */
  async removeFinished(): Promise<number> {
    const { engine, logger } = this.options;
    let removed = 0;
    try {
      for (const id of await engine.listContainersByLabel(`${this.target.label}=1`)) {
        const info = await engine.inspectContainer(id);
        if (info && info.State?.Running !== true) {
          await engine.removeContainer(id);
          removed += 1;
        }
      }
    } catch (error) {
      logger.warn(`Could not remove finished self-update helpers: ${(error as Error).message}`);
    }
    return removed;
  }
}
