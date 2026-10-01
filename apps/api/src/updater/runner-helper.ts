import { randomBytes } from "node:crypto";
import type { CreateContainerBody, EngineClient } from "./engine-api.js";
import type { Logger } from "./logger.js";
import type { CommandResult, CommandRunner, CommandSpec, RunnerReadiness } from "./ops.js";
import type { Redactor } from "./redact.js";

/**
 * CommandRunner for an updater whose own image has no `docker` binary (the normal
 * case in the published image). Each command runs in a short-lived helper
 * container of the Docker CLI image (`docker:27-cli` ships docker, compose and
 * buildx), created through the Engine API on the mounted socket:
 *
 *   - the socket is bound into it, so the CLI talks to the same daemon;
 *   - the project directory is bound at the same path, so Compose resolves every
 *     relative path the way the host would;
 *   - the volume that backs the updater's state directory is bound at the same
 *     path, so a dump written by `pg_dump > file` lands where the updater reads it
 *     and a fetched source tree can be the build context.
 *
 * Nothing but constant strings ever forms a shell script: a command that needs
 * output redirection runs as `sh -c '<constant>' sh <files> <argv...>`, so the
 * file names and every argument arrive as positional parameters, never as script.
 */

/** Label every helper container carries, so leftovers of a crash can be found and removed. */
export const HELPER_LABEL = "com.restow.updater.helper";

const SCRIPT_STDOUT = 'umask 077; out="$1"; shift; exec "$@" > "$out"';
const SCRIPT_STDIN = 'in="$1"; shift; exec "$@" < "$in"';
const SCRIPT_BOTH = 'umask 077; in="$1"; out="$2"; shift 2; exec "$@" < "$in" > "$out"';

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;
const RETRY_AFTER_MS = 30_000;

/** The shell script (a constant) and the leading positional parameters for a command's redirections. */
export function wrapCommand(
  spec: Pick<CommandSpec, "argv" | "stdoutFile" | "stdinFile">,
): string[] {
  const argv = [...spec.argv];
  if (spec.stdoutFile && spec.stdinFile) {
    return ["sh", "-c", SCRIPT_BOTH, "sh", spec.stdinFile, spec.stdoutFile, ...argv];
  }
  if (spec.stdoutFile) {
    return ["sh", "-c", SCRIPT_STDOUT, "sh", spec.stdoutFile, ...argv];
  }
  if (spec.stdinFile) {
    return ["sh", "-c", SCRIPT_STDIN, "sh", spec.stdinFile, ...argv];
  }
  return argv;
}

export interface HelperRunnerOptions {
  engine: EngineClient;
  redactor: Redactor;
  logger: Logger;
  /** The Docker CLI image, for example `docker:27-cli`. */
  cliImage: string;
  /** Absolute host path of the compose project, identical inside the updater container. */
  projectDir: string;
  /** Where the state volume is mounted in the updater (and in the helper). */
  stateDir: string;
  /** Path of the Docker socket on the host, bound into the helper. */
  dockerSocket: string;
  /** Id or name of the updater's own container (the container's hostname). */
  selfId: string;
}

type Preparation =
  | { state: "idle" }
  | { state: "preparing"; promise: Promise<void> }
  | { state: "ready" }
  | { state: "failed"; detail: string; at: number };

export class HelperRunner implements CommandRunner {
  readonly kind = "helper" as const;
  private preparation: Preparation = { state: "idle" };
  private stateBind: string | null = null;

  constructor(private readonly options: HelperRunnerOptions) {}

  async ping(): Promise<void> {
    await this.options.engine.ping();
  }

  /** Remove helper containers a crashed updater left behind. */
  async removeStaleHelpers(): Promise<number> {
    const { engine, logger } = this.options;
    let removed = 0;
    try {
      for (const id of await engine.listContainersByLabel(`${HELPER_LABEL}=1`)) {
        await engine.removeContainer(id);
        removed += 1;
      }
    } catch (error) {
      logger.warn(`Could not remove stale helper containers: ${(error as Error).message}`);
    }
    return removed;
  }

  /** Start (or join) the one-time preparation: find the state volume, make sure the CLI image exists. */
  prepare(): Promise<void> {
    if (this.preparation.state === "ready") {
      return Promise.resolve();
    }
    if (this.preparation.state === "preparing") {
      return this.preparation.promise;
    }
    const promise = this.doPrepare().then(
      () => {
        this.preparation = { state: "ready" };
      },
      (error: Error) => {
        const detail = this.options.redactor.oneLine(error.message, 400);
        this.options.logger.warn(`Helper runner is not ready: ${detail}`);
        this.preparation = { state: "failed", detail, at: Date.now() };
        throw error;
      },
    );
    // Callers that only poll readiness must not create an unhandled rejection.
    promise.catch(() => undefined);
    this.preparation = { state: "preparing", promise };
    return promise;
  }

