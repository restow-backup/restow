/**
 * Microsoft Graph client.
 *
 * Graph is the only Microsoft interface (see docs/MICROSOFT.md). This module owns
 * the throttling layer Restow needs: honour 429/503/504 with Retry-After plus jitter,
 * combine requests into $batch (max 20 per batch, throttled sub-responses are
 * retried individually), follow delta pages, and stream large bodies (MIME, file
 * downloads, upload-session fragments) without buffering them. The concrete client
 * is fetch-based and fully injectable, so tests never touch the network.
 */
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { GraphError } from "./errors.js";

/** Default Graph base URL. */
export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
/** Graph's hard limit on requests per $batch. */
export const MAX_BATCH_SIZE = 20;

/** A single Graph request. */
export interface GraphRequest {
  method: string;
  /** Absolute URL, or a path/relative URL resolved against the base URL. */
  url: string;
  headers?: Record<string, string>;
  /** JSON body; serialised with JSON.stringify and sent as application/json. */
  body?: unknown;
  /**
   * Raw body sent byte-for-byte (MIME uploads, file content, upload fragments).
   * Set the Content-Type through `headers`. Takes precedence over `body`.
   */
  rawBody?: string | Uint8Array;
  /**
   * Attach the bearer token (default true). Pre-authenticated URLs such as
   * `@microsoft.graph.downloadUrl` and upload-session URLs must be called with
   * `auth: false`; sending the token to those hosts is pointless and can leak it.
   * Belt and braces: the client itself never attaches the token to a URL
   * whose origin is not the configured Graph origin, whatever `auth` says —
   * see `FetchGraphClient`'s `isGraphOrigin`.
   */
  auth?: boolean;
}

/** A parsed Graph response. */
export interface GraphResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

/** A response whose body is left as a stream (2xx) or parsed as an error (non-2xx). */
export interface GraphStreamResponse {
  status: number;
  headers: Record<string, string>;
  /** Node readable of the body for 2xx responses, otherwise null. */
  body: Readable | null;
  /** Parsed error payload for non-2xx responses (JSON when Graph sent JSON, else text). */
  error?: unknown;
}

/** One sub-request inside a $batch. */
export interface BatchRequest {
  id: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** One sub-response from a $batch. */
export interface BatchResponse<T = unknown> {
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: T;
}

/** One page of a delta query. */
export interface DeltaPage<T = unknown> {
  value: T[];
  /** Link to the next page, if more pages follow. */
  nextLink?: string;
  /** Delta link to resume from next time, present on the final page. */
  deltaLink?: string;
}

/** The Graph surface the rest of Restow depends on. */
export interface GraphClient {
  /** Perform one request; resolves for every status code, callers inspect `status`. */
  request<T = unknown>(req: GraphRequest): Promise<GraphResponse<T>>;
  /** Perform one request and hand back the body as a stream instead of parsing it. */
  stream(req: GraphRequest): Promise<GraphStreamResponse>;
  /** Run requests through $batch (chunked to 20), retrying throttled sub-responses. */
  batch(requests: BatchRequest[]): Promise<BatchResponse[]>;
  /**
   * Follow a delta query page by page. Throws {@link GraphError} on a non-2xx page.
   * `headers` are sent with every page request (e.g. `Prefer: odata.maxpagesize=200`).
   */
  delta<T = unknown>(
    initialUrl: string,
    headers?: Record<string, string>,
  ): AsyncGenerator<DeltaPage<T>, void, unknown>;
}

export interface GraphClientOptions {
  /** Returns a valid bearer token; called before each attempt so refresh is transparent. */
  accessTokenProvider: () => Promise<string>;
  baseUrl?: string;
  /** Injectable fetch (defaults to the global). */
  fetchImpl?: typeof fetch;
  /** Max retry attempts for throttled/again-later responses. */
  maxRetries?: number;
  maxBatchSize?: number;
  /** Base backoff in ms when no Retry-After is provided. */
  baseBackoffMs?: number;
  /** Upper bound on a single backoff wait, in ms. */
  maxBackoffMs?: number;
  /** Injectable sleep (defaults to setTimeout); tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG in [0, 1) for jitter (defaults to Math.random). */
  random?: () => number;
  /**
   * Called whenever the client waits because of throttling, so the job layer can
   * surface "waiting for Graph (Retry-After 32 s)" honestly instead of appearing stuck.
   */
  onThrottle?: (info: ThrottleInfo) => void;
}

/** Details of one throttling wait. */
export interface ThrottleInfo {
  status: number;
  attempt: number;
  waitMs: number;
  retryAfterMs: number | null;
  url: string;
}

/** Status codes that mean "try again later" rather than "you did something wrong". */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 503, 504]);

