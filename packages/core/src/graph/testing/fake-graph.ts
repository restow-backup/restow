/**
 * A recorded-style fake of Microsoft Graph for tests: routes map a method and a
 * URL matcher to one response or a sequence of responses (first call gets the
 * first, and so on). Every call is recorded so tests can assert on the exact
 * requests Restow made. Nothing here touches the network.
 */
import { FetchGraphClient, type GraphClientOptions } from "../client.js";

/** The body type `Response` accepts (the DOM lib is not loaded in this package). */
type ResponseBody = ConstructorParameters<typeof Response>[0];

/** One canned answer. Exactly one of `json`, `text`, `bytes` (or none for empty). */
export interface FixtureResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
  /** JSON body, when the request declared JSON. */
  json: unknown;
  /** The request's redirect mode, when the caller set one. */
  redirect?: RequestInit["redirect"];
}

export type UrlMatcher = string | RegExp | ((url: URL) => boolean);

export interface FixtureRoute {
  method?: string;
  url: UrlMatcher;
  /** A single answer for every call, a sequence consumed call by call, or a function. */
  respond:
    | FixtureResponse
    | FixtureResponse[]
    | ((call: RecordedCall, index: number) => FixtureResponse);
}

export interface FakeGraph {
  fetch: typeof fetch;
  calls: RecordedCall[];
  /** Calls matching a method and URL substring, in order. */
  callsTo(method: string, urlIncludes: string): RecordedCall[];
  /** A client wired to the fake with retries that never sleep. */
  client(options?: Partial<GraphClientOptions>): FetchGraphClient;
}

const JSON_TYPE = "application/json";

function matches(matcher: UrlMatcher, url: URL): boolean {
  if (typeof matcher === "string") {
    return (
      url.pathname === matcher || `${url.pathname}${url.search}` === matcher || url.href === matcher
    );
  }
  if (matcher instanceof RegExp) {
    return matcher.test(url.href) || matcher.test(`${url.pathname}${url.search}`);
  }
  return matcher(url);
}

function toResponse(fixture: FixtureResponse): Response {
  const headers = new Headers(fixture.headers ?? {});
  let body: ResponseBody = null;
  if (fixture.json !== undefined) {
    body = JSON.stringify(fixture.json);
    if (!headers.has("content-type")) {
      headers.set("content-type", JSON_TYPE);
    }
  } else if (fixture.text !== undefined) {
    body = fixture.text;
    if (!headers.has("content-type")) {
      headers.set("content-type", "text/plain");
    }
  } else if (fixture.bytes !== undefined) {
    body = fixture.bytes;
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/octet-stream");
    }
  }
  // 204/304 must not carry a body per the fetch spec.
  if (fixture.status === 204 || fixture.status === 304) {
    body = null;
  }
  return new Response(body, { status: fixture.status, headers });
}

async function readBody(init: RequestInit | undefined): Promise<string | Uint8Array | undefined> {
  const body = init?.body;
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  return new Uint8Array(await new Response(body as ResponseBody).arrayBuffer());
}

/** Build a fake Graph from routes. Unmatched requests answer 404 with a Graph error body. */
export function createFakeGraph(routes: FixtureRoute[]): FakeGraph {
  const calls: RecordedCall[] = [];
  const counters = new Map<FixtureRoute, number>();

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body = await readBody(init);
    const isJson = (headers["content-type"] ?? "").includes("json") && typeof body === "string";
    const call: RecordedCall = {
      method,
      url: url.href,
      headers,
      body,
      json: isJson && body.length > 0 ? JSON.parse(body) : undefined,
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    };
    calls.push(call);

    const route = routes.find(
      (r) => (r.method ?? "GET").toUpperCase() === method && matches(r.url, url),
    );
    if (!route) {
      return toResponse({
        status: 404,
        json: { error: { code: "FakeRouteNotFound", message: `${method} ${url.href}` } },
      });
    }
    const index = counters.get(route) ?? 0;
    counters.set(route, index + 1);
    const respond = route.respond;
    if (typeof respond === "function") {
      return toResponse(respond(call, index));
    }
    if (Array.isArray(respond)) {
      const fixture = respond[Math.min(index, respond.length - 1)];
      if (!fixture) {
        throw new Error("Fixture route has an empty response sequence");
      }
      return toResponse(fixture);
    }
    return toResponse(respond);
  }) as unknown as typeof fetch;

  return {
    fetch: fakeFetch,
    calls,
    callsTo: (method, urlIncludes) =>
      calls.filter((c) => c.method === method.toUpperCase() && c.url.includes(urlIncludes)),
    client: (options = {}) =>
      new FetchGraphClient({
        accessTokenProvider: async () => "test-token",
        fetchImpl: fakeFetch,
        sleep: async () => {},
        random: () => 0,
        ...options,
      }),
  };
}

/** A Graph-shaped error body. */
export function graphError(
  code: string,
  message = code,
): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/** The $batch envelope Graph returns; sub-responses are computed per sub-request. */
export function batchEnvelope(
  call: RecordedCall,
  answer: (sub: { id: string; method: string; url: string; body?: unknown }) => {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
  },
): FixtureResponse {
  const payload = call.json as {
    requests: Array<{ id: string; method: string; url: string; body?: unknown }>;
  };
  return {
    status: 200,
    json: { responses: payload.requests.map((sub) => ({ id: sub.id, ...answer(sub) })) },
  };
}

/** Narrow an optional value in tests without non-null assertions. */
export function must<T>(value: T | undefined | null, what = "value"): T {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${what} to be present`);
  }
  return value;
}
