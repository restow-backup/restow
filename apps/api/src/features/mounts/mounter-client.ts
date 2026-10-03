import { readFile } from "node:fs/promises";
import {
  type AddMountRequest,
  type MountSpec,
  type MounterState,
  type RemoveMountRequest,
  type TestResult,
  mounterStateSchema,
  testResultSchema,
} from "../../mounter/protocol.js";
import { UPDATER_AUTH_SCHEME } from "../../updater/protocol.js";
import { SecretReader } from "../updates/updater-client.js";

/**
 * The api's side of the mounter (docs/MOUNTS.md): a small HTTP client on the internal
 * Docker network, like the updater's (features/updates/updater-client.ts). The mounter
 * is opt-in, so "not there" is a normal answer: `state()` resolves to null and the
 * Mounts section shows how to start it. The shared secret is read from the volume the
 * mounter wrote it to (mounted read-only into the api); it is only ever sent to the
 * configured mounter URL and never logged.
 */

export const DEFAULT_MOUNTER_URL = "http://mounter:8091";
export const DEFAULT_MOUNTER_SECRET_FILE = "/mounter-shared/secret";

export type MounterFailure = "disabled" | "no_secret" | "unreachable" | "timeout" | "incompatible";

/** Nothing usable answered (the mounter is not running, not reachable, or speaks another version). */
export class MounterUnavailableError extends Error {
  constructor(readonly reason: MounterFailure) {
    super(`the mounter is unavailable (${reason})`);
    this.name = "MounterUnavailableError";
  }
}

/** The mounter answered and refused the request. */
export class MounterRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly detail: string | null,
  ) {
    super(`the mounter refused the request (${status}${code ? ` ${code}` : ""})`);
    this.name = "MounterRejectedError";
  }
}

export interface MounterClient {
  readonly enabled: boolean;
  /** The mounter's state, or null when none answers (`failure()` says why). */
  state(options?: { refresh?: boolean }): Promise<MounterState | null>;
  /** Why the last `state()` answered null; null when it answered. */
  failure(): MounterFailure | null;
  add(request: AddMountRequest): Promise<MounterState>;
  remove(name: string, request: RemoveMountRequest): Promise<MounterState>;
  test(target: { mount: MountSpec } | { name: string }): Promise<TestResult>;
}

export interface MounterClientOptions {
  url: string | null;
  secretFile: string;
  fetch?: typeof fetch;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
  timeoutMs?: number;
  /** A test mounts the share: it may take as long as the mounter's probe timeout. */
  testTimeoutMs?: number;
}

export function createMounterClient(options: MounterClientOptions): MounterClient {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5000;
  const testTimeoutMs = options.testTimeoutMs ?? 90_000;
  const base = options.url ? options.url.replace(/\/+$/, "") : null;
  const secrets = new SecretReader(options.secretFile, options.readFile ?? readUtf8, now);
  let lastFailure: MounterFailure | null = base ? null : "disabled";

  async function request(
    method: string,
    path: string,
    body?: unknown,
    timeout = timeoutMs,
  ): Promise<unknown> {
    if (!base) {
      throw new MounterUnavailableError("disabled");
    }
    const secret = await secrets.get();
    if (!secret) {
      throw new MounterUnavailableError("no_secret");
    }
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        headers: {
          authorization: `${UPDATER_AUTH_SCHEME} ${secret}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
        redirect: "error",
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new MounterUnavailableError(timedOut ? "timeout" : "unreachable");
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (response.status === 401) {
      secrets.forget();
      throw new MounterUnavailableError("no_secret");
    }
    if (!response.ok) {
      const record = (parsed ?? {}) as { code?: unknown; message?: unknown };
      throw new MounterRejectedError(
        response.status,
        typeof record.code === "string" ? record.code : null,
        typeof record.message === "string" ? record.message.slice(0, 600) : null,
      );
    }
    return parsed;
  }

  function toState(value: unknown): MounterState {
    const parsed = mounterStateSchema.safeParse(value);
    if (!parsed.success) {
      throw new MounterUnavailableError("incompatible");
    }
    return parsed.data;
  }

  return {
    enabled: base !== null,
    failure: () => lastFailure,
    async state(callOptions = {}) {
      if (!base) {
        lastFailure = "disabled";
        return null;
      }
      try {
        const state = toState(
          await request("GET", callOptions.refresh ? "/v1/state?refresh=1" : "/v1/state"),
        );
        lastFailure = null;
        return state;
      } catch (error) {
        if (error instanceof MounterUnavailableError) {
          lastFailure = error.reason;
          return null;
        }
        throw error;
      }
    },
    async add(addRequest) {
      return toState(await request("POST", "/v1/mounts", addRequest));
    },
    async remove(name, removeRequest) {
      return toState(
        await request("DELETE", `/v1/mounts/${encodeURIComponent(name)}`, removeRequest),
      );
    },
    async test(target) {
      const parsed = testResultSchema.safeParse(
        await request("POST", "/v1/test", target, testTimeoutMs),
      );
      if (!parsed.success) {
        throw new MounterUnavailableError("incompatible");
      }
      return parsed.data;
    },
  };
}

function readUtf8(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/** The client the process uses: `RESTOW_MOUNTER_URL` (empty switches it off) and `RESTOW_MOUNTER_SECRET_FILE`. */
export function mounterClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  demo = false,
): MounterClient {
  const raw = env.RESTOW_MOUNTER_URL;
  const url = demo
    ? null
    : raw === undefined || raw.trim() === ""
      ? DEFAULT_MOUNTER_URL
      : raw.trim();
  return createMounterClient({
    url,
    secretFile: env.RESTOW_MOUNTER_SECRET_FILE?.trim() || DEFAULT_MOUNTER_SECRET_FILE,
  });
}
