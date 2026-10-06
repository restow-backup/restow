/**
 * Webhook delivery (docs/ARCHITECTURE.md, "API"): signed HTTP POSTs to the
 * tenants' webhooks, retried with backoff, every attempt visible in the
 * delivery log.
 *
 * Webhooks are not a pg-boss queue. The `webhook_deliveries` table is the
 * queue and the log in one: producers (the API's lib/webhooks.ts, and
 * {@link emitWebhookEvent} here for worker-side events such as job.completed)
 * insert `pending` rows, and the {@link WebhookDispatcher} started by
 * {@link webhooksHandler} polls for due rows, claims them with
 * `FOR UPDATE SKIP LOCKED` plus a lease (so several worker processes never
 * send the same attempt twice, and a crashed one only delays it), delivers
 * and records the outcome. Delivery is at-least-once; receivers deduplicate
 * by the envelope `id` or the `X-Restow-Delivery` header.
 *
 * Every request carries
 *
 *   Content-Type: application/json
 *   X-Restow-Event: job.failed
 *   X-Restow-Delivery: <delivery id>
 *   X-Restow-Attempt: <n>
 *   X-Restow-Signature: sha256=<hex HMAC-SHA-256 of the raw body under the webhook secret>
 *
 * in the `restow` format. A webhook in a chat format (`discord`, `slack`,
 * `teams`, see ./webhook-formats.ts) gets a readable message rendered from the
 * stored envelope instead, with Content-Type and User-Agent only: those
 * services cannot check a signature. Their answers 400, 401, 403, 404, 410,
 * 413 and 422 mean the URL or the message is wrong (a deleted Discord webhook
 * answers 404), so such a delivery is given up at once instead of retried for
 * a day; 429 and 5xx are retried, honouring Retry-After.
 *
 * Targets are checked after DNS resolution, at connect time: loopback and
 * private networks only with RESTOW_WEBHOOK_ALLOW_PRIVATE=true, link-local
 * (cloud metadata), multicast and reserved ranges never. Redirects are not
 * followed. Logs name the target host only: some receivers carry their token
 * in the URL.
 *
 * The event list, envelope layout and retry budget mirror
 * apps/api/src/lib/webhooks.ts; keep both in step.
 */
import { createHmac, randomUUID } from "node:crypto";
import { type LookupAddress, lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { type LookupFunction, isIP } from "node:net";
import {
  type Database,
  type Job,
  protectedObjects,
  safeErrorMessage,
  settings,
  tenants,
  webhookDeliveries,
  webhooks,
} from "@restow/db";
import { type SupportedLanguage, defaultLanguage } from "@restow/i18n";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
  PgSecretReader,
  type WorkerRuntime,
  isUuid,
  tenantRunner,
  withTenantTx,
} from "./framework.js";
import {
  type ChatContext,
  type WebhookFormat,
  buildChatMessage,
  isChatFormat,
  renderChatBody,
} from "./webhook-formats.js";

type Logger = WorkerRuntime["logger"];

// ---------------------------------------------------------------------------
// Contract (mirrors apps/api/src/lib/webhooks.ts)
// ---------------------------------------------------------------------------

/** Only events something raises; see the API's list. */
export const WEBHOOK_EVENTS = ["job.failed", "job.completed", "verify.completed"] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_PAYLOAD_VERSION = 1;

/** HTTP attempts per delivery before it is given up. */
export const WEBHOOK_MAX_ATTEMPTS = 8;

/** Finished deliveries stay in the log this long. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

export const WEBHOOK_HEADERS = {
  event: "X-Restow-Event",
  delivery: "X-Restow-Delivery",
  attempt: "X-Restow-Attempt",
  signature: "X-Restow-Signature",
} as const;

const USER_AGENT = "Restow-Webhooks/1";

// ---------------------------------------------------------------------------
// Emitting events from the worker
// ---------------------------------------------------------------------------

export interface WebhookEventInput {
  tenantId: string;
  event: WebhookEvent;
  /** Event details: ids, states, counts and timestamps; never secrets. */
  data: Record<string, unknown>;
  occurredAt?: Date;
}

export interface EmittedWebhookEvent {
  eventId: string;
  deliveryIds: string[];
}

/**
 * Queue `event` for every active webhook of the tenant that subscribed to it.
 * Runs in its own tenant-pinned transaction; nothing is sent here.
 */