/** Split a list of items into batches no larger than `size` (clamped to 1..MAX_BATCH_SIZE). */
export function chunkIntoBatches<T>(items: T[], size: number): T[][] {
  const limit = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(size)));
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += limit) {
    batches.push(items.slice(i, i + limit));
  }
  return batches;
}

/**
 * Parse a Retry-After header into milliseconds. Supports both delta-seconds and an
 * HTTP-date. Returns null when absent or unparseable.
 */
export function parseRetryAfter(headerValue: string | null | undefined): number | null {
  if (!headerValue) {
    return null;
  }
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}

/**
 * Compute how long to wait before a retry. Uses Retry-After when present, else an
 * exponential backoff, and adds jitter of up to one base interval. The result is
 * capped at `maxMs` (plus the jitter allowance).
 */
export function computeBackoffMs(
  attempt: number,
  retryAfterMs: number | null,
  options: { baseMs: number; maxMs: number; random: () => number },
): number {
  const exponential = Math.min(options.maxMs, options.baseMs * 2 ** attempt);
  const base = retryAfterMs ?? exponential;
  const jitter = options.random() * options.baseMs;
  return Math.min(options.maxMs + options.baseMs, base + jitter);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Lower-case a fetch Headers object into a plain record. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function lowerCaseKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    record[key.toLowerCase()] = value;
  }
  return record;
}

/** Parse a body the way Graph sends it: JSON when declared, otherwise text, empty → undefined. */
async function parseBodyText<T>(text: string, contentType: string): Promise<T> {
  if (text.length === 0) {
    return undefined as T;
  }
  if (contentType.includes("json")) {
    return JSON.parse(text) as T;
  }
  return text as unknown as T;
}

/** Minimal fetch-based {@link GraphClient} with the throttling layer built in. */
export class FetchGraphClient implements GraphClient {
  private readonly accessTokenProvider: () => Promise<string>;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly maxBatchSize: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onThrottle: ((info: ThrottleInfo) => void) | undefined;

