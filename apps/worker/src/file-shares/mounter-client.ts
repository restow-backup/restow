import { readFile } from "node:fs/promises";
import { type RunnerClient, createRunnerClient } from "@restow/core";

/**
 * The worker's side of the mounter (docs/FILESHARES.md 8.2): the dispatcher starts
 * file share runs and the monitor asks about them through the mounter's runner routes.
 * Like the api (apps/api/src/features/mounts/mounter-client.ts) the worker reads the
 * mounter's shared secret from the volume the mounter writes it to
 * (`restow-mounter-shared`, mounted read-only into the worker by both compose files)
 * and sends it only to RESTOW_MOUNTER_URL. The request shapes are the core's
 * (packages/core/src/file-shares/runner.ts), pinned to the mounter's schemas.
 * dispatch.ts starts runs with it, monitor.ts asks about and stops them, purge.ts removes a
 * share's cache volume.
 */

export const DEFAULT_MOUNTER_URL = "http://mounter:8091";
export const DEFAULT_MOUNTER_SECRET_FILE = "/mounter-shared/secret";

/** Reads the shared secret, re-reads it after 30 s or after a 401. */
export class MounterSecretFile {
  private cached: { value: string; at: number } | null = null;

  constructor(
    private readonly file: string,
    private readonly read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 30_000,
  ) {}

  async get(): Promise<string | null> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) {
      return this.cached.value;
    }
    try {
      const value = (await this.read(this.file)).trim();
      this.cached = value ? { value, at: this.now() } : null;
      return value || null;
    } catch {
      this.cached = null;
      return null;
    }
  }

  forget(): void {
    this.cached = null;
  }
}

/**
 * The client of this process: RESTOW_MOUNTER_URL (unset: the compose default; empty
 * or demo mode: switched off) and RESTOW_MOUNTER_SECRET_FILE.
 */
export function runnerClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: {
    demo?: boolean;
    fetch?: typeof fetch;
    readFile?: (path: string) => Promise<string>;
  } = {},
): RunnerClient {
  const raw = env.RESTOW_MOUNTER_URL;
  const url = options.demo
    ? null
    : raw === undefined
      ? DEFAULT_MOUNTER_URL
      : raw.trim() === ""
        ? null
        : raw.trim();
  const secret = new MounterSecretFile(
    env.RESTOW_MOUNTER_SECRET_FILE?.trim() || DEFAULT_MOUNTER_SECRET_FILE,
    options.readFile,
  );
  return createRunnerClient({
    url,
    secret: () => secret.get(),
    forgetSecret: () => secret.forget(),
    fetch: options.fetch,
  });
}