export async function emitWebhookEvent(
  db: Database,
  input: WebhookEventInput,
): Promise<EmittedWebhookEvent> {
  const eventId = randomUUID();
  const envelope = {
    id: eventId,
    event: input.event,
    version: WEBHOOK_PAYLOAD_VERSION,
    createdAt: (input.occurredAt ?? new Date()).toISOString(),
    tenantId: input.tenantId,
    data: input.data,
  };
  return withTenantTx(db, input.tenantId, async (tx) => {
    const subscribed = await tx
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.tenantId, input.tenantId),
          eq(webhooks.active, true),
          sql`${input.event} = ANY(${webhooks.events})`,
        ),
      );
    if (subscribed.length === 0) {
      return { eventId, deliveryIds: [] };
    }
    const now = new Date();
    const rows = await tx
      .insert(webhookDeliveries)
      .values(
        subscribed.map((webhook) => ({
          tenantId: input.tenantId,
          webhookId: webhook.id,
          event: input.event,
          payload: envelope,
          status: "pending" as const,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning({ id: webhookDeliveries.id });
    return { eventId, deliveryIds: rows.map((row) => row.id) };
  });
}

type JobSummary = Pick<
  Job,
  "id" | "queue" | "status" | "protectedObjectId" | "startedAt" | "completedAt" | "errorMessage"
> &
  Partial<Pick<Job, "failure">>;

/** The event a job's final status raises; cancelled and unfinished jobs raise none. */
export function jobWebhookEvent(status: Job["status"]): WebhookEvent | null {
  if (status === "completed") {
    return "job.completed";
  }
  return status === "failed" ? "job.failed" : null;
}

/** The `data` of a job event: what an RMM needs to open or close a ticket. */
export function jobEventData(job: JobSummary): Record<string, unknown> {
  const duration =
    job.startedAt && job.completedAt ? job.completedAt.getTime() - job.startedAt.getTime() : null;
  return {
    job: {
      id: job.id,
      queue: job.queue,
      status: job.status,
      protectedObjectId: job.protectedObjectId,
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      durationMs: duration,
      errorMessage: job.status === "failed" ? job.errorMessage : null,
      // Why it failed, machine-readable: a stable code (e.g. graph.consent_missing), whether
      // waiting alone may help, and the parameters a ticket needs (permission, host, ...).
      failure: job.status === "failed" ? (job.failure ?? null) : null,
    },
  };
}

/** Emit job.completed / job.failed for a job that reached its final status. */
export async function emitJobWebhook(
  db: Database,
  tenantId: string,
  job: JobSummary,
): Promise<EmittedWebhookEvent | null> {
  const event = jobWebhookEvent(job.status);
  if (!event) {
    return null;
  }
  return emitWebhookEvent(db, {
    tenantId,
    event,
    data: jobEventData(job),
    occurredAt: job.completedAt ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/** `sha256=<hex>`: HMAC-SHA-256 of the exact body bytes under the webhook secret. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** Headers of a chat delivery: the services read the body only, and nothing is signed. */
export function chatDeliveryHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "User-Agent": USER_AGENT };
}

export function deliveryHeaders(input: {
  event: string;
  deliveryId: string;
  attempt: number;
  signature: string;
}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    [WEBHOOK_HEADERS.event]: input.event,
    [WEBHOOK_HEADERS.delivery]: input.deliveryId,
    [WEBHOOK_HEADERS.attempt]: String(input.attempt),
    [WEBHOOK_HEADERS.signature]: input.signature,
  };
}

// ---------------------------------------------------------------------------
// Retry schedule
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Wait after the n-th failed attempt (index n-1): about 22 hours in total, so
 * a receiver that is down for a day still gets every event.
 */
export const RETRY_DELAYS_MS = [
  1 * MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  1 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
] as const;

/** Spread of each wait (±10 %), so a recovering receiver is not hit by every retry at once. */
export const RETRY_JITTER = 0.1;

const MAX_RETRY_DELAY_MS = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 12 * HOUR;

/** Delay before the attempt after `attemptsMade` failed ones. */
export function retryDelayMs(attemptsMade: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(attemptsMade, 1), RETRY_DELAYS_MS.length) - 1;
  const base = RETRY_DELAYS_MS[index] ?? MAX_RETRY_DELAY_MS;
  const spread = (random() * 2 - 1) * RETRY_JITTER;
  return Math.round(base * (1 + spread));
}

/** A `Retry-After` header (seconds or HTTP date) in milliseconds, capped at the longest delay. */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | null {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }
  let ms: number;
  // Whole seconds per RFC 9110; some chat services send fractions (Discord: "0.35").
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    ms = Math.ceil(Number(raw) * 1000);
  } else {
    const at = Date.parse(raw);
    if (Number.isNaN(at)) {
      return null;
    }
    ms = at - now.getTime();
  }
  return ms > 0 ? Math.min(ms, MAX_RETRY_DELAY_MS) : null;
}

// ---------------------------------------------------------------------------
// Failures and the stored error format
// ---------------------------------------------------------------------------

/** Codes of `webhook_deliveries.last_error` (parsed by apps/api features/webhooks/delivery-error.ts). */
export type DeliveryErrorCode =
  | "http_error"
  | "redirect"
  | "timeout"
  | "connection_failed"
  | "dns_failed"
  | "tls_failed"
  | "blocked_address"
  | "invalid_url"
  | "secret_missing"
  | "webhook_disabled"
  | "internal";

