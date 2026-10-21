import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type MoveCheck,
  type MoveRequest,
  moveCheckSchema,
} from "../../updater/database-protocol.js";
import {
  type RestartableService,
  type ScheduleRequest,
  type StateView,
  stateViewSchema,
  UPDATER_AUTH_SCHEME,
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
  state(options?: {
    fresh?: boolean;
    refresh?: boolean;
    patient?: boolean;
  }): Promise<StateView | null>;
  schedule(request: ScheduleRequest): Promise<StateView>;
  cancel(): Promise<StateView>;
  acknowledge(): Promise<StateView>;
  /**
   * Start the mounter (`POST /v1/mounter/enable`, docs/FILESHARES.md 3.9). The updater
   * answers once its helper finished, or after a minute with the start still running.
   */
  enableMounter(): Promise<StateView>;
  /** Ask the updater to restart one application service; it answers before the restart ends. */
  restart(service: RestartableService): Promise<StateView>;
  /** Check a directory for the database (docs/DATABASE.md); nothing changes. */
  checkDatabaseLocation(request: MoveRequest): Promise<MoveCheck>;
  /** Start moving the database there; the updater answers when the move has started. */
  moveDatabase(request: MoveRequest): Promise<StateView>;
  /** Empty an old copy of the database a move left behind. */
  removeOldDatabaseCopy(id: string, requestedBy: MoveRequest["requestedBy"]): Promise<StateView>;
  /**
   * A pre-update dump as the updater streams it: the response is handed on as it is, never
   * buffered (a dump is as large as the database). null when there is no such dump.
   */
  downloadDump(file: string): Promise<Response | null>;
  /** Delete a pre-update dump. */
  deleteDump(file: string): Promise<StateView>;
}

/**
 * How long the api waits for the database checks: the updater measures the data directory
 * (`du`) and starts a helper container for the target before it answers.
 */
export const DATABASE_CHECK_TIMEOUT_MS = 180_000;

/** How long the api waits for `POST /v1/mounter/enable` (the updater waits up to a minute). */
export const ENABLE_MOUNTER_TIMEOUT_MS = 90_000;

/**
 * How long the api waits for `POST /v1/schedule`: the updater checks deeply before it accepts an
 * update (Docker, the Compose configuration, the disk space, the running version; several of
 * those run a short-lived helper container) and, with no lead time, starts the run. That takes
 * seconds; a short timeout made the api report "no updater" for an update that was accepted.
 */
export const SCHEDULE_TIMEOUT_MS = 60_000;

/**
 * How long the api waits for the other actions (cancel, acknowledge, restart, deleting a dump)
 * and for a state read the api must not misread as "no updater" (after a schedule timed out):
 * the updater answers with its state, which it may have to check again first.
 */
export const ACTION_TIMEOUT_MS = 30_000;

/**
 * How long a plain state read that timed out still answers with the updater's last state (it
 * answered that recently, so it runs and is only slow, for example while it checks again)
 * instead of "no updater". Reads that must not be misread (`fresh`, `refresh`, `patient`)
 * never get it; a refused connection never either.
 */
