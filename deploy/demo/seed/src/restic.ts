import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Real restic for the demo's simulated machines, driven the way the Restow
 * agent drives it (agent/internal/restic): the repository credentials travel
 * in environment variables, never on a command line; restic runs with a clean
 * environment (no database address, no master key of the seed); output is read
 * as restic's JSON lines; a backup that ends with exit code 3 still produced a
 * snapshot (some files could not be read). The only difference to the agent is
 * `--time`: the demo plays back a month of nightly backups at once, so each
 * snapshot is stamped with the moment it stands for.
 */

/** restic's exit code for "snapshot created, some files unreadable". */
export const EXIT_INCOMPLETE = 3;

export interface ResticOptions {
  /** Path of the restic executable (pinned and checksum-verified in the seed image). */
  bin: string;
  repository: string;
  password: string;
  /** HTTP Basic credentials of the REST backend: `endpointId:agentSecret`. */
  restUser: string;
  restPass: string;
  cacheDir: string;
  /** Private folder for restic's option files; also TMPDIR of the process. */
  tmpDir: string;
  /** Receives restic's stderr lines and unparseable stdout lines. */
  log?: (line: string) => void;
}

export class ResticFailure extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    message: string,
  ) {
    super(`restic ${command} failed (exit code ${exitCode}): ${message}`);
    this.name = "ResticFailure";
  }
}

/** The environment of a restic process: what it needs and nothing else. */
export function resticEnv(
  options: ResticOptions,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    PATH: base.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: options.tmpDir,
    TMPDIR: options.tmpDir,
    // `--time` is read in the local zone of the process.
    TZ: "UTC",
    RESTIC_REPOSITORY: options.repository,
    RESTIC_PASSWORD: options.password,
    RESTIC_REST_USERNAME: options.restUser,
    RESTIC_REST_PASSWORD: options.restPass,
    RESTIC_CACHE_DIR: options.cacheDir,
    // One status message every five seconds instead of ten per second.
    RESTIC_PROGRESS_FPS: "0.2",
  };
}

