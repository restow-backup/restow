import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type ScheduleRequest,
  type StateView,
  UPDATER_AUTH_SCHEME,
  stateViewSchema,
} from "../../updater/protocol.js";

/**
 * The api's side of the updater (docs/ARCHITECTURE.md, Updates): a small HTTP
 * client on the internal Docker network. The updater is opt-in, so "not
 * there" is a normal answer: `state()` resolves to null when nothing answers
 * and the Updates tab then shows the manual steps. The shared secret is read
 * from the volume the updater wrote it to (mounted read-only into the api); it
 * is only ever sent to the configured updater URL and never logged.
 */

export const DEFAULT_UPDATER_URL = "http://updater:8090";
export const DEFAULT_SECRET_FILE = "/updater-shared/secret";

export type UpdaterFailure = "disabled" | "no_secret" | "unreachable" | "timeout" | "incompatible";

/** Nothing usable answered (the updater is not running, not reachable, or speaks another version). */
export class UpdaterUnavailableError extends Error {
  constructor(readonly reason: UpdaterFailure) {
    super(`the updater is unavailable (${reason})`);
    this.name = "UpdaterUnavailableError";
  }
}

/** The updater answered and refused the request. */
export class UpdaterRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly body: unknown,
  ) {
    super(`the updater refused the request (${status}${code ? ` ${code}` : ""})`);
    this.name = "UpdaterRejectedError";
  }
}

export interface UpdaterClientOptions {
  /** Updater base URL; empty or undefined-with-empty disables the client. */
  url: string | null;
  secretFile: string;
  fetch?: typeof fetch;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
  timeoutMs?: number;
  /** How long a state answer is reused (protects the updater from many pollers). */
  stateTtlMs?: number;
  /** How long "nothing answers" is remembered before asking again. */
  downTtlMs?: number;
}

export interface UpdaterClient {
  /** False when the client is switched off (demo, `RESTOW_UPDATER_URL` empty). */
  readonly enabled: boolean;
  /** The updater's state, or null when none answers. `fresh` skips the short cache. */
  state(options?: { fresh?: boolean; refresh?: boolean }): Promise<StateView | null>;
  schedule(request: ScheduleRequest): Promise<StateView>;
  cancel(): Promise<StateView>;
  acknowledge(): Promise<StateView>;
  /**
   * Start the mounter (`POST /v1/mounter/enable`, docs/FILESHARES.md 3.9). The updater
   * answers once its helper finished, or after a minute with the start still running.
   */
  enableMounter(): Promise<StateView>;
}

/** How long the api waits for `POST /v1/mounter/enable` (the updater waits up to a minute). */
export const ENABLE_MOUNTER_TIMEOUT_MS = 90_000;

/** The shared secret, re-read now and then so a restarted updater's new secret is picked up. */
export class SecretReader {
  private cached: { value: string; at: number } | null = null;

  constructor(
    private readonly file: string,
    private readonly read: (path: string) => Promise<string>,
    private readonly now: () => number,
    private readonly ttlMs = 30_000,
  ) {}

  async get(): Promise<string | null> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) {
      return this.cached.value;
    }
    try {
      const value = (await this.read(this.file)).trim();
      if (value.length === 0) {
        this.cached = null;
        return null;
      }
      this.cached = { value, at: this.now() };
      return value;
    } catch {
      this.cached = null;
      return null;
    }
  }

  forget(): void {
    this.cached = null;
  }
}

