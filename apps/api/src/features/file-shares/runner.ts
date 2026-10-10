import { readFile } from "node:fs/promises";
import {
  type HostResolver,
  type RunnerClient,
  createRunnerClient,
  systemResolver,
} from "@restow/core";
import { config } from "../../config.js";
import { DEFAULT_MOUNTER_SECRET_FILE, DEFAULT_MOUNTER_URL } from "../mounts/mounter-client.js";
import { SecretReader } from "../updates/updater-client.js";

/**
 * The api's side of the mounter's runner operations (docs/FILESHARES.md 3.1): a connection test
 * (`probe`) and the live listing of a folder (`list`) run synchronously in a short-lived runner
 * container without network. Same address and shared secret as the mounts feature
 * (features/mounts/mounter-client.ts); the request shapes are the core's
 * (@restow/core file-shares/runner.ts). Tests replace the client and the name resolution.
 */

function clientFromEnv(env: Record<string, string | undefined> = process.env): RunnerClient {
  const raw = env.RESTOW_MOUNTER_URL;
  const url = config.demo.enabled
    ? null
    : raw === undefined || raw.trim() === ""
      ? DEFAULT_MOUNTER_URL
      : raw.trim();
  const secrets = new SecretReader(
    env.RESTOW_MOUNTER_SECRET_FILE?.trim() || DEFAULT_MOUNTER_SECRET_FILE,
    (path) => readFile(path, "utf8"),
    Date.now,
  );
  return createRunnerClient({
    url,
    secret: () => secrets.get(),
    forgetSecret: () => secrets.forget(),
  });
}

let client: RunnerClient | null = null;
let resolver: HostResolver = systemResolver;

/** The process-wide runner client. */
export function fileShareRunner(): RunnerClient {
  client ??= clientFromEnv();
  return client;
}

/** How share servers are resolved (10.1). */
export function fileShareResolver(): HostResolver {
  return resolver;
}

/** Tests: a fake mounter and a fixed name resolution; `null` restores the defaults. */
export function setFileShareRunner(next: RunnerClient | null): void {
  client = next;
}

export function setFileShareResolver(next: HostResolver | null): void {
  resolver = next ?? systemResolver;
}