/** A failed attempt, with what the log shows about it. */
export class DeliveryFailure extends Error {
  constructor(
    readonly code: DeliveryErrorCode,
    readonly detail: string | null = null,
    readonly httpStatus: number | null = null,
    /** From the receiver's Retry-After, when it named one. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DeliveryFailure";
  }
}

/** The shutdown interrupted the attempt: nothing is recorded, the lease brings it back. */
export class DeliveryInterrupted extends Error {
  constructor() {
    super("webhook delivery interrupted by shutdown");
    this.name = "DeliveryInterrupted";
  }
}

const DETAIL_MAX_LENGTH = 300;

/** One line of printable text, at most 300 characters. */
export function sanitizeDetail(value: string): string {
  const flat = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > DETAIL_MAX_LENGTH ? `${flat.slice(0, DETAIL_MAX_LENGTH - 1)}…` : flat;
}

/** `<code>[ <status>][: <detail>]` */
export function formatDeliveryError(failure: DeliveryFailure): string {
  const status = failure.httpStatus !== null ? ` ${failure.httpStatus}` : "";
  const detail = failure.detail ? `: ${sanitizeDetail(failure.detail)}` : "";
  return `${failure.code}${status}${detail}`;
}

const PERMANENT_CODES: ReadonlySet<DeliveryErrorCode> = new Set([
  "blocked_address",
  "invalid_url",
  "secret_missing",
  "webhook_disabled",
]);

/**
 * Answers of a chat service that a retry cannot change: a malformed or
 * oversized message (400, 413, 422), a URL whose token is wrong, revoked or
 * deleted (401, 403, 404), a channel that is gone (410). 408, 429 and 5xx
 * stay retryable.
 */
export const CHAT_PERMANENT_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 410, 413, 422,
]);

/**
 * Failures a retry cannot fix: configuration problems, 410 Gone, and for a
 * chat format the answers in {@link CHAT_PERMANENT_STATUSES}. An own receiver
 * (`restow`) may answer 4xx while it is being deployed, so it keeps its
 * retries.
 */
export function isPermanentFailure(
  failure: DeliveryFailure,
  format: WebhookFormat = "restow",
): boolean {
  if (PERMANENT_CODES.has(failure.code)) {
    return true;
  }
  if (failure.code !== "http_error" || failure.httpStatus === null) {
    return false;
  }
  if (failure.httpStatus === 410) {
    return true;
  }
  return isChatFormat(format) && CHAT_PERMANENT_STATUSES.has(failure.httpStatus);
}

export interface ReceiverResponse {
  status: number;
  /** The start of the response body (at most a few hundred bytes). */
  body: string;
  retryAfter: string | null;
}

/** 2xx is success; a redirect is not followed; everything else is an HTTP error. */
export function failureForResponse(response: ReceiverResponse, now: Date): DeliveryFailure | null {
  if (response.status >= 200 && response.status < 300) {
    return null;
  }
  if (response.status >= 300 && response.status < 400) {
    return new DeliveryFailure("redirect", null, response.status);
  }
  const body = sanitizeDetail(response.body);
  return new DeliveryFailure(
    "http_error",
    body.length > 0 ? body : null,
    response.status,
    parseRetryAfter(response.retryAfter, now),
  );
}

const TLS_ERROR =
  /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;

/** Map a transport error (errno, TLS, abort) onto the stored codes. */
export function failureForError(error: unknown, timedOut: boolean): DeliveryFailure {
  if (error instanceof DeliveryFailure) {
    return error;
  }
  if (timedOut) {
    return new DeliveryFailure("timeout");
  }
  const code = (error as { code?: unknown } | null)?.code;
  const name = typeof code === "string" ? code : error instanceof Error ? error.name : "Error";
  if (name === "ENOTFOUND" || name === "EAI_AGAIN" || name === "ENODATA") {
    return new DeliveryFailure("dns_failed", name);
  }
  if (name === "ETIMEDOUT" || name === "ESOCKETTIMEDOUT") {
    return new DeliveryFailure("timeout");
  }
  if (TLS_ERROR.test(name)) {
    return new DeliveryFailure("tls_failed", name);
  }
  return new DeliveryFailure("connection_failed", name);
}

// ---------------------------------------------------------------------------
// Target address policy
// ---------------------------------------------------------------------------

export type AddressClass =
  | "public"
  | "private"
  | "loopback"
  | "link_local"
  | "unspecified"
  | "multicast"
  | "reserved";

function parseIPv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function classifyIPv4([a = 0, b = 0, c = 0]: number[]): AddressClass {
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link_local";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return "public";
}

/** Eight 16-bit groups of an IPv6 address (zone id dropped, embedded IPv4 expanded). */
function parseIPv6(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0] ?? "";
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) {
      return null;
    }
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 2 && missing < 1) || (halves.length === 1 && missing !== 0)) {
    return null;
  }
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const values = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN,
  );
  return values.length === 8 && values.every((value) => !Number.isNaN(value)) ? values : null;
}

