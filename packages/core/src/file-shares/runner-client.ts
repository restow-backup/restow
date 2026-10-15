import type {
  RunnerCapabilities,
  RunnerExecRequest,
  RunnerExecResult,
  RunnerRunDetail,
  RunnerRunRequest,
  RunnerRunView,
} from "./runner.js";

/**
 * An HTTP client of the mounter's runner routes (docs/FILESHARES.md 3.1), for the
 * worker's dispatcher and monitor (8.2, 8.3) and the api's test and list (Phase C).
 * It holds no secret of its own: the shared secret comes from `secret()` per request
 * and is only ever sent to the configured mounter URL. Share passwords travel in the
 * request bodies and appear in no error this client raises.
 */

/** The mounter is not there, has no secret for us, or answers in another language. */
export class RunnerUnavailableError extends Error {
  constructor(
    readonly reason: "disabled" | "no_secret" | "unreachable" | "timeout" | "incompatible",
  ) {
    super(`the mounter is unavailable (${reason})`);
    this.name = "RunnerUnavailableError";
  }
}

/** The mounter answered and refused: `code` is a runner failure code or a mounter error code. */
export class RunnerRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string | null,
  ) {
    super(`the mounter refused the request (${status} ${code})`);
    this.name = "RunnerRefusedError";
  }
}

export interface RunnerClientOptions {
  /** http://mounter:8091; null disables the client. */
  url: string | null;
  /** The mounter's shared secret (re-read on 401); null when there is none. */
  secret: () => Promise<string | null>;
  /** Called after a 401, so the secret is read again next time. */
  forgetSecret?: () => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** A test or list mounts the share: up to the mounter's exec timeout and some. */
  execTimeoutMs?: number;
  /** Starting a run creates volumes and a container. */
  startTimeoutMs?: number;
}

export interface RunnerClient {
  readonly enabled: boolean;
  capabilities(): Promise<RunnerCapabilities | null>;
  exec(request: RunnerExecRequest): Promise<RunnerExecResult>;
  start(request: RunnerRunRequest): Promise<{ runId: string; startedAt: string }>;
  list(): Promise<RunnerRunView[]>;
  /** null when the mounter does not know the run. */
  get(runId: string): Promise<RunnerRunDetail | null>;
  stop(runId: string): Promise<void>;
  removeCache(shareId: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createRunnerClient(options: RunnerClientOptions): RunnerClient {
  const fetcher = options.fetch ?? fetch;
  const base = options.url ? options.url.replace(/\/+$/, "") : null;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const execTimeoutMs = options.execTimeoutMs ?? 90_000;
  const startTimeoutMs = options.startTimeoutMs ?? 60_000;

  async function request(
    method: string,
    path: string,
    body: unknown,
    timeout: number,
  ): Promise<{ status: number; json: unknown }> {
    if (!base) {
      throw new RunnerUnavailableError("disabled");
    }
    const secret = await options.secret();
    if (!secret) {
      throw new RunnerUnavailableError("no_secret");
    }
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
        redirect: "error",
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new RunnerUnavailableError(timedOut ? "timeout" : "unreachable");
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (response.status === 401) {
      options.forgetSecret?.();
      throw new RunnerUnavailableError("no_secret");
    }
    return { status: response.status, json };
  }

  function refused(status: number, json: unknown): RunnerRefusedError {
    const record = (json ?? {}) as { code?: unknown; message?: unknown };
    return new RunnerRefusedError(
      status,
      typeof record.code === "string" ? record.code : "unknown",
      typeof record.message === "string" ? record.message.slice(0, 600) : null,
    );
  }

  function expectObject<T>(json: unknown, keys: string[]): T {
    if (!json || typeof json !== "object" || keys.some((key) => !(key in json))) {
      throw new RunnerUnavailableError("incompatible");
    }
    return json as T;
  }

  function checkUuid(value: string, what: string): void {
    if (!UUID.test(value)) {
      throw new TypeError(`${what} is not a UUID`);
    }
  }

  return {
    enabled: base !== null,
    async capabilities() {
      try {
        const { status, json } = await request("GET", "/v1/state", undefined, timeoutMs);
        if (status !== 200) {
          return null;
        }
        const runner = (json as { runner?: unknown } | null)?.runner;
        return runner
          ? expectObject<RunnerCapabilities>(runner, ["ready", "blockers", "limit"])
          : null;
      } catch (error) {
        if (error instanceof RunnerUnavailableError) {
          return null;
        }
        throw error;
      }
    },
    async exec(execRequest) {
      const { status, json } = await request("POST", "/v1/runner/exec", execRequest, execTimeoutMs);
      if (status !== 200) {
        throw refused(status, json);
      }
      return expectObject<RunnerExecResult>(json, ["ok", "code", "detail", "output"]);
    },
    async start(runRequest) {
      const { status, json } = await request("POST", "/v1/runner/runs", runRequest, startTimeoutMs);
      if (status !== 202) {
        throw refused(status, json);
      }
      return expectObject<{ runId: string; startedAt: string }>(json, ["runId", "startedAt"]);
    },
    async list() {
      const { status, json } = await request("GET", "/v1/runner/runs", undefined, timeoutMs);
      if (status !== 200 || !Array.isArray(json)) {
        throw status === 200 ? new RunnerUnavailableError("incompatible") : refused(status, json);
      }
      return json as RunnerRunView[];
    },
    async get(runId) {
      checkUuid(runId, "runId");
      const { status, json } = await request(
        "GET",
        `/v1/runner/runs/${runId}`,
        undefined,
        timeoutMs,
      );
      if (status === 404) {
        return null;
      }
      if (status !== 200) {
        throw refused(status, json);
      }
      return expectObject<RunnerRunDetail>(json, ["runId", "state", "exitCode"]);
    },
    async stop(runId) {
      checkUuid(runId, "runId");
      const { status, json } = await request(
        "DELETE",
        `/v1/runner/runs/${runId}`,
        undefined,
        60_000,
      );
      if (status !== 202 && status !== 404) {
        throw refused(status, json);
      }
    },
    async removeCache(shareId) {
      checkUuid(shareId, "shareId");
      const { status, json } = await request(
        "DELETE",
        `/v1/runner/caches/${shareId}`,
        undefined,
        timeoutMs,
      );
      if (status !== 204 && status !== 404) {
        throw refused(status, json);
      }
    },
  };
}
