/**
 * A tiny cookie-jar-aware HTTP client for the seed process (index.ts): Node's
 * `fetch` carries no cookie jar of its own, and the seed needs one across
 * calls (the admin session `POST /api/v1/setup` opens). No new dependency —
 * this is a few dozen lines, not a general HTTP client.
 */

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export class ApiRequestError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${method} ${path} failed with status ${status}: ${JSON.stringify(body)}`);
    this.name = "ApiRequestError";
  }
}

/** `name=value` pairs from a list of raw `Set-Cookie` header values. */
export function parseSetCookiePairs(setCookieLines: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const line of setCookieLines) {
    const [attribute] = line.split(";", 1);
    const separator = attribute?.indexOf("=") ?? -1;
    if (!attribute || separator === -1) {
      continue;
    }
    pairs.push([attribute.slice(0, separator).trim(), attribute.slice(separator + 1).trim()]);
  }
  return pairs;
}

export interface RequestOptions {
  body?: unknown;
  /** `X-Restow-Tenant`, for tenant-scoped endpoints. */
  tenantId?: string;
  /** Send the seed's own bypass token (apps/api middleware/demo-guard.ts). */
  seed?: boolean;
  /** A raw request body (an upload segment) instead of JSON; sent as given. */
  rawBody?: Uint8Array;
  /** Extra request headers, for a raw body: the content type and its checksum. */
  headers?: Record<string, string>;
}

export class ApiClient {
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly seedToken: string | undefined,
    /**
     * Sent as `Origin` on every request: better-auth refuses a state-
     * changing `/api/auth/*` call (sign-in included) without one, the same
     * way a browser always sends it. Restow's own cross-site guard
     * (apps/api middleware/browser-request.ts) also accepts a same-origin
     * request without `Sec-Fetch-Site`, which a plain server-to-server
     * `fetch` never sets either.
     */
    private readonly originHeader: string | undefined = undefined,
  ) {}

  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) {
      return undefined;
    }
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private rememberCookies(response: Response): void {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const [name, value] of parseSetCookiePairs(raw)) {
      this.cookies.set(name, value);
    }
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    Object.assign(headers, options.headers);
    if (this.originHeader) {
      headers.origin = this.originHeader;
    }
    const cookie = this.cookieHeader();
    if (cookie) {
      headers.cookie = cookie;
    }
    if (options.tenantId) {
      headers["x-restow-tenant"] = options.tenantId;
    }
    if (options.seed && this.seedToken) {
      headers["x-restow-demo-seed-token"] = this.seedToken;
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body:
        options.rawBody !== undefined
          ? options.rawBody
          : options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
    });
    this.rememberCookies(response);
    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body: body as T };
  }

  async get<T = unknown>(path: string, options: Omit<RequestOptions, "body"> = {}): Promise<T> {
    const { status, body } = await this.request<T>("GET", path, options);
    if (status >= 400) {
      throw new ApiRequestError("GET", path, status, body);
    }
    return body;
  }

  async post<T = unknown>(
    path: string,
    body?: unknown,
    options: Omit<RequestOptions, "body"> = {},
  ): Promise<T> {
    const result = await this.request<T>("POST", path, { ...options, body: body ?? {} });
    if (result.status >= 400) {
      throw new ApiRequestError("POST", path, result.status, result.body);
    }
    return result.body;
  }

  /** Like `post`, but does not throw: the caller decides what a given status means. */
  async postRaw<T = unknown>(
    path: string,
    body?: unknown,
    options: Omit<RequestOptions, "body"> = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>("POST", path, { ...options, body: body ?? {} });
  }
}