function embeddedIPv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function classifyIPv6(g: number[]): AddressClass {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (firstFiveZero && g5 === 0 && g6 === 0) {
    if (g7 === 0) return "unspecified";
    if (g7 === 1) return "loopback";
  }
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses.
  if (firstFiveZero && (g5 === 0xffff || g5 === 0)) {
    return classifyIPv4(embeddedIPv4(g6, g7));
  }
  // NAT64 (64:ff9b::/96) reaches IPv4 hosts: judge the IPv4 address.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyIPv4(embeddedIPv4(g6, g7));
  }
  // 6to4 (2002::/16) embeds the IPv4 address in the next 32 bits.
  if (g0 === 0x2002) {
    return classifyIPv4(embeddedIPv4(g1, g2));
  }
  if ((g0 & 0xffc0) === 0xfe80) return "link_local";
  if ((g0 & 0xfe00) === 0xfc00) return "private";
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  if (g0 === 0x2001 && g1 === 0x0db8) return "reserved";
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return "reserved";
  return "public";
}

/** Classify a literal IPv4 or IPv6 address; anything unparseable counts as reserved. */
export function classifyAddress(address: string): AddressClass {
  const bare = address.replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(bare);
  if (v4) {
    return classifyIPv4(v4);
  }
  const v6 = parseIPv6(bare);
  return v6 ? classifyIPv6(v6) : "reserved";
}

/** Public addresses always; loopback and private networks only when the operator allows them. */
export function isAddressAllowed(address: string, allowPrivateNetworks: boolean): boolean {
  const kind = classifyAddress(address);
  if (kind === "public") {
    return true;
  }
  return allowPrivateNetworks && (kind === "private" || kind === "loopback");
}

/**
 * A DNS lookup that refuses to hand out a disallowed address. Used as the
 * socket's `lookup`, so the address checked is the address connected to
 * (no gap for DNS rebinding).
 */
export function guardedLookup(allowPrivateNetworks: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, found) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      const addresses: LookupAddress[] = Array.isArray(found) ? found : [];
      const blocked = addresses.find(
        (entry) => !isAddressAllowed(entry.address, allowPrivateNetworks),
      );
      if (blocked || addresses.length === 0) {
        callback(new DeliveryFailure("blocked_address", blocked?.address ?? hostname), "", 0);
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const [first] = addresses;
      callback(null, first?.address ?? "", first?.family ?? 4);
    });
  };
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

export interface WebhookHttpRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /** Aborts on shutdown. */
  signal: AbortSignal;
}

/** Sends one request; resolves with any HTTP response, rejects with a DeliveryFailure. */
export type WebhookTransport = (request: WebhookHttpRequest) => Promise<ReceiverResponse>;

const RESPONSE_EXCERPT_BYTES = 1024;

/** The target of a webhook URL, checked before any socket is opened. */
export function checkTargetUrl(value: string, allowPrivateNetworks: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DeliveryFailure("invalid_url");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new DeliveryFailure("invalid_url");
  }
  // Literal addresses never go through the lookup, so they are judged here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !isAddressAllowed(host, allowPrivateNetworks)) {
    throw new DeliveryFailure("blocked_address", host);
  }
  return url;
}

/** node:http(s) transport with the address guard, a hard timeout and no redirects. */
export function createHttpTransport(options: { allowPrivateNetworks: boolean }): WebhookTransport {
  const lookup = guardedLookup(options.allowPrivateNetworks);
  return (request) =>
    new Promise<ReceiverResponse>((resolve, reject) => {
      if (request.signal.aborted) {
        reject(new DeliveryInterrupted());
        return;
      }
      let url: URL;
      try {
        url = checkTargetUrl(request.url, options.allowPrivateNetworks);
      } catch (error) {
        reject(error);
        return;
      }
      const timeout = AbortSignal.timeout(request.timeoutMs);
      const signal = AbortSignal.any([request.signal, timeout]);
      const client = url.protocol === "https:" ? https : http;
      const req = client.request(url, {
        method: "POST",
        headers: { ...request.headers, "Content-Length": String(Buffer.byteLength(request.body)) },
        lookup,
        signal,
        agent: false,
      });
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).subarray(0, RESPONSE_EXCERPT_BYTES).toString("utf8"),
            retryAfter:
              typeof res.headers["retry-after"] === "string" ? res.headers["retry-after"] : null,
          });
        res.on("data", (chunk: Buffer) => {
          if (size < RESPONSE_EXCERPT_BYTES) {
            chunks.push(chunk);
            size += chunk.length;
          }
          if (size >= RESPONSE_EXCERPT_BYTES) {
            // The excerpt is all the log keeps; do not download the rest.
            res.destroy();
          }
        });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      });
      req.on("error", (error) => {
        if (request.signal.aborted && !timeout.aborted) {
          reject(new DeliveryInterrupted());
          return;
        }
        reject(failureForError(error, timeout.aborted));
      });
      req.end(request.body);
    });
}

