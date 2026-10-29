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
import { JobAbortedError } from "../engine/chunkstore.js";
import { isTransientTransferError } from "../storage/transfer.js";
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
  /**
   * Called once per request when Graph answers 401 or 403, with the token the refused request
   * was sent with. True when the provider no longer hands out that token (it dropped it now, or
   * a concurrent refusal already replaced it): the request is sent once more with the current
   * one, which carries permissions granted since the old one was issued. Without it, a refusal
   * is returned as it is. A `$batch` whose sub-requests were refused asks the same once.
   */
  refreshAccessToken?: (refusedToken?: string) => boolean;
  baseUrl?: string;
  /** Injectable fetch (defaults to the global). */
  fetchImpl?: typeof fetch;
  /** Max retry attempts for throttled/again-later responses. */
  maxRetries?: number;
  maxBatchSize?: number;
  /** Base backoff in ms when no Retry-After is provided. */
  baseBackoffMs?: number;
  /**
   * Upper bound on a single exponential backoff wait, in ms. A server's Retry-After is
   * honoured beyond it, up to `maxRetryAfterMs`, only when the client has a `signal`.
   */
  maxBackoffMs?: number;
  /**
   * Upper bound on honouring a server's Retry-After, in ms. Defaults to
   * {@link MAX_RETRY_AFTER_MS} for a client with a `signal` (a job, whose wait ends when it
   * is cancelled), else to `maxBackoffMs`, so an interactive request without a signal is
   * not parked for minutes.
   */
  maxRetryAfterMs?: number;
  /** Injectable sleep (defaults to setTimeout); tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG in [0, 1) for jitter (defaults to Math.random). */
  random?: () => number;
  /**
   * Called whenever the client waits because Graph asked it to (429/503/504) or did not
   * answer in time, so the job layer can surface "waiting for Graph (Retry-After 32 s)"
   * honestly instead of appearing stuck. Not called for the backoff after a broken
   * connection (reset, DNS), which is not Graph throttling.
   */
  onThrottle?: (info: ThrottleInfo) => void;
  /**
   * Aborts every request and every throttling wait, e.g. the job's signal when
   * it is cancelled, reaches its time limit or the worker stops (#47).
   */
  signal?: AbortSignal;
  /**
   * How long one attempt may wait for Graph to answer (status and headers), in
   * ms; a request that hangs fails and is retried instead of holding the job.
   * Reading a streamed body is not limited by it. Default 5 minutes.
   */
  responseTimeoutMs?: number;
}

/** Graph did not send status and headers within the response timeout. */
export class GraphResponseTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(
      `Microsoft Graph did not answer within ${Math.round(timeoutMs / 1000)} s (${redactUrl(url)})`,
    );
    this.name = "GraphResponseTimeoutError";
  }

  /** Classified like undici's own header timeout: a transient timeout (failures/classify.ts). */
  get code(): string {
    return "UND_ERR_HEADERS_TIMEOUT";
  }
}