  constructor(options: GraphClientOptions) {
    this.accessTokenProvider = options.accessTokenProvider;
    this.baseUrl = (options.baseUrl ?? GRAPH_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 5;
    this.maxBatchSize = Math.min(MAX_BATCH_SIZE, options.maxBatchSize ?? MAX_BATCH_SIZE);
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.onThrottle = options.onThrottle;
  }

  private resolveUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    return `${this.baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  /**
   * Whether `url` is actually Graph, by origin. `req.auth` is the caller's
   * intent ("this needs the app token"); this is the client's own check of
   * where the token would actually go, and it wins over that intent — a
   * caller can forget to pass `auth: false` for a URL it did not fully
   * control (a stored Graph delta/next link, `graph/delta.ts`, ultimately
   * read back from a snapshot manifest), and this product's app-only token
   * reaches every mailbox and drive of the whole M365 tenant, so it must
   * never leave for anywhere but Graph itself.
   */
  private isGraphOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.baseUrl).origin;
    } catch {
      return false;
    }
  }

  private async waitForRetry(
    status: number,
    attempt: number,
    url: string,
    retryAfter: string | null,
  ) {
    const retryAfterMs = parseRetryAfter(retryAfter);
    const waitMs = computeBackoffMs(attempt, retryAfterMs, {
      baseMs: this.baseBackoffMs,
      maxMs: this.maxBackoffMs,
      random: this.random,
    });
    this.onThrottle?.({ status, attempt, waitMs, retryAfterMs, url });
    await this.sleep(waitMs);
  }

  /** The retry loop shared by {@link request} and {@link stream}. */
  private async send(req: GraphRequest): Promise<Response> {
    const url = this.resolveUrl(req.url);
    const useAuth = req.auth !== false && this.isGraphOrigin(url);
    const hasRawBody = req.rawBody !== undefined;
    const hasJsonBody = !hasRawBody && req.body !== undefined;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
        ...req.headers,
      };
      if (useAuth) {
        headers.Authorization = `Bearer ${await this.accessTokenProvider()}`;
      }
      const response = await this.fetchImpl(url, {
        method: req.method,
        headers,
        body: hasRawBody ? req.rawBody : hasJsonBody ? JSON.stringify(req.body) : undefined,
      });

      if (RETRYABLE_STATUSES.has(response.status) && attempt < this.maxRetries) {
        // Drain the body so the connection can be reused before we wait.
        await response.text().catch(() => undefined);
        await this.waitForRetry(response.status, attempt, url, response.headers.get("retry-after"));
        continue;
      }
      return response;
    }
  }

  async request<T = unknown>(req: GraphRequest): Promise<GraphResponse<T>> {
    const response = await this.send(req);
    const text = await response.text();
    const body = await parseBodyText<T>(text, response.headers.get("content-type") ?? "");
    return { status: response.status, headers: headersToRecord(response.headers), body };
  }

  async stream(req: GraphRequest): Promise<GraphStreamResponse> {
    const response = await this.send(req);
    const headers = headersToRecord(response.headers);
    if (!response.ok) {
      const text = await response.text();
      const error = await parseBodyText<unknown>(text, headers["content-type"] ?? "");
      return { status: response.status, headers, body: null, error };
    }
    const body =
      response.body === null
        ? Readable.from([])
        : Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
    return { status: response.status, headers, body };
  }

  async batch(callerRequests: BatchRequest[]): Promise<BatchResponse[]> {
    // Graph refuses a whole $batch whose request ids repeat (400 "has to be unique
    // in a batch"). Callers often use resource ids, which can repeat, so the
    // batch sends its own ids (the position) and hands back the caller's.
    const requests = callerRequests.map((r, index) => ({ ...r, id: String(index) }));
    const responses = new Map<string, BatchResponse>();
    let pending = requests;
    for (let attempt = 0; pending.length > 0; attempt++) {
      const throttled: BatchRequest[] = [];
      let longestRetryAfter: string | null = null;
      for (const group of chunkIntoBatches(pending, this.maxBatchSize)) {
        const result = await this.request<{ responses?: BatchResponse[] }>({
          method: "POST",
          url: "/$batch",
          body: { requests: group.map(toBatchPayload) },
        });
        if (result.status >= 400) {
          throw new GraphError({
            status: result.status,
            method: "POST",
            url: "/$batch",
            headers: result.headers,
            payload: result.body,
          });
        }
        for (const sub of result.body.responses ?? []) {
          const normalised = { ...sub, headers: lowerCaseKeys(sub.headers) };
          const original = group.find((r) => r.id === sub.id);
          if (original && RETRYABLE_STATUSES.has(sub.status) && attempt < this.maxRetries) {
            throttled.push(original);
            longestRetryAfter = pickLongerRetryAfter(
              longestRetryAfter,
              normalised.headers["retry-after"] ?? null,
            );
          }
          responses.set(sub.id, normalised);
        }
      }
      pending = throttled;
      if (pending.length > 0) {
        await this.waitForRetry(429, attempt, "/$batch", longestRetryAfter);
      }
    }
    // Keep the caller's order so results line up with the requests.
    return requests.flatMap((r, index) => {
      const found = responses.get(r.id);
      const callerId = callerRequests[index]?.id ?? r.id;
      return found ? [{ ...found, id: callerId }] : [];
    });
  }

  async *delta<T = unknown>(
    initialUrl: string,
    headers?: Record<string, string>,
  ): AsyncGenerator<DeltaPage<T>, void, unknown> {
    let url: string | undefined = initialUrl;
    while (url) {
      const result: GraphResponse<{
        value?: T[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      }> = await this.request({ method: "GET", url, headers });
      if (result.status < 200 || result.status >= 300) {
        throw new GraphError({
          status: result.status,
          method: "GET",
          url,
          headers: result.headers,
          payload: result.body,
        });
      }
      const nextLink: string | undefined = result.body["@odata.nextLink"];
      yield {
        value: result.body.value ?? [],
        nextLink,
        deltaLink: result.body["@odata.deltaLink"],
      };
      url = nextLink;
    }
  }
}

/** Graph requires an explicit Content-Type on batch sub-requests that carry a body. */
function toBatchPayload(r: BatchRequest) {
  const headers =
    r.body !== undefined &&
    !Object.keys(r.headers ?? {}).some((h) => h.toLowerCase() === "content-type")
      ? { ...r.headers, "Content-Type": "application/json" }
      : r.headers;
  return { id: r.id, method: r.method, url: r.url, headers, body: r.body };
}

function pickLongerRetryAfter(current: string | null, candidate: string | null): string | null {
  const currentMs = parseRetryAfter(current);
  const candidateMs = parseRetryAfter(candidate);
  if (candidateMs === null) {
    return current;
  }
  if (currentMs === null || candidateMs > currentMs) {
    return candidate;
  }
  return current;
}