// ---------------------------------------------------------------------------
// Outcome of an attempt
// ---------------------------------------------------------------------------

export interface AttemptPlan {
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
}

/** What to record after an attempt: delivered, retry later, or give up. */
export function planAfterAttempt(input: {
  attemptsBefore: number;
  failure: DeliveryFailure | null;
  now: Date;
  random?: () => number;
  /** The webhook's format; decides which HTTP answers are final. */
  format?: WebhookFormat;
}): AttemptPlan {
  const attempts = input.attemptsBefore + 1;
  if (input.failure === null) {
    return {
      status: "delivered",
      attempts,
      lastError: null,
      nextAttemptAt: null,
      deliveredAt: input.now,
    };
  }
  const lastError = formatDeliveryError(input.failure);
  if (isPermanentFailure(input.failure, input.format) || attempts >= WEBHOOK_MAX_ATTEMPTS) {
    return { status: "failed", attempts, lastError, nextAttemptAt: null, deliveredAt: null };
  }
  const backoff = retryDelayMs(attempts, input.random);
  const wait = Math.max(backoff, input.failure.retryAfterMs ?? 0);
  return {
    status: "pending",
    attempts,
    lastError,
    nextAttemptAt: new Date(input.now.getTime() + wait),
    deliveredAt: null,
  };
}

// ---------------------------------------------------------------------------
// Storage of deliveries
// ---------------------------------------------------------------------------

export interface DueDelivery {
  id: string;
  tenantId: string;
}

export interface LoadedDelivery extends DueDelivery {
  webhookId: string;
  event: string;
  payload: Record<string, unknown>;
  attempts: number;
  url: string;
  active: boolean;
  secretRef: string | null;
  format: WebhookFormat;
}

export interface DeliveryStore {
  /** Claim up to `limit` due deliveries across tenants, leasing them until `leaseUntil`. */
  claimDue(now: Date, limit: number, leaseUntil: Date): Promise<DueDelivery[]>;
  /** The delivery with its webhook, or null when it (or its webhook) is gone. */
  load(due: DueDelivery): Promise<LoadedDelivery | null>;
  record(due: DueDelivery, plan: AttemptPlan, now: Date): Promise<void>;
  /** Delete finished deliveries last touched before `before`; returns how many. */
  prune(before: Date): Promise<number>;
}

/**
 * Postgres store. Claiming and pruning span tenants and run on the provider
 * role (BYPASSRLS), like the scheduler; everything about one delivery runs
 * in a transaction pinned to its tenant.
 */
export class PgDeliveryStore implements DeliveryStore {
  constructor(private readonly db: Database) {}