/** The URL without its query string, which may carry tokens (download and upload links). */
function redactUrl(url: string): string {
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

/** Default {@link GraphClientOptions.responseTimeoutMs}. */
export const GRAPH_RESPONSE_TIMEOUT_MS = 5 * 60_000;

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
 * Upper bound on honouring a server's Retry-After, in ms. Exchange answers mailbox
 * concurrency throttling with Retry-After of several minutes, and a retry before that
 * is refused again (and can extend the penalty), so the server's value wins over
 * `maxBackoffMs`. The bound only keeps a nonsensical value (hours) from parking a
 * worker; the wait still ends at once when the job is cancelled or times out (signal).
 */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

/**
 * Compute how long to wait before a retry. Uses Retry-After when present (up to
 * `maxRetryAfterMs`, default {@link MAX_RETRY_AFTER_MS}), else an exponential backoff capped at `maxMs`, and
 * adds jitter of up to one base interval.
 */
export function computeBackoffMs(
  attempt: number,
  retryAfterMs: number | null,
  options: { baseMs: number; maxMs: number; random: () => number; maxRetryAfterMs?: number },
): number {
  const jitter = options.random() * options.baseMs;
  if (retryAfterMs !== null) {
    return Math.min(options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS, retryAfterMs) + jitter;
  }
  return Math.min(options.maxMs, options.baseMs * 2 ** attempt) + jitter;
}

/** Methods that change nothing on the server, so a request lost on the wire may be sent again. */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

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
  private readonly refreshAccessToken: ((refusedToken?: string) => boolean) | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly maxBatchSize: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onThrottle: ((info: ThrottleInfo) => void) | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly responseTimeoutMs: number;
  private readonly maxRetryAfterMs: number;

  constructor(options: GraphClientOptions) {
    this.accessTokenProvider = options.accessTokenProvider;
    this.refreshAccessToken = options.refreshAccessToken;
    this.baseUrl = (options.baseUrl ?? GRAPH_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 5;
    this.maxBatchSize = Math.min(MAX_BATCH_SIZE, options.maxBatchSize ?? MAX_BATCH_SIZE);
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.onThrottle = options.onThrottle;
    this.signal = options.signal;
    this.responseTimeoutMs = options.responseTimeoutMs ?? GRAPH_RESPONSE_TIMEOUT_MS;
    // Minutes-long Retry-After waits only where a signal can end them (worker jobs).
    this.maxRetryAfterMs =
      options.maxRetryAfterMs ?? (options.signal ? MAX_RETRY_AFTER_MS : this.maxBackoffMs);
  }

  /** A wait that ends early, with the signal's reason, when the client is aborted. */
  private async pause(ms: number): Promise<void> {
    const signal = this.signal;
    if (!signal) {
      await this.sleep(ms);
      return;
    }
    if (signal.aborted) {
      throw new JobAbortedError();
    }
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        this.sleep(ms),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new JobAbortedError());
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  /**
   * One fetch, aborted by the client's signal at any time and by the response
   * timeout until the headers arrived (the body of a stream may take as long as
   * it takes).
   */
  private async fetchOnce(url: string, init: RequestInit): Promise<Response> {
    if (this.signal?.aborted) {
      throw new JobAbortedError();
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(new JobAbortedError());
    this.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new GraphResponseTimeoutError(url, this.responseTimeoutMs)),
      this.responseTimeoutMs,
    );
    timer.unref?.();
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      // The reason the request was aborted, not fetch's generic AbortError.
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(timer);
      // One listener per request would pile up on a job's signal; the engines
      // check the signal between items, so a body being read finishes first.
      this.signal?.removeEventListener("abort", onAbort);
    }
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
    report = true,
  ) {
    const retryAfterMs = parseRetryAfter(retryAfter);
    const waitMs = computeBackoffMs(attempt, retryAfterMs, {
      baseMs: this.baseBackoffMs,
      maxMs: this.maxBackoffMs,
      random: this.random,
      maxRetryAfterMs: this.maxRetryAfterMs,
    });
    if (report) {
      this.onThrottle?.({ status, attempt, waitMs, retryAfterMs, url });
    }
    await this.pause(waitMs);
  }

  /** The retry loop shared by {@link request} and {@link stream}. */
  private async send(req: GraphRequest, retryOnNetworkError?: boolean): Promise<Response> {
    return (await this.sendTracked(req, retryOnNetworkError)).response;
  }

  /**
   * {@link send}, also handing back the token the final attempt was sent with (undefined
   * without auth), so a `$batch` can name it when its sub-requests were refused.
   *
   * A connection-level failure before any response (reset, socket closed, DNS hiccup) is
   * retried with backoff like a 503 when the request changes nothing: an idempotent method,
   * or `retryOnNetworkError` (a `$batch` that only reads). Anything else is thrown at once,
   * since the request may have reached Graph.
   */
  private async sendTracked(
    req: GraphRequest,
    retryOnNetworkError = IDEMPOTENT_METHODS.has(req.method.toUpperCase()),
  ): Promise<{ response: Response; sentToken: string | undefined }> {
    const url = this.resolveUrl(req.url);
    const useAuth = req.auth !== false && this.isGraphOrigin(url);
    const hasRawBody = req.rawBody !== undefined;
    const hasJsonBody = !hasRawBody && req.body !== undefined;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
        ...req.headers,
      };
      let sentToken: string | undefined;
      if (useAuth) {
        sentToken = await this.accessTokenProvider();
        headers.Authorization = `Bearer ${sentToken}`;
      }
      let response: Response;
      try {
        response = await this.fetchOnce(url, {
          method: req.method,
          headers,
          body: hasRawBody ? req.rawBody : hasJsonBody ? JSON.stringify(req.body) : undefined,
        });
      } catch (error) {
        // Graph did not answer in time: like a 504, retried with backoff.
        if (error instanceof GraphResponseTimeoutError && attempt < this.maxRetries) {
          await this.waitForRetry(504, attempt, url, null);
          continue;
        }
        // The connection broke before Graph answered; JobAbortedError and AbortError are
        // never transient, so a cancelled job is not sent again.
        if (
          retryOnNetworkError &&
          attempt < this.maxRetries &&
          !this.signal?.aborted &&
          isTransientTransferError(error)
        ) {
          // Back off as for a 503, but Graph never answered: not reported as throttling.
          await this.waitForRetry(503, attempt, url, null, false);
          continue;
        }
        throw error;
      }

      if (
        useAuth &&
        !refreshed &&
        (response.status === 401 || response.status === 403) &&
        this.refreshAccessToken?.(sentToken)
      ) {
        // Refused with a token that may predate a permission granted since: once more, fresh.
        refreshed = true;
        await response.text().catch(() => undefined);
        continue;
      }
      if (RETRYABLE_STATUSES.has(response.status) && attempt < this.maxRetries) {
        // Drain the body so the connection can be reused before we wait.
        await response.text().catch(() => undefined);
        await this.waitForRetry(response.status, attempt, url, response.headers.get("retry-after"));
        continue;
      }
      return { response, sentToken };
    }
  }

  async request<T = unknown>(req: GraphRequest): Promise<GraphResponse<T>> {
    return (await this.requestTracked<T>(req)).result;
  }

  private async requestTracked<T>(
    req: GraphRequest,
    retryOnNetworkError?: boolean,
  ): Promise<{ result: GraphResponse<T>; sentToken: string | undefined }> {
    const { response, sentToken } = await this.sendTracked(req, retryOnNetworkError);
    const text = await response.text();
    const body = await parseBodyText<T>(text, response.headers.get("content-type") ?? "");
    return {
      result: { status: response.status, headers: headersToRecord(response.headers), body },
      sentToken,
    };
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
    // Graph refuses a whole $batch whose request ids repeat (400 "Request Id ... has to be
    // unique in a batch"; seen in production up to 2026-10-10 with message/folder ids, fixed
    // in 0f67c28/v0.3.2). Callers often use resource ids, which can repeat, so the batch
    // sends its own ids (the slot) and hands back the caller's. On top, an identical read
    // (same method, URL and headers, no body) is sent once and its answer given to every
    // caller that asked: a delta page that lists an item twice costs one sub-request, and a
    // retry or token refresh re-sends slots, never caller entries, so no id can repeat in
    // any round. Writes (POST/PATCH subscriptions) are never collapsed.
    const slotKeys = new Map<string, number>();
    const requests: BatchRequest[] = [];
    const slotOf: number[] = [];
    for (const r of callerRequests) {
      const key = batchDedupeKey(r);
      let slot = key === undefined ? undefined : slotKeys.get(key);
      if (slot === undefined) {
        slot = requests.length;
        requests.push({ ...r, id: String(slot) });
        if (key !== undefined) {
          slotKeys.set(key, slot);
        }
      }
      slotOf.push(slot);
    }
    const responses = new Map<string, BatchResponse>();
    let pending = requests;
    // Sub-requests refused (401/403) with a token that may predate a granted permission are
    // sent once more with a new one, like a single request in `send`; once per call.
    let refreshed = false;
    for (let attempt = 0; pending.length > 0; attempt++) {
      const throttled: BatchRequest[] = [];
      const refused: BatchRequest[] = [];
      let refusedToken: string | undefined;
      let longestRetryAfter: string | null = null;
      for (const group of chunkIntoBatches(pending, this.maxBatchSize)) {
        // A $batch of reads changes nothing, so a broken connection may send it again.
        const readOnly = group.every((r) => IDEMPOTENT_METHODS.has(r.method.toUpperCase()));
        const { result, sentToken } = await this.requestTracked<{ responses?: BatchResponse[] }>(
          { method: "POST", url: "/$batch", body: { requests: group.map(toBatchPayload) } },
          readOnly,
        );
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
          if (
            original &&
            !refreshed &&
            sentToken !== undefined &&
            this.refreshAccessToken &&
            (sub.status === 401 || sub.status === 403)
          ) {
            refused.push(original);
            refusedToken ??= sentToken;
          } else if (original && RETRYABLE_STATUSES.has(sub.status) && attempt < this.maxRetries) {
            throttled.push(original);
            longestRetryAfter = pickLongerRetryAfter(
              longestRetryAfter,
              normalised.headers["retry-after"] ?? null,
            );
          }
          responses.set(sub.id, normalised);
        }
      }
      // The refusals stay in `responses`: when the provider keeps its token they are the answer.
      let resend = false;
      if (refused.length > 0) {
        refreshed = true;
        resend = this.refreshAccessToken?.(refusedToken) === true;
      }
      pending = resend ? [...throttled, ...refused] : throttled;
      if (throttled.length > 0) {
        await this.waitForRetry(429, attempt, "/$batch", longestRetryAfter);
      }
    }
    // Keep the caller's order so results line up with the requests; a collapsed read
    // answers each of its callers under that caller's own id.
    return callerRequests.flatMap((r, index) => {
      const found = responses.get(String(slotOf[index]));
      return found ? [{ ...found, id: r.id }] : [];
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
/**
 * Identity of a sub-request that may be answered for several callers at once: only a read
 * without a body (method, URL, headers with lower-cased names in a fixed order). Undefined
 * for anything that writes, so two creations are always sent as two.
 */
export function batchDedupeKey(r: BatchRequest): string | undefined {
  const method = r.method.toUpperCase();
  if (!IDEMPOTENT_METHODS.has(method) || r.body !== undefined) {
    return undefined;
  }
  const headers = Object.entries(lowerCaseKeys(r.headers)).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return JSON.stringify([method, r.url, headers]);
}

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
