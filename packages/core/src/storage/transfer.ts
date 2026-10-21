/**
 * Transfer errors of a read: the connection broke or the storage was briefly
 * unable to answer, which says nothing about the object. Reading again is the
 * right answer to them, whereas a missing object, denied access or bytes that
 * do not match are not worth a second attempt.
 *
 * Node reports a response body cut off mid-transfer as an `Error("aborted")`
 * (code ECONNRESET); the AWS SDK retries a request that fails before its
 * headers arrive, but not a body stream that breaks afterwards, so the
 * readers of packs (S3 `get` paths, the storage integrity check) retry those
 * themselves.
 */

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** S3 error names (and codes) that mean "try again", whatever the HTTP status. */
const TRANSIENT_S3_NAMES = new Set([
  "SlowDown",
  "RequestTimeout",
  "InternalError",
  "ServiceUnavailable",
  "Throttling",
  "ThrottlingException",
  "TooManyRequests",
  "RequestTimeoutException",
  "TimeoutError",
]);

const TRANSIENT_MESSAGES =
  /^(aborted|socket hang up|premature close|other side closed|terminated)$|ECONNRESET|EPIPE|ETIMEDOUT|timed? ?out|connection (was )?(reset|closed)/i;

type ErrorShape = {
  name?: unknown;
  code?: unknown;
  Code?: unknown;
  message?: unknown;
  cause?: unknown;
  $metadata?: { httpStatusCode?: unknown };
};

function transientLayer(layer: ErrorShape): boolean {
  // Cancellation of the job is never a transfer error, whatever its message says.
  if (layer.name === "AbortError" || layer.name === "JobAbortedError") {
    return false;
  }
  if (typeof layer.code === "string" && TRANSIENT_CODES.has(layer.code)) {
    return true;
  }
  if (
    (typeof layer.name === "string" && TRANSIENT_S3_NAMES.has(layer.name)) ||
    (typeof layer.Code === "string" && TRANSIENT_S3_NAMES.has(layer.Code))
  ) {
    return true;
  }
  const status = layer.$metadata?.httpStatusCode;
  if (typeof status === "number" && (status >= 500 || status === 429 || status === 408)) {
    return true;
  }
  return typeof layer.message === "string" && TRANSIENT_MESSAGES.test(layer.message.trim());
}

/** Whether `error` (or an error it wraps) is a transfer error worth reading again. */
export function isTransientTransferError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const layer = current as ErrorShape;
    if (layer.name === "AbortError" || layer.name === "JobAbortedError") {
      return false;
    }
    if (transientLayer(layer)) {
      return true;
    }
    current = layer.cause;
  }
  return false;
}

/** Wait `ms`; rejects with an AbortError as soon as `signal` fires. */
export function pauseBeforeRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 && !signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const aborted = () => {
      const error = new Error("aborted while waiting to read again");
      error.name = "AbortError";
      return error;
    };
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