  async claimDue(now: Date, limit: number, leaseUntil: Date): Promise<DueDelivery[]> {
    const result = await this.db.execute(sql`
      UPDATE ${webhookDeliveries} AS d
      SET next_attempt_at = ${leaseUntil.toISOString()}::timestamptz,
          updated_at = ${now.toISOString()}::timestamptz
      WHERE d.id IN (
        SELECT id FROM ${webhookDeliveries}
        WHERE status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now.toISOString()}::timestamptz)
        ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d.id, d.tenant_id
    `);
    return (result.rows as { id: string; tenant_id: string }[]).map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
    }));
  }

  async load(due: DueDelivery): Promise<LoadedDelivery | null> {
    if (!isUuid(due.tenantId)) {
      return null;
    }
    const [row] = await withTenantTx(this.db, due.tenantId, (tx) =>
      tx
        .select({
          id: webhookDeliveries.id,
          tenantId: webhookDeliveries.tenantId,
          webhookId: webhookDeliveries.webhookId,
          event: webhookDeliveries.event,
          payload: webhookDeliveries.payload,
          attempts: webhookDeliveries.attempts,
          url: webhooks.url,
          active: webhooks.active,
          secretRef: webhooks.secretRef,
          format: webhooks.format,
        })
        .from(webhookDeliveries)
        .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
        .where(and(eq(webhookDeliveries.tenantId, due.tenantId), eq(webhookDeliveries.id, due.id)))
        .limit(1),
    );
    return row ?? null;
  }

  async record(due: DueDelivery, plan: AttemptPlan, now: Date): Promise<void> {
    await withTenantTx(this.db, due.tenantId, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({
          status: plan.status,
          attempts: plan.attempts,
          lastError: plan.lastError,
          nextAttemptAt: plan.nextAttemptAt,
          deliveredAt: plan.deliveredAt,
          updatedAt: now,
        })
        .where(and(eq(webhookDeliveries.tenantId, due.tenantId), eq(webhookDeliveries.id, due.id))),
    );
  }

  async prune(before: Date): Promise<number> {
    const deleted = await this.db
      .delete(webhookDeliveries)
      .where(
        and(
          inArray(webhookDeliveries.status, ["delivered", "failed"]),
          lt(webhookDeliveries.updatedAt, before),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    return deleted.length;
  }
}

/** What a chat message needs besides the envelope: language, tenant name, link base, object name. */
export type ChatContextSource = (delivery: LoadedDelivery) => Promise<ChatContext>;

function originOf(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The protected object a job event names, when the event itself has no name for it. */
function jobObjectId(payload: Record<string, unknown>): string | null {
  const data = payload.data as { job?: { protectedObjectId?: unknown } } | undefined;
  const id = data?.job?.protectedObjectId;
  return typeof id === "string" && isUuid(id) ? id : null;
}

/**
 * Postgres source: the tenant's name and language (the installation default
 * when it has none, like the alert mails), the public URL from Settings (else
 * RESTOW_PUBLIC_URL) and the protected object's name. Reads run on the
 * dispatcher's installation pool, the tenant's rows tenant-pinned.
 */
export function pgChatContextSource(db: Database, env: Env = process.env): ChatContextSource {
  return async (delivery) => {
    const [installation] = await db
      .select({ publicUrl: settings.publicUrl })
      .from(settings)
      .limit(1);
    const objectId = jobObjectId(delivery.payload);
    const { tenant, objectName } = await withTenantTx(db, delivery.tenantId, async (tx) => {
      const [row] = await tx
        .select({ name: tenants.name, language: tenants.language })
        .from(tenants)
        .where(eq(tenants.id, delivery.tenantId))
        .limit(1);
      let name: string | null = null;
      if (objectId) {
        const [object] = await tx
          .select({
            displayName: protectedObjects.displayName,
            externalId: protectedObjects.externalId,
          })
          .from(protectedObjects)
          .where(
            and(
              eq(protectedObjects.tenantId, delivery.tenantId),
              eq(protectedObjects.id, objectId),
            ),
          )
          .limit(1);
        name = object ? object.displayName?.trim() || object.externalId : null;
      }
      return { tenant: row ?? null, objectName: name };
    });
    const language: SupportedLanguage = tenant?.language ?? defaultLanguage;
    return {
      language,
      tenantName: tenant?.name ?? delivery.tenantId,
      publicUrl: originOf(installation?.publicUrl) ?? originOf(env.RESTOW_PUBLIC_URL),
      objectName,
    };
  };
}

/** Opens a webhook's signing secret; null when the secret row is gone. */
export type SecretSource = (tenantId: string, secretRef: string) => Promise<string | null>;

/** Secrets sealed by the API under the tenant DEK, opened with the worker's keyrings. */
export function keyringSecretSource(runtime: Pick<WorkerRuntime, "db" | "keyrings">): SecretSource {
  return async (tenantId, secretRef) => {
    const keys = await runtime.keyrings.get(tenantId);
    return new PgSecretReader(tenantRunner(runtime.db, tenantId), tenantId, keys).get(secretRef);
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface WebhookDispatcherOptions {
  /** Pause between polls when nothing was due. */
  readonly pollIntervalMs: number;
  /** Deliveries claimed per poll. */
  readonly batchSize: number;
  /** Deliveries sent in parallel. */
  readonly concurrency: number;
  /** A claimed delivery is not claimed again for this long (covers crashes). */
  readonly leaseMs: number;
  /** Hard limit for one HTTP attempt, connect to last byte. */
  readonly timeoutMs: number;
  readonly allowPrivateNetworks: boolean;
  readonly retentionDays: number;
  readonly pruneIntervalMs: number;
}

export const DEFAULT_WEBHOOK_OPTIONS: WebhookDispatcherOptions = {
  pollIntervalMs: 5_000,
  batchSize: 20,
  concurrency: 4,
  leaseMs: 2 * MINUTE,
  timeoutMs: 10_000,
  allowPrivateNetworks: false,
  retentionDays: WEBHOOK_DELIVERY_RETENTION_DAYS,
  pruneIntervalMs: HOUR,
};

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number): number {
  const value = Number.parseInt(env[name]?.trim() ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Public demo mode (deploy/demo/README.md, `RESTOW_DEMO`): nothing the demo
 * does may leave the server, so the dispatcher never delivers (its `start()`
 * becomes a no-op, logged). The demo guard already refuses every request that
 * would create a webhook, so in practice there is nothing to deliver either
 * way; this is the second, independent line of defence.
 */
export function isDemoModeEnabled(env: Env = process.env): boolean {
  return (env.RESTOW_DEMO ?? "").trim().toLowerCase() === "true";
}

/**
 * Options from the environment:
 *   WEBHOOK_POLL_MS                 poll interval (default 5000)
 *   WEBHOOK_CONCURRENCY             parallel deliveries (default 4)
 *   WEBHOOK_TIMEOUT_MS              per-attempt timeout (default 10000)
 *   RESTOW_WEBHOOK_ALLOW_PRIVATE    true: allow loopback and private networks (default false)
 */
export function webhookOptionsFromEnv(env: Env = process.env): WebhookDispatcherOptions {
  return {
    ...DEFAULT_WEBHOOK_OPTIONS,
    pollIntervalMs: positiveInt(env, "WEBHOOK_POLL_MS", DEFAULT_WEBHOOK_OPTIONS.pollIntervalMs),
    concurrency: positiveInt(env, "WEBHOOK_CONCURRENCY", DEFAULT_WEBHOOK_OPTIONS.concurrency),
    timeoutMs: positiveInt(env, "WEBHOOK_TIMEOUT_MS", DEFAULT_WEBHOOK_OPTIONS.timeoutMs),
    allowPrivateNetworks: (env.RESTOW_WEBHOOK_ALLOW_PRIVATE ?? "").trim().toLowerCase() === "true",
  };
}

export interface WebhookDispatcherDeps {
  readonly store: DeliveryStore;
  readonly secrets: SecretSource;
  /** Loads what chat formats render with; without one, they render with neutral defaults. */
  readonly chatContext?: ChatContextSource;
  readonly transport: WebhookTransport;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly random?: () => number;
  /** Demo mode ({@link isDemoModeEnabled}): `start()` never polls. */
  readonly disabled?: boolean;
}

/** Host of a URL for logs (the path and query may carry the receiver's token). */
function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "invalid";
  }
}

/** Run `task` over `items` with at most `limit` in flight. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<unknown>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) {
        await task(item);
      }
    }
  });
  await Promise.all(lanes);
}

export class WebhookDispatcher {
  private readonly controller = new AbortController();
  private loop: Promise<void> | null = null;
  private lastPruneAt = 0;

  constructor(
    private readonly deps: WebhookDispatcherDeps,
    readonly options: WebhookDispatcherOptions = DEFAULT_WEBHOOK_OPTIONS,
  ) {}

  /** Aborted by {@link stop}; handed to every HTTP attempt. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Claim one batch of due deliveries and attempt each; returns how many were claimed. */
  async runOnce(): Promise<number> {
    const now = this.deps.now();
    const due = await this.deps.store.claimDue(
      now,
      this.options.batchSize,
      new Date(now.getTime() + this.options.leaseMs),
    );
    await eachLimited(due, this.options.concurrency, (item) => this.attempt(item));
    return due.length;
  }

  /** Attempt one claimed delivery and record the outcome; never throws. */
  async attempt(due: DueDelivery): Promise<AttemptPlan | null> {
    const logger = this.deps.logger.child({ tenantId: due.tenantId, deliveryId: due.id });
    try {
      const delivery = await this.deps.store.load(due);
      if (!delivery) {
        return null;
      }
      const failure = await this.send(delivery);
      const now = this.deps.now();
      const plan = planAfterAttempt({
        attemptsBefore: delivery.attempts,
        failure,
        now,
        random: this.deps.random,
        format: delivery.format,
      });
      await this.deps.store.record(due, plan, now);
      const fields = {
        webhookId: delivery.webhookId,
        event: delivery.event,
        host: hostOf(delivery.url),
        format: delivery.format,
        attempt: plan.attempts,
        status: plan.status,
        ...(plan.lastError ? { error: plan.lastError } : {}),
      };
      if (plan.status === "delivered") {
        logger.info("webhook delivered", fields);
      } else {
        logger.warn(
          plan.status === "failed" ? "webhook delivery given up" : "webhook delivery failed",
          {
            ...fields,
            nextAttemptAt: plan.nextAttemptAt?.toISOString() ?? null,
          },
        );
      }
      return plan;
    } catch (error) {
      if (error instanceof DeliveryInterrupted) {
        logger.info("webhook delivery interrupted, lease will bring it back");
        return null;
      }
      // Store trouble (database gone, ...): the lease expires and the attempt comes back.
      logger.error("webhook delivery could not be processed", {
        errorMessage: safeErrorMessage(error),
      });
      return null;
    }
  }

  /** One HTTP attempt; resolves with the failure, or null when the receiver accepted it. */
  private async send(delivery: LoadedDelivery): Promise<DeliveryFailure | null> {
    if (!delivery.active) {
      return new DeliveryFailure("webhook_disabled");
    }
    const prepared = isChatFormat(delivery.format)
      ? await this.prepareChat(delivery, delivery.format)
      : await this.prepareSigned(delivery);
    if (prepared instanceof DeliveryFailure) {
      return prepared;
    }
    const request: WebhookHttpRequest = {
      url: delivery.url,
      body: prepared.body,
      headers: prepared.headers,
      timeoutMs: this.options.timeoutMs,
      signal: this.controller.signal,
    };
    try {
      return failureForResponse(await this.deps.transport(request), this.deps.now());
    } catch (error) {
      if (error instanceof DeliveryInterrupted || this.controller.signal.aborted) {
        throw new DeliveryInterrupted();
      }
      return failureForError(error, false);
    }
  }

  /** A chat message rendered from the stored envelope, unsigned. */
  private async prepareChat(
    delivery: LoadedDelivery,
    format: Exclude<WebhookFormat, "restow">,
  ): Promise<{ body: string; headers: Record<string, string> } | DeliveryFailure> {
    let context: ChatContext;
    try {
      context = this.deps.chatContext
        ? await this.deps.chatContext(delivery)
        : {
            language: defaultLanguage,
            tenantName: delivery.tenantId,
            publicUrl: null,
            objectName: null,
          };
    } catch {
      // A database hiccup: retried like any failure, visible in the log.
      return new DeliveryFailure("internal", "message context could not be loaded");
    }
    const message = buildChatMessage(delivery.event, delivery.payload, context);
    return { body: renderChatBody(format, message), headers: chatDeliveryHeaders() };
  }

  /** The envelope as stored, signed with the webhook's secret. */
  private async prepareSigned(
    delivery: LoadedDelivery,
  ): Promise<{ body: string; headers: Record<string, string> } | DeliveryFailure> {
    if (!delivery.secretRef) {
      return new DeliveryFailure("secret_missing");
    }
    let secret: string | null;
    try {
      secret = await this.deps.secrets(delivery.tenantId, delivery.secretRef);
    } catch {
      // A key or database problem: retried like any failure, visible in the log.
      return new DeliveryFailure("internal", "signing secret could not be opened");
    }
    if (secret === null) {
      return new DeliveryFailure("secret_missing");
    }
    const body = JSON.stringify(delivery.payload);
    return {
      body,
      headers: deliveryHeaders({
        event: delivery.event,
        deliveryId: delivery.id,
        attempt: delivery.attempts + 1,
        signature: signWebhookBody(secret, body),
      }),
    };
  }

  /** Delete finished deliveries past the retention, at most once per prune interval. */
  async pruneIfDue(): Promise<number> {
    const now = this.deps.now().getTime();
    if (now - this.lastPruneAt < this.options.pruneIntervalMs) {
      return 0;
    }
    this.lastPruneAt = now;
    const before = new Date(now - this.options.retentionDays * 24 * HOUR);
    const pruned = await this.deps.store.prune(before);
    if (pruned > 0) {
      this.deps.logger.info("webhook deliveries pruned", { pruned, before: before.toISOString() });
    }
    return pruned;
  }

  /** Start polling. A full batch is followed immediately by the next one. */
  start(): void {
    if (this.loop) {
      return;
    }
    if (this.deps.disabled) {
      this.deps.logger.info("webhook dispatcher disabled: demo mode, nothing is delivered");
      return;
    }
    this.deps.logger.info("webhook dispatcher started", {
      pollIntervalMs: this.options.pollIntervalMs,
      concurrency: this.options.concurrency,
      allowPrivateNetworks: this.options.allowPrivateNetworks,
    });
    this.loop = this.run();
  }

  /** Stop polling; in-flight attempts are aborted and come back after their lease. */
  async stop(): Promise<void> {
    this.controller.abort("shutdown");
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    while (!this.controller.signal.aborted) {
      let claimed = 0;
      try {
        await this.pruneIfDue();
        claimed = await this.runOnce();
      } catch (error) {
        this.deps.logger.error("webhook poll failed", { errorMessage: safeErrorMessage(error) });
      }
      if (claimed < this.options.batchSize) {
        await this.sleep(this.options.pollIntervalMs);
      }
    }
  }

  /** Wait `ms`, or less when the dispatcher is stopped meanwhile. */
  private sleep(ms: number): Promise<void> {
    const signal = this.controller.signal;
    if (signal.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      signal.addEventListener("abort", done, { once: true });
    });
  }
}

/**
 * The worker's webhook delivery service. Not a pg-boss queue handler: the
 * process entrypoint starts it next to the queue workers and stops it on
 * shutdown:
 *
 *   const webhookDispatcher = webhooksHandler.start(runtime);
 *   ...
 *   await webhookDispatcher.stop();
 */
export const webhooksHandler = {
  name: "webhooks",
  start(
    runtime: Pick<WorkerRuntime, "db" | "keyrings" | "logger" | "now" | "shutdownSignal">,
    options: WebhookDispatcherOptions = webhookOptionsFromEnv(),
  ): WebhookDispatcher {
    const dispatcher = new WebhookDispatcher(
      {
        store: new PgDeliveryStore(runtime.db),
        secrets: keyringSecretSource(runtime),
        chatContext: pgChatContextSource(runtime.db),
        transport: createHttpTransport({ allowPrivateNetworks: options.allowPrivateNetworks }),
        logger: runtime.logger.child({ component: "webhooks" }),
        now: runtime.now,
        disabled: isDemoModeEnabled(),
      },
      options,
    );
    runtime.shutdownSignal.addEventListener("abort", () => void dispatcher.stop(), { once: true });
    dispatcher.start();
    return dispatcher;
  },
} as const;
