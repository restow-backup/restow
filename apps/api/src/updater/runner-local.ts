import { spawn } from "node:child_process";
import { accessSync, closeSync, constants as fsConstants, openSync } from "node:fs";
import * as path from "node:path";
import type { CommandResult, CommandRunner, CommandSpec, RunnerReadiness } from "./ops.js";
import type { Redactor } from "./redact.js";

/**
 * CommandRunner over the `docker` binary found in PATH: local development, and any
 * image that ships the Docker CLI. Commands are argument vectors handed straight to
 * the operating system (no shell), the environment is filtered down to what Docker
 * needs, output is capped and every tail that leaves this file is redacted.
 */

/** Variables passed through from the updater's own environment; everything else is dropped. */
const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
] as const;

/** Fixed variables that keep output plain and stable. */
const FIXED_ENV: Readonly<Record<string, string>> = {
  NO_COLOR: "1",
  COMPOSE_ANSI: "never",
  COMPOSE_PROGRESS: "plain",
  BUILDKIT_PROGRESS: "plain",
};

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;
const TAIL_BYTES = 16 * 1024;
const KILL_GRACE_MS = 5000;
const EXIT_GRACE_MS = 1000;
const READINESS_TTL_MS = 60_000;

export interface LocalRunnerOptions {
  redactor: Redactor;
  /** Working directory of every command: the project directory, where Compose finds its files. */
  cwd: string;
  /** The docker executable; default `docker`, looked up in PATH. */
  dockerBinary?: string;
  /** The environment to filter (default: this process's). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Locate an executable the way a shell would; null when it is not on PATH. */
export function findExecutable(name: string, pathEnv: string | undefined): string | null {
  if (name.includes("/")) {
    return isExecutable(name) ? name : null;
  }
  for (const directory of (pathEnv ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size - (this.chunks[0]?.length ?? 0) >= TAIL_BYTES) {
      const dropped = this.chunks.shift();
      this.size -= dropped?.length ?? 0;
    }
  }

  toString(): string {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - TAIL_BYTES)).toString("utf8");
  }
}

export class LocalRunner implements CommandRunner {
  readonly kind = "cli" as const;
  private readiness_: { at: number; value: RunnerReadiness } | null = null;
  private readonly binary: string | null;
  private readonly baseEnv: Record<string, string>;

  constructor(private readonly options: LocalRunnerOptions) {
    const source = options.env ?? process.env;
    this.binary = findExecutable(options.dockerBinary ?? "docker", source.PATH);
    const base: Record<string, string> = {};
    for (const name of PASSTHROUGH_ENV) {
      const value = source[name];
      if (value !== undefined) {
        base[name] = value;
      }
    }
    if (!base.HOME) {
      base.HOME = "/root";
    }
    this.baseEnv = { ...base, ...FIXED_ENV };
  }

  /** Whether a docker executable exists at all. */
  get available(): boolean {
    return this.binary !== null;
  }

  async ping(): Promise<void> {
    const result = await this.run({
      argv: ["docker", "version", "--format", "{{.Server.Version}}"],
      timeoutMs: 20_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.errorTail || "docker did not answer");
    }
  }

  async readiness(): Promise<RunnerReadiness> {
    const now = Date.now();
    if (this.readiness_ && now - this.readiness_.at < READINESS_TTL_MS) {
      return this.readiness_.value;
    }
    let value: RunnerReadiness;
    if (!this.binary) {
      value = { ready: false, detail: "The docker executable was not found in PATH." };
    } else {
      const result = await this.run({
        argv: ["docker", "compose", "version", "--short"],
        timeoutMs: 20_000,
      });
      value =
        result.exitCode === 0
          ? { ready: true, detail: null }
          : { ready: false, detail: "The docker compose plugin is not available." };
    }
    this.readiness_ = { at: now, value };
    return value;
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    const { redactor } = this.options;
    if (!this.binary) {
      return {
        exitCode: 127,
        stdout: "",
        errorTail: "The docker executable was not found in PATH.",
        timedOut: false,
        truncated: false,
      };
    }
    const [program, ...args] = spec.argv;
    if (program !== "docker") {
      throw new Error("Only docker commands can be run.");
    }
    for (const file of [spec.stdoutFile, spec.stdinFile]) {
      if (file !== undefined && (!path.isAbsolute(file) || file.includes("\0"))) {
        throw new Error("Command files must be absolute paths.");
      }
    }

    const maxOutput = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    let outFd: number | null = null;
    let inFd: number | null = null;
    try {
      outFd = spec.stdoutFile ? openSync(spec.stdoutFile, "w", 0o600) : null;
      inFd = spec.stdinFile ? openSync(spec.stdinFile, "r") : null;
    } catch (error) {
      if (outFd !== null) {
        closeSync(outFd);
      }
      return {
        exitCode: 126,
        stdout: "",
        errorTail: redactor.tail(`Could not open a command file: ${(error as Error).message}`),
        timedOut: false,
        truncated: false,
      };
    }

    return await new Promise<CommandResult>((resolve) => {
      const child = spawn(this.binary as string, args, {
        cwd: this.options.cwd,
        env: { ...this.baseEnv, ...(spec.env ?? {}) },
        stdio: [inFd ?? "ignore", outFd ?? "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let truncated = false;
      const stdoutTail = new TailBuffer();
      const stderrTail = new TailBuffer();
      let timedOut = false;
      let settled = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutTail.push(chunk);
        const room = maxOutput - stdoutBytes;
        if (room <= 0) {
          truncated = true;
          return;
        }
        if (chunk.length > room) {
          truncated = true;
          stdoutChunks.push(chunk.subarray(0, room));
          stdoutBytes += room;
        } else {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => stderrTail.push(chunk));

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
      }, spec.timeoutMs);

      const finish = (exitCode: number, extra = ""): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(killTimer);
        if (outFd !== null) {
          closeSync(outFd);
        }
        if (inFd !== null) {
          closeSync(inFd);
        }
        const stderrText = stderrTail.toString();
        const tailSource = stderrText.trim() ? stderrText : stdoutTail.toString();
        resolve({
          exitCode,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          errorTail: redactor.tail(extra ? `${extra}\n${tailSource}` : tailSource),
          timedOut,
          truncated,
        });
      };

      child.on("error", (error) => finish(127, error.message));
      child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
      // A grandchild can keep the pipes open after the command itself ended (a killed
      // wrapper script): do not wait for them for ever.
      child.on("exit", (code, signal) => {
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(code ?? (signal ? 128 : 1));
        }, EXIT_GRACE_MS).unref();
      });
    });
  }
}
