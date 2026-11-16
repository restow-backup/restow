/**
 * The agent's restore planner on the server (docs/BAREMETAL.md 12.2). Stage 1 asks the one
 * planner there is, `restow-agent baremetal plan`, whether a layout is restorable, instead of
 * keeping a second one in TypeScript. Its input is the manifest of a possibly compromised machine,
 * so the binary runs boxed in:
 *
 *   - `execFile` with an environment of `PATH` and `LC_ALL` only: no `RESTOW_*`, no database URL,
 *     no master key reach it;
 *   - a fresh, empty working folder, removed afterwards; stdin as its only input (the manifest and
 *     the facts as two JSON values back to back); no file descriptors beyond stdin, stdout and
 *     stderr;
 *   - `prlimit --data=512 MiB --cpu=30 --nofile=16` when util-linux has it (the image does); the
 *     binary sets the same limits itself. RLIMIT_AS is never used: a Go program cannot start under
 *     it (it reserves its address space up front);
 *   - 45 seconds and 4 MiB of output at most.
 *
 * A plan comes back as a plan, an input the planner refused as its error object; a timeout, too
 * much output, a crash, garbage or a missing binary prove nothing about the backup and come back
 * as incomplete.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PlannerOutcome, type PlanTarget, parsePlanOutput } from "@restow/core";

/** Where the image keeps the planner: the agent binary of the worker's own architecture. */
export const DEFAULT_PLANNER_BIN = "/usr/local/lib/restow/restow-agent";
export const PRLIMIT = "/usr/bin/prlimit";

/** Limits of one planner run (12.2). */
export const PLANNER_TIMEOUT_MS = 45_000;
export const PLANNER_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const PLANNER_LIMITS = ["--data=536870912", "--cpu=30", "--nofile=16"] as const;

/** The only environment the planner sees. */
export const PLANNER_ENV: Readonly<Record<string, string>> = { PATH: "/usr/bin:/bin", LC_ALL: "C" };

/** `RESTOW_PLANNER_BIN`, else the image's copy. */
export function plannerBinary(env: Record<string, string | undefined> = process.env): string {
  return env.RESTOW_PLANNER_BIN?.trim() || DEFAULT_PLANNER_BIN;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the run did not end on its own: why. */
  failure: "timeout" | "output_too_large" | "unavailable" | null;
}

export interface SandboxOptions {
  signal?: AbortSignal;
  /** Tests point this elsewhere; null runs the binary without prlimit. */
  prlimit?: string | null;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Run the planner binary with `args` and `stdin` in the sandbox described above. */
export async function runSandboxed(
  bin: string,
  args: readonly string[],
  stdin: Buffer,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  if (!(await executable(bin))) {
    return { stdout: "", stderr: "", exitCode: null, signal: null, failure: "unavailable" };
  }
  const prlimit =
    options.prlimit === undefined
      ? (await executable(PRLIMIT))
        ? PRLIMIT
        : null
      : options.prlimit;
  const [file, argv] = prlimit
    ? [prlimit, [...PLANNER_LIMITS, "--", bin, ...args]]
    : [bin, [...args]];
  const cwd = await mkdtemp(join(tmpdir(), "restow-planner-"));
  try {
    return await new Promise<SandboxResult>((resolve, reject) => {
      const child = execFile(
        file,
        argv,
        {
          cwd,
          env: { ...PLANNER_ENV },
          timeout: options.timeoutMs ?? PLANNER_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: options.maxOutputBytes ?? PLANNER_MAX_OUTPUT_BYTES,
          encoding: "utf8",
          windowsHide: true,
          signal: options.signal,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr, exitCode: 0, signal: null, failure: null });
            return;
          }
          const failed = error as NodeJS.ErrnoException & {
            code?: string | number;
            killed?: boolean;
            signal?: NodeJS.Signals | null;
          };
          if (failed.name === "AbortError") {
            reject(error);
            return;
          }
          if (failed.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            resolve({
              stdout: "",
              stderr,
              exitCode: null,
              signal: null,
              failure: "output_too_large",
            });
            return;
          }
          if (failed.code === "ENOENT" || failed.code === "EACCES") {
            resolve({ stdout: "", stderr, exitCode: null, signal: null, failure: "unavailable" });
            return;
          }
          if (failed.killed && failed.signal === "SIGKILL") {
            resolve({ stdout, stderr, exitCode: null, signal: "SIGKILL", failure: "timeout" });
            return;
          }
          resolve({
            stdout,
            stderr,
            exitCode: typeof failed.code === "number" ? failed.code : null,
            signal: failed.signal ?? null,
            failure: null,
          });
        },
      );
      // A planner that never reads its input must not stall the write.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export interface PlannerRun {
  outcome: PlannerOutcome;
  /** The end of the planner's stderr, for the worker's log (never shown to tenants). */
  stderr: string;
}

/**
 * Plan the manifest against one of the server's targets: `baremetal plan --manifest - --facts -
 * --target <target> --json`, stdin the manifest's canonical bytes, a line break and the facts.
 */
export async function runPlanner(input: {
  bin: string;
  manifest: Buffer;
  facts: object;
  target: PlanTarget;
  signal?: AbortSignal;
  sandbox?: Omit<SandboxOptions, "signal">;
}): Promise<PlannerRun> {
  const stdin = Buffer.concat([
    input.manifest,
    Buffer.from("\n"),
    Buffer.from(JSON.stringify(input.facts), "utf8"),
  ]);
  const args = [
    "baremetal",
    "plan",
    "--manifest",
    "-",
    "--facts",
    "-",
    "--target",
    input.target,
    "--json",
  ];
  const result = await runSandboxed(input.bin, args, stdin, {
    ...input.sandbox,
    signal: input.signal,
  });
  const stderr = result.stderr.slice(-2000);
  if (result.failure === "unavailable") {
    return { outcome: { kind: "incomplete", reason: "planner_unavailable" }, stderr };
  }
  if (result.failure === "timeout") {
    return { outcome: { kind: "incomplete", reason: "planner_timeout" }, stderr };
  }
  if (result.failure === "output_too_large") {
    return { outcome: { kind: "incomplete", reason: "planner_output_too_large" }, stderr };
  }
  if (result.signal !== null || (result.exitCode !== 0 && result.exitCode !== 1)) {
    return { outcome: { kind: "incomplete", reason: "planner_crashed" }, stderr };
  }
  const parsed = parsePlanOutput(result.stdout.trim());
  if (parsed.kind === "plan" && result.exitCode === 0) {
    return { outcome: { kind: "plan", plan: parsed.plan }, stderr };
  }
  if (parsed.kind === "refused") {
    return { outcome: { kind: "refused", error: parsed.error }, stderr };
  }
  return { outcome: { kind: "incomplete", reason: "planner_crashed" }, stderr };
}

/** The planner's version (`restow-agent version --short`), or null when it cannot tell. */
export async function plannerVersion(bin: string, sandbox: Omit<SandboxOptions, "signal"> = {}) {
  const result = await runSandboxed(bin, ["version", "--short"], Buffer.alloc(0), {
    ...sandbox,
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
  });
  const version = result.exitCode === 0 ? result.stdout.trim().split(/\s+/)[0] : undefined;
  return version && /^v?\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(version) ? version.slice(0, 64) : null;
}
