import type { ApiClient, ApiReadinessResult } from "./ops.js";
import {
  UPDATER_AUTH_SCHEME,
  UPDATER_SOURCE_TOKEN_PATH,
  apiReadinessSchema,
  sourceTokenResponseSchema,
} from "./protocol.js";
import type { Redactor } from "./redact.js";

/**
 * What the updater asks the api over the internal network, authenticated with the
 * shared secret: whether it is ready (and which version it reports), and, in
 * `source` mode, the access token of a private source repository.
 */

export interface HttpApiClientOptions {
  /** Base URL of the api, no trailing slash (for example `http://api:3000`). */
  apiUrl: string;
  secret: string;
  redactor: Redactor;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The database answers and every other check is a worker or scheduler that is `ok` or `missing`. */
function onlyServicesMissing(checks: Record<string, unknown> | undefined): boolean {
  if (!checks || checks.database !== true) {
    return false;
  }
  return Object.entries(checks).every(
    ([name, value]) => name === "database" || value === "ok" || value === "missing",
  );
}

export class HttpApiClient implements ApiClient {
  constructor(private readonly options: HttpApiClientOptions) {}

  private async get(path: string): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    return await fetchImpl(`${this.options.apiUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `${UPDATER_AUTH_SCHEME} ${this.options.secret}`,
        Accept: "application/json",
      },
      // The secret must never follow a redirect.
      redirect: "error",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
    });
  }

  async readiness(): Promise<ApiReadinessResult> {
    try {
      const response = await this.get("/readyz");
      let version: string | null = null;
      let status: string | null = null;
      let checks: Record<string, unknown> | undefined;
      try {
        const parsed = apiReadinessSchema.safeParse(await response.json());
        if (parsed.success) {
          status = parsed.data.status;
          version = parsed.data.version ?? null;
          checks = parsed.data.checks;
        }
      } catch {
        // No JSON body (a proxy error page): treated as not ready below.
      }
      if (response.status === 200 && status === "ready") {
        return { ready: true, version, reason: null };
      }
      // /readyz is only `ready` once the worker and the scheduler report in, and the
      // updater starts those two after the api: the api is up when its own database
      // check passes and nothing but a worker or a scheduler is missing.
      if (response.status === 503 && status === "not_ready" && onlyServicesMissing(checks)) {
        return { ready: true, version, reason: null };
      }
      return {
        ready: false,
        version,
        reason: `The api answered HTTP ${response.status}${status ? ` (${status})` : ""}.`,
      };
    } catch (error) {
      return {
        ready: false,
        version: null,
        reason: this.options.redactor.oneLine(describe(error), 200),
      };
    }
  }

  async sourceToken(): Promise<string | null> {
    let response: Response;
    try {
      response = await this.get(UPDATER_SOURCE_TOKEN_PATH);
    } catch (error) {
      throw new Error(
        `The api could not be asked for the access token: ${this.options.redactor.oneLine(describe(error), 200)}`,
      );
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`The api answered HTTP ${response.status} to the access token request.`);
    }
    const parsed = sourceTokenResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new Error("The api answered the access token request with an unexpected body.");
    }
    return parsed.data.token;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const code =
      cause && typeof cause === "object" && "code" in cause
        ? String((cause as { code: unknown }).code)
        : null;
    return code ? `${error.message} (${code})` : error.message;
  }
  return "unknown error";
}