  private async doPrepare(): Promise<void> {
    const options = this.options;
    const engine = options.engine;
    const self = await engine.inspectContainer(options.selfId);
    if (!self) {
      throw new Error("The updater's own container could not be found through the Docker socket.");
    }
    const mount = (self.Mounts ?? []).find((entry) => entry.Destination === options.stateDir);
    if (!mount) {
      throw new Error(
        `No volume or directory is mounted at ${options.stateDir} in the updater container.`,
      );
    }
    const source = mount.Type === "volume" ? mount.Name : mount.Source;
    if (!source) {
      throw new Error("The state mount has no source.");
    }
    this.stateBind = `${source}:${options.stateDir}`;
    if (!(await engine.imageExists(options.cliImage))) {
      options.logger.info(
        `Pulling the Docker CLI image ${options.cliImage} for the helper runner.`,
      );
      await engine.pullImage(options.cliImage);
    }
  }

  async readiness(): Promise<RunnerReadiness> {
    const current = this.preparation;
    switch (current.state) {
      case "ready":
        return { ready: true, detail: null };
      case "preparing":
        return { ready: false, detail: `Preparing the Docker CLI image ${this.options.cliImage}.` };
      case "failed":
        if (Date.now() - current.at >= RETRY_AFTER_MS) {
          void this.prepare().catch(() => undefined);
        }
        return { ready: false, detail: current.detail };
      default:
        void this.prepare().catch(() => undefined);
        return { ready: false, detail: `Preparing the Docker CLI image ${this.options.cliImage}.` };
    }
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    const { engine, redactor, logger, projectDir, dockerSocket, cliImage, stateDir } = this.options;
    if (spec.argv[0] !== "docker") {
      throw new Error("Only docker commands can be run.");
    }
    for (const file of [spec.stdoutFile, spec.stdinFile]) {
      if (file !== undefined && (!file.startsWith(`${stateDir}/`) || file.includes("\0"))) {
        throw new Error("Command files must live inside the state directory.");
      }
    }
    try {
      await this.prepare();
    } catch (error) {
      return failed(redactor, `The helper runner is not ready: ${(error as Error).message}`);
    }

    const env = [
      "HOME=/tmp",
      "NO_COLOR=1",
      "COMPOSE_ANSI=never",
      "COMPOSE_PROGRESS=plain",
      "BUILDKIT_PROGRESS=plain",
      ...Object.entries(spec.env ?? {}).map(([key, value]) => `${key}=${value}`),
    ];
    const body: CreateContainerBody = {
      Image: cliImage,
      Entrypoint: [],
      Cmd: wrapCommand(spec),
      WorkingDir: projectDir,
      Env: env,
      Labels: { [HELPER_LABEL]: "1" },
      NetworkDisabled: true,
      HostConfig: {
        Binds: [
          `${dockerSocket}:/var/run/docker.sock`,
          `${projectDir}:${projectDir}`,
          this.stateBind as string,
        ],
        NetworkMode: "none",
        AutoRemove: false,
        Privileged: false,
        SecurityOpt: ["no-new-privileges:true"],
      },
    };

    let id: string | null = null;
    try {
      id = await engine.createContainer(
        body,
        `restow-updater-helper-${randomBytes(6).toString("hex")}`,
      );
      await engine.startContainer(id);
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        void engine.killContainer(id as string).catch(() => undefined);
      }, spec.timeoutMs);
      let exitCode: number;
      try {
        exitCode = await engine.waitContainer(id, controller.signal);
      } catch (error) {
        if (!timedOut) {
          throw error;
        }
        exitCode = 124;
      } finally {
        clearTimeout(timer);
      }
      const logs = await engine.containerLogs(id, {
        maxStdoutBytes: spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
        stderrTailBytes: STDERR_TAIL_BYTES,
      });
      const tailSource = logs.stderr.trim() ? logs.stderr : logs.stdout.slice(-STDERR_TAIL_BYTES);
      return {
        exitCode,
        stdout: logs.stdout,
        errorTail: redactor.tail(tailSource),
        timedOut,
        truncated: logs.stdoutTruncated,
      };
    } catch (error) {
      return failed(redactor, `The helper container failed: ${(error as Error).message}`);
    } finally {
      if (id) {
        await engine.removeContainer(id).catch((error: Error) => {
          logger.warn(`Could not remove a helper container: ${error.message}`);
        });
      }
    }
  }
}

function failed(redactor: Redactor, message: string): CommandResult {
  return {
    exitCode: 125,
    stdout: "",
    errorTail: redactor.tail(message),
    timedOut: false,
    truncated: false,
  };
}