/** restic's `--time` format; the process runs with TZ=UTC. */
export function formatResticTime(time: Date): string {
  return time.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * One line of an exclude file (agent/internal/restic/pattern.go): restic
 * expands environment variables in it, so `$` is written as `$$`. Empty
 * patterns, comments and multi-line values cannot be represented.
 */
export function excludeFileLine(pattern: string): string | null {
  const trimmed = pattern.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (trimmed === "" || trimmed.startsWith("#") || /[\n\r\u0000]/.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/\$/g, "$$$$");
}

/** A snapshot path as a `--include` pattern that matches exactly that path. */
export function escapeIncludePath(path: string): string {
  return path.replace(/[*?[\\]/g, (char) => `\\${char}`);
}

export interface BackupArgsInput {
  filesFrom: string;
  excludeFile?: string;
  host: string;
  tags: readonly string[];
  time: Date;
}

/** The command line of `restic backup`, as the agent builds it plus `--time`. */
export function backupArgs(input: BackupArgsInput): string[] {
  const args = [
    "backup",
    "--json",
    "--files-from-raw",
    input.filesFrom,
    "--exclude-caches",
    "--retry-lock",
    "15m",
    "--host",
    input.host,
  ];
  for (const tag of input.tags) {
    args.push("--tag", tag);
  }
  args.push("--time", formatResticTime(input.time));
  if (input.excludeFile) {
    args.push("--exclude-file", input.excludeFile);
  }
  return args;
}

export interface BackupSummary {
  filesNew: number;
  filesChanged: number;
  filesUnmodified: number;
  dataAdded: number;
  totalFilesProcessed: number;
  totalBytesProcessed: number;
  snapshotId: string;
}

export interface ItemError {
  path: string;
  message: string;
  during: string;
}

export interface BackupResult {
  snapshotId: string;
  summary: BackupSummary;
  errors: ItemError[];
  partial: boolean;
}

export interface ResticNode {
  name: string;
  type: string;
  path: string;
  size: number;
  mtime: Date | null;
}

/** Parse one JSON line of restic's output; null for anything that is not a JSON object. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (value: unknown): number => (typeof value === "number" ? value : 0);

export function summaryOf(message: Record<string, unknown>): BackupSummary {
  return {
    filesNew: num(message.files_new),
    filesChanged: num(message.files_changed),
    filesUnmodified: num(message.files_unmodified),
    dataAdded: num(message.data_added),
    totalFilesProcessed: num(message.total_files_processed),
    totalBytesProcessed: num(message.total_bytes_processed),
    snapshotId: typeof message.snapshot_id === "string" ? message.snapshot_id : "",
  };
}

export function nodeOf(message: Record<string, unknown>): ResticNode | null {
  if (message.message_type !== "node" || typeof message.path !== "string") {
    return null;
  }
  const mtime = typeof message.mtime === "string" ? new Date(message.mtime) : null;
  return {
    name: typeof message.name === "string" ? message.name : "",
    type: typeof message.type === "string" ? message.type : "",
    path: message.path,
    size: num(message.size),
    mtime: mtime && !Number.isNaN(mtime.getTime()) ? mtime : null,
  };
}

interface ExecResult {
  exitCode: number;
  stderr: string[];
  fatal: string;
}

export class Restic {
  constructor(private readonly options: ResticOptions) {}

  private log(line: string): void {
    this.options.log?.(line);
  }

  private exec(args: string[], onStdoutLine?: (line: string) => void): Promise<ExecResult> {
    mkdirSync(this.options.tmpDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.options.cacheDir, { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.bin, args, {
        env: resticEnv(this.options),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const result: ExecResult = { exitCode: -1, stderr: [], fatal: "" };
      const lines = (sink: (line: string) => void) => {
        let carry = "";
        return {
          write: (chunk: Buffer) => {
            carry += chunk.toString("utf8");
            let newline = carry.indexOf("\n");
            while (newline >= 0) {
              sink(carry.slice(0, newline).replace(/\r$/, ""));
              carry = carry.slice(newline + 1);
              newline = carry.indexOf("\n");
            }
          },
          flush: () => {
            if (carry.length > 0) {
              sink(carry);
              carry = "";
            }
          },
        };
      };
      const out = lines((line) => onStdoutLine?.(line));
      const err = lines((line) => {
        const message = parseJsonLine(line);
        if (message?.message_type === "exit_error" && typeof message.message === "string") {
          result.fatal = message.message;
          this.log(message.message);
          return;
        }
        const text = line.trim();
        if (text === "") {
          return;
        }
        result.stderr.push(text.slice(0, 4096));
        if (result.stderr.length > 60) {
          result.stderr.shift();
        }
        this.log(text);
      });
      child.stdout.on("data", (chunk: Buffer) => out.write(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.write(chunk));
      child.on("error", (error) =>
        reject(new Error(`cannot start restic (${this.options.bin}): ${error.message}`)),
      );
      child.on("close", (code, signal) => {
        out.flush();
        err.flush();
        result.exitCode = code ?? (signal ? 128 : -1);
        resolve(result);
      });
    });
  }

  private failure(command: string, result: ExecResult): ResticFailure {
    return new ResticFailure(
      command,
      result.exitCode,
      result.fatal || result.stderr[result.stderr.length - 1] || "no message",
    );
  }

  /** `restic version`, for example "0.19.1". */
  async version(): Promise<string> {
    const out: string[] = [];
    const result = await this.exec(["version"], (line) => out.push(line));
    if (result.exitCode !== 0) {
      throw this.failure("version", result);
    }
    const match = /restic\s+(\d+\.\d+\.\d+\S*)/.exec(out.join("\n"));
    if (!match) {
      throw new Error(`cannot read the restic version from ${JSON.stringify(out.join(" "))}`);
    }
    return match[1] as string;
  }

  /** Proves that the repository exists, the credentials are accepted and the password is right. */
  async checkAccess(): Promise<void> {
    const result = await this.exec(["cat", "config", "--retry-lock", "1m"]);
    if (result.exitCode !== 0) {
      throw this.failure("cat config", result);
    }
  }

  async backup(input: {
    paths: readonly string[];
    excludes: readonly string[];
    host: string;
    tags: readonly string[];
    time: Date;
  }): Promise<BackupResult> {
    if (input.paths.length === 0) {
      throw new Error("backup: no paths to back up");
    }
    mkdirSync(this.options.tmpDir, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(this.options.tmpDir, "backup-"));
    try {
      const filesFrom = join(dir, "paths.raw");
      writeFileSync(filesFrom, `${input.paths.join("\0")}\0`, { mode: 0o600 });
      const excludeLines = input.excludes
        .map(excludeFileLine)
        .filter((line): line is string => line !== null);
      let excludeFile: string | undefined;
      if (excludeLines.length > 0) {
        excludeFile = join(dir, "excludes.txt");
        writeFileSync(excludeFile, `${excludeLines.join("\n")}\n`, { mode: 0o600 });
      }
      let summary: BackupSummary | null = null;
      const errors: ItemError[] = [];
      const result = await this.exec(
        backupArgs({
          filesFrom,
          excludeFile,
          host: input.host,
          tags: input.tags,
          time: input.time,
        }),
        (line) => {
          const message = parseJsonLine(line);
          if (message === null) {
            if (line.trim() !== "") this.log(line.trim());
            return;
          }
          if (message.message_type === "summary") {
            summary = summaryOf(message);
          } else if (message.message_type === "error") {
            const error = message.error as { message?: string } | undefined;
            errors.push({
              path: typeof message.item === "string" ? message.item : "",
              message: error?.message ?? "unknown error",
              during: typeof message.during === "string" ? message.during : "",
            });
          }
        },
      );
      const done = summary as BackupSummary | null;
      if (result.exitCode !== 0 && result.exitCode !== EXIT_INCOMPLETE) {
        throw this.failure("backup", result);
      }
      if (done === null || done.snapshotId === "") {
        throw new Error(
          `restic backup finished (exit code ${result.exitCode}) without reporting a snapshot id`,
        );
      }
      return {
        snapshotId: done.snapshotId,
        summary: done,
        errors,
        partial: result.exitCode === EXIT_INCOMPLETE,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Every node of a snapshot, as `restic ls --json` lists them. */
  async ls(snapshotId: string): Promise<ResticNode[]> {
    const nodes: ResticNode[] = [];
    const result = await this.exec(["ls", "--json", "--retry-lock", "5m", snapshotId], (line) => {
      const message = parseJsonLine(line);
      const node = message ? nodeOf(message) : null;
      if (node) {
        nodes.push(node);
      }
    });
    if (result.exitCode !== 0) {
      throw this.failure("ls", result);
    }
    return nodes;
  }

  /** `restic restore` of the given snapshot paths into a new folder; never overwrites. */
  async restore(input: {
    snapshotId: string;
    target: string;
    includes: readonly string[];
  }): Promise<void> {
    const args = [
      "restore",
      "--json",
      "--target",
      input.target,
      "--overwrite",
      "never",
      "--verify",
      "--retry-lock",
      "15m",
    ];
    for (const include of input.includes) {
      if (!include.startsWith("/") || include.includes("\0")) {
        throw new Error(`restore: invalid snapshot path ${JSON.stringify(include)}`);
      }
      args.push("--include", escapeIncludePath(include));
    }
    args.push(input.snapshotId);
    const result = await this.exec(args, (line) => {
      if (parseJsonLine(line) === null && line.trim() !== "") this.log(line.trim());
    });
    if (result.exitCode !== 0) {
      throw this.failure("restore", result);
    }
  }
}