/** Constant-time comparison of a presented bearer token with the shared secret. */
export function secretMatches(presented: string, secret: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The bearer token of an `Authorization` header, or null. */
export function bearerOf(header: string | null | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  return scheme?.toLowerCase() === UPDATER_AUTH_SCHEME.toLowerCase() && token && rest.length === 0
    ? token
    : null;
}

export function createUpdaterClient(options: UpdaterClientOptions): UpdaterClient {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5000;
  const stateTtl = options.stateTtlMs ?? 2000;
  const downTtl = options.downTtlMs ?? 8000;
  const base = options.url ? options.url.replace(/\/+$/, "") : null;
  const secrets = new SecretReader(options.secretFile, options.readFile ?? readUtf8, now);
  let cachedState: { at: number; value: StateView | null; failure: UpdaterFailure | null } | null =
    null;
  let inFlight: Promise<StateView | null> | null = null;

  async function request(
    method: string,
    path: string,
    body?: unknown,
    requestTimeoutMs: number = timeoutMs,
  ): Promise<unknown> {
    if (!base) {
      throw new UpdaterUnavailableError("disabled");
    }
    const secret = await secrets.get();
    if (!secret) {
      throw new UpdaterUnavailableError("no_secret");
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
        signal: AbortSignal.timeout(requestTimeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new UpdaterUnavailableError(timedOut ? "timeout" : "unreachable");
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (response.status === 401) {
      // The updater generated a new secret (its volume was replaced): ask the file again.
      secrets.forget();
      throw new UpdaterUnavailableError("no_secret");
    }
    if (!response.ok) {
      const code =
        typeof (parsed as { code?: unknown } | null)?.code === "string"
          ? ((parsed as { code: string }).code as string)
          : null;
      throw new UpdaterRejectedError(response.status, code, parsed);
    }
    return parsed;
  }

  function toState(value: unknown): StateView {
    const parsed = stateViewSchema.safeParse(value);
    if (!parsed.success) {
      throw new UpdaterUnavailableError("incompatible");
    }
    return parsed.data;
  }

  async function loadState(refresh: boolean): Promise<StateView | null> {
    try {
      const view = toState(await request("GET", refresh ? "/v1/state?refresh=1" : "/v1/state"));
      cachedState = { at: now(), value: view, failure: null };
      return view;
    } catch (error) {
      if (error instanceof UpdaterUnavailableError) {
        cachedState = { at: now(), value: null, failure: error.reason };
        if (error.reason === "incompatible") {
          throw error;
        }
        return null;
      }
      throw error;
    }
  }

  function remember(view: StateView): StateView {
    cachedState = { at: now(), value: view, failure: null };
    return view;
  }

  return {
    enabled: base !== null,
    async state(callOptions = {}) {
      if (!base) {
        return null;
      }
      const age = cachedState ? now() - cachedState.at : Number.POSITIVE_INFINITY;
      if (!callOptions.fresh && !callOptions.refresh && cachedState) {
        const ttl = cachedState.value ? stateTtl : downTtl;
        if (age < ttl) {
          if (cachedState.failure === "incompatible") {
            throw new UpdaterUnavailableError("incompatible");
          }
          return cachedState.value;
        }
      }
      inFlight ??= loadState(callOptions.refresh === true).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    async schedule(scheduleRequest) {
      return remember(toState(await request("POST", "/v1/schedule", scheduleRequest)));
    },
    async cancel() {
      return remember(toState(await request("POST", "/v1/cancel", {})));
    },
    async acknowledge() {
      return remember(toState(await request("POST", "/v1/acknowledge", {})));
    },
    async enableMounter() {
      return remember(
        toState(await request("POST", "/v1/mounter/enable", {}, ENABLE_MOUNTER_TIMEOUT_MS)),
      );
    },
  };
}

function readUtf8(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/** A client that is switched off (the demo installation, or `RESTOW_UPDATER_URL` set empty). */
export const disabledUpdaterClient: UpdaterClient = {
  enabled: false,
  state: async () => null,
  schedule: async () => {
    throw new UpdaterUnavailableError("disabled");
  },
  cancel: async () => {
    throw new UpdaterUnavailableError("disabled");
  },
  acknowledge: async () => {
    throw new UpdaterUnavailableError("disabled");
  },
  enableMounter: async () => {
    throw new UpdaterUnavailableError("disabled");
  },
};

/** The client the process uses, configured by `RESTOW_UPDATER_URL` and `RESTOW_UPDATER_SECRET_FILE`. */
export function updaterClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  demo = false,
): UpdaterClient {
  if (demo) {
    return disabledUpdaterClient;
  }
  const raw = env.RESTOW_UPDATER_URL;
  // Unset means the default service name; set but empty switches the client off.
  const url = raw === undefined ? DEFAULT_UPDATER_URL : raw.trim() === "" ? null : raw.trim();
  return createUpdaterClient({
    url,
    secretFile: env.RESTOW_UPDATER_SECRET_FILE?.trim() || DEFAULT_SECRET_FILE,
  });
}
