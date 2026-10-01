/**
 * Graph error model.
 *
 * Every non-2xx answer from Graph carries `{ error: { code, message, innerError } }`.
 * The resource layer turns that into a {@link GraphError} so callers can branch on
 * status and code (410 Gone → resync, 403 → outside the application access policy,
 * 404 → item vanished between delta and download) without parsing bodies themselves.
 */

/** Shape of the JSON error payload Graph returns. */
export interface GraphErrorPayload {
  error?: {
    code?: string;
    message?: string;
    innerError?: {
      code?: string;
      "request-id"?: string;
      "client-request-id"?: string;
      date?: string;
      [key: string]: unknown;
    };
  };
}

/** A failed Graph call, with the pieces callers need to decide what to do next. */
export class GraphError extends Error {
  readonly status: number;
  /** Graph error code, e.g. `ErrorItemNotFound`, `SyncStateNotFound`, `resyncRequired`. */
  readonly code: string | undefined;
  /** Inner error code when Graph provides one (often more specific than `code`). */
  readonly innerCode: string | undefined;
  readonly requestId: string | undefined;
  /** `client-request-id` of the failed call, the second id Microsoft support asks for. */
  readonly clientRequestId: string | undefined;
  /** Server time Graph reports in the error (`innerError.date`), for a support case. */
  readonly errorDate: string | undefined;
  /** Graph's own message text (no URL, no query string). */
  readonly graphMessage: string | undefined;
  /** Lower-cased response headers. */
  readonly headers: Record<string, string>;
  /** The request that failed (method and URL only; never bodies or tokens). */
  readonly method: string;
  readonly url: string;

  constructor(input: {
    status: number;
    method: string;
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  }) {
    const parsed = parseErrorPayload(input.payload);
    const code = parsed.code ? ` (${parsed.code})` : "";
    const detail = parsed.message ? `: ${parsed.message}` : "";
    super(
      `Graph ${input.method} ${redactUrl(input.url)} failed with ${input.status}${code}${detail}`,
    );
    this.name = "GraphError";
    this.status = input.status;
    this.code = parsed.code;
    this.innerCode = parsed.innerCode;
    const headers = input.headers ?? {};
    this.requestId = parsed.requestId ?? headers["request-id"];
    this.clientRequestId = parsed.clientRequestId ?? headers["client-request-id"];
    this.errorDate = parsed.date ?? headers.date;
    this.graphMessage = parsed.message;
    this.headers = headers;
    this.method = input.method;
    this.url = input.url;
  }

  /** Retry-After in milliseconds when the response carried one. */
  get retryAfterMs(): number | null {
    const value = this.headers["retry-after"];
    if (!value) {
      return null;
    }
    return /^\d+$/.test(value.trim()) ? Number(value.trim()) * 1000 : null;
  }
}

function parseErrorPayload(payload: unknown): {
  code?: string;
  innerCode?: string;
  message?: string;
  requestId?: string;
  clientRequestId?: string;
  date?: string;
} {
  if (!payload || typeof payload !== "object") {
    return typeof payload === "string" && payload.length > 0
      ? { message: payload.slice(0, 500) }
      : {};
  }
  const error = (payload as GraphErrorPayload).error;
  if (!error) {
    return {};
  }
  return {
    code: error.code,
    innerCode: error.innerError?.code,
    message: error.message,
    requestId: error.innerError?.["request-id"],
    clientRequestId: error.innerError?.["client-request-id"],
    date: error.innerError?.date,
  };
}

/** Strip query strings (which may carry tokens) from URLs that end up in messages. */
export function redactUrl(url: string): string {
  const index = url.indexOf("?");
  return index === -1 ? url : `${url.slice(0, index)}?…`;
}

export function isGraphError(value: unknown): value is GraphError {
  return value instanceof GraphError;
}

/** 410 Gone: the delta token is no longer valid; resync this folder/drive only. */
export function isGone(error: unknown): error is GraphError {
  return isGraphError(error) && error.status === 410;
}

export function isNotFound(error: unknown): error is GraphError {
  return isGraphError(error) && error.status === 404;
}

/**
 * 403 on a mailbox usually means an Exchange Application Access Policy excludes it.
 * Restow shows this as "not in protection scope", not as a failure (docs/MICROSOFT.md).
 */
export function isForbidden(error: unknown): error is GraphError {
  return isGraphError(error) && error.status === 403;
}

export function isThrottled(error: unknown): error is GraphError {
  return isGraphError(error) && (error.status === 429 || error.status === 503);
}

/** Codes Graph uses when a user has no mailbox or it is inactive/soft-deleted. */
const MAILBOX_UNAVAILABLE_CODES = new Set([
  "MailboxNotEnabledForRESTAPI",
  "MailboxNotHostedInExchangeOnline",
  "ErrorMailboxNotEnabledForRESTAPI",
  "ResourceNotFound",
  "ErrorInvalidUser",
  "ErrorNonExistentMailbox",
]);

/** True when the error says the target user has no usable Exchange mailbox. */
export function isMailboxUnavailable(error: unknown): error is GraphError {
  if (!isGraphError(error)) {
    return false;
  }
  return (
    (error.code !== undefined && MAILBOX_UNAVAILABLE_CODES.has(error.code)) ||
    (error.innerCode !== undefined && MAILBOX_UNAVAILABLE_CODES.has(error.innerCode))
  );
}
