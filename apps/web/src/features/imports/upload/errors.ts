import { ApiError, NetworkError } from "@/lib/api";
import type { UploadErrorCode } from "./types";

/** An upload error the engine understands: a code for the UI and whether trying again may help. */
export class UploadFailure extends Error {
  readonly code: UploadErrorCode;
  readonly retryable: boolean;
  /** Segment indices the server reported missing (409 on `complete`). */
  readonly missing: number[] | null;

  constructor(
    code: UploadErrorCode,
    options: { retryable?: boolean; missing?: number[] | null; cause?: unknown } = {},
  ) {
    super(`Upload failed: ${code}`);
    this.name = "UploadFailure";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.missing = options.missing ?? null;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** The upload was cancelled or the page went away; not a failure to report. */
export class UploadAborted extends Error {
  constructor() {
    super("Upload aborted");
    this.name = "UploadAborted";
  }
}

export const PROBLEM_FILE_TOO_LARGE = "urn:restow:problem:import-file-too-large";
export const PROBLEM_SEGMENT_CORRUPT = "urn:restow:problem:import-segment-corrupt";
export const PROBLEM_STAGING_FULL = "urn:restow:problem:import-staging-full";

function missingSegments(error: ApiError): number[] | null {
  const missing = error.problem?.missing;
  if (!Array.isArray(missing)) {
    return null;
  }
  const indices = missing.filter(
    (value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0,
  );
  return indices.length > 0 ? indices : null;
}

/**
 * Turn whatever a transport call threw into an {@link UploadFailure} (or
 * {@link UploadAborted} when the signal fired). Network problems, gateway
 * errors, throttling and damaged segments are worth another try; everything
 * else stops the file at once.
 */
export function classifyFailure(
  error: unknown,
  signal: AbortSignal,
): UploadFailure | UploadAborted {
  if (error instanceof UploadFailure || error instanceof UploadAborted) {
    return error;
  }
  // `apiFetch` wraps an aborted fetch in a NetworkError, so the signal decides first.
  if (signal.aborted) {
    return new UploadAborted();
  }
  if (error instanceof NetworkError) {
    return new UploadFailure("network", { retryable: true, cause: error });
  }
  if (error instanceof ApiError) {
    const type = error.problem?.type;
    const status = error.status;
    if (status === 401) return new UploadFailure("unauthorized", { cause: error });
    if (status === 403) return new UploadFailure("forbidden", { cause: error });
    if (status === 413 || type === PROBLEM_FILE_TOO_LARGE) {
      return new UploadFailure("too_large", { cause: error });
    }
    if (type === PROBLEM_STAGING_FULL) {
      return new UploadFailure("staging_full", { cause: error });
    }
    if (type === PROBLEM_SEGMENT_CORRUPT) {
      return new UploadFailure("corrupt", { retryable: true, cause: error });
    }
    if (status === 404 || status === 410) return new UploadFailure("gone", { cause: error });
    if (status === 409) {
      return new UploadFailure("conflict", { missing: missingSegments(error), cause: error });
    }
    if (status === 400 || status === 422) return new UploadFailure("invalid", { cause: error });
    // Gateways in front of a stopped API answer 502/503/504: the server is not there.
    if (status === 502 || status === 503 || status === 504) {
      return new UploadFailure("network", { retryable: true, cause: error });
    }
    if (status === 408 || status === 425 || status === 429 || status >= 500) {
      return new UploadFailure("server", { retryable: true, cause: error });
    }
    return new UploadFailure("unknown", { cause: error });
  }
  // The browser fails to read a file that was moved, deleted or changed since it was chosen.
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    (error.name === "NotReadableError" || error.name === "NotFoundError")
  ) {
    return new UploadFailure("unreadable", { cause: error });
  }
  return new UploadFailure("unknown", { cause: error });
}
