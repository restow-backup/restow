/**
 * Process helpers for the smoke: run a command, capture its output, stream it
 * when asked. Nothing here knows about Restow.
 */
import { spawn } from "node:child_process";

export class CommandError extends Error {
  constructor(command, args, result) {
    const tail = `${result.stderr}${result.stdout}`.trim().split("\n").slice(-15).join("\n");
    super(`${command} ${args.join(" ")} exited with ${result.code}\n${tail}`);
    this.name = "CommandError";
    this.result = result;
  }
}

/**
 * Run `command` and resolve with `{ code, stdout, stderr }`. Rejects with a
 * CommandError on a non-zero exit unless `allowFailure` is set.
 *
 * Options: `cwd`, `env` (merged over process.env), `input` (written to stdin),
 * `stream` (mirror output to the console), `allowFailure`, `timeoutMs`.
 */
export function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.stream) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (options.stream) {
        process.stderr.write(chunk);
      }
    });
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      const result = { code: timedOut ? 124 : (code ?? 1), stdout, stderr };
      if (result.code !== 0 && !options.allowFailure) {
        reject(new CommandError(command, args, result));
      } else {
        resolve(result);
      }
    });
    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call `attempt` until it returns a truthy value or `timeoutMs` passes. A
 * thrown error counts as "not yet"; the last one is reported on timeout.
 */
export async function waitFor(
  description,
  attempt,
  { timeoutMs = 60_000, intervalMs = 1_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await attempt();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const reason = lastError
        ? `: ${lastError instanceof Error ? lastError.message : lastError}`
        : "";
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${description}${reason}`,
      );
    }
    await sleep(intervalMs);
  }
}