export const STATE_TIMEOUT_GRACE_MS = 30_000;

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
  /** The newest state the updater answered with, and when (for STATE_TIMEOUT_GRACE_MS). */
  let lastGood: { at: number; value: StateView } | null = null;

  /** The last state while the newest plain read timed out within the grace; else null. */
  function graceState(): StateView | null {
    if (cachedState?.failure !== "timeout" || !lastGood) {
      return null;
    }
    return now() - lastGood.at < STATE_TIMEOUT_GRACE_MS ? lastGood.value : null;
  }

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

  async function loadState(refresh: boolean, patient: boolean): Promise<StateView | null> {
    try {
      const view = toState(
        await request(
          "GET",
          refresh ? "/v1/state?refresh=1" : "/v1/state",
          undefined,
          patient ? ACTION_TIMEOUT_MS : timeoutMs,
        ),
      );
      cachedState = { at: now(), value: view, failure: null };
      lastGood = { at: now(), value: view };
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
    lastGood = { at: now(), value: view };
    return view;
  }

  return {
    enabled: base !== null,
    async state(callOptions = {}) {
      if (!base) {
        return null;
      }
      const age = cachedState ? now() - cachedState.at : Number.POSITIVE_INFINITY;
      const plain = !callOptions.fresh && !callOptions.refresh && !callOptions.patient;
      if (!callOptions.fresh && !callOptions.refresh && cachedState) {
        // A slow updater within the grace is asked again as soon as a good answer would be.
        const ttl = cachedState.value || graceState() ? stateTtl : downTtl;
        if (age < ttl) {
          if (cachedState.failure === "incompatible") {
            throw new UpdaterUnavailableError("incompatible");
          }
          return cachedState.value ?? (plain ? graceState() : null);
        }
      }
      if (callOptions.patient) {
        // Not shared with the quick reads: a timed-out quick read must not answer for it.
        return loadState(callOptions.refresh === true, true);
      }
      inFlight ??= loadState(callOptions.refresh === true, false).finally(() => {
        inFlight = null;
      });
      const view = await inFlight;
      return view ?? (plain ? graceState() : null);
    },
    async schedule(scheduleRequest) {
      return remember(
        toState(await request("POST", "/v1/schedule", scheduleRequest, SCHEDULE_TIMEOUT_MS)),
      );
    },
    async cancel() {
      return remember(toState(await request("POST", "/v1/cancel", {}, ACTION_TIMEOUT_MS)));
    },
    async acknowledge() {
      return remember(toState(await request("POST", "/v1/acknowledge", {}, ACTION_TIMEOUT_MS)));
    },
    async enableMounter() {
      return remember(
        toState(await request("POST", "/v1/mounter/enable", {}, ENABLE_MOUNTER_TIMEOUT_MS)),
      );
    },
    async restart(service) {
      return remember(
        toState(await request("POST", "/v1/restart", { service }, ACTION_TIMEOUT_MS)),
      );
    },
    async checkDatabaseLocation(moveRequest) {
      const parsed = moveCheckSchema.safeParse(
        await request("POST", "/v1/database/check", moveRequest, DATABASE_CHECK_TIMEOUT_MS),
      );
      if (!parsed.success) {
        throw new UpdaterUnavailableError("incompatible");
      }
      return parsed.data;
    },
    async moveDatabase(moveRequest) {
      return remember(
        toState(await request("POST", "/v1/database/move", moveRequest, DATABASE_CHECK_TIMEOUT_MS)),
      );
    },
    async removeOldDatabaseCopy(id, requestedBy) {
      return remember(
        toState(
          await request(
            "POST",
            `/v1/database/old-copies/${encodeURIComponent(id)}/remove`,
            { requestedBy },
            DATABASE_CHECK_TIMEOUT_MS,
          ),
        ),
      );
    },
    async downloadDump(file) {
      if (!base) {
        throw new UpdaterUnavailableError("disabled");
      }
      const secret = await secrets.get();
      if (!secret) {
        throw new UpdaterUnavailableError("no_secret");
      }
      // Only the answer's start is timed: the body of a large dump takes as long as it takes.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetcher(`${base}/v1/dumps/${encodeURIComponent(file)}`, {
          method: "GET",
          headers: { authorization: `${UPDATER_AUTH_SCHEME} ${secret}` },
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        throw new UpdaterUnavailableError(timedOut ? "timeout" : "unreachable");
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (response.status === 401) {
        await response.body?.cancel();
        secrets.forget();
        throw new UpdaterUnavailableError("no_secret");
      }
      if (!response.ok) {
        const text = await response.text();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        const code = (parsed as { code?: unknown } | null)?.code;
        throw new UpdaterRejectedError(
          response.status,
          typeof code === "string" ? code : null,
          parsed,
        );
      }
      return response;
    },
    async deleteDump(file) {
      return remember(
        toState(
          await request(
            "DELETE",
            `/v1/dumps/${encodeURIComponent(file)}`,
            undefined,
            ACTION_TIMEOUT_MS,
          ),
        ),
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
  restart: async () => {
    throw new UpdaterUnavailableError("disabled");
  },
  checkDatabaseLocation: async () => {
    throw new UpdaterUnavailableError("disabled");
  },
  moveDatabase: async () => {
    throw new UpdaterUnavailableError("disabled");
  },
  removeOldDatabaseCopy: async () => {
    throw new UpdaterUnavailableError("disabled");
  },
  downloadDump: async () => {
    throw new UpdaterUnavailableError("disabled");
  },
  deleteDump: async () => {
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
