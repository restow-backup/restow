import { safeErrorMessage } from "@restow/db";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * RFC 7807 problem responses (`application/problem+json`), the API error format
 * required by the integration API contract.
 */

export interface ProblemDetails {
  /** A URI reference identifying the problem type; `about:blank` when unspecified. */
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** RFC 7807 extension members. */
  [extension: string]: unknown;
}

export interface ProblemOptions {
  type?: string;
  detail?: string;
  instance?: string;
  extensions?: Record<string, unknown>;
}

export const PROBLEM_CONTENT_TYPE = "application/problem+json; charset=utf-8";

/** An error that carries the fields of an RFC 7807 problem response. */
export class ProblemError extends Error {
  readonly status: ContentfulStatusCode;
  readonly title: string;
  readonly type: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly extensions?: Record<string, unknown>;

  constructor(status: ContentfulStatusCode, title: string, options: ProblemOptions = {}) {
    super(options.detail ?? title);
    this.name = "ProblemError";
    this.status = status;
    this.title = title;
    this.type = options.type ?? "about:blank";
    this.detail = options.detail;
    this.instance = options.instance;
    this.extensions = options.extensions;
  }
}

/** Serialize a problem to the response with the correct content type. */
export function sendProblem(
  c: Context,
  status: ContentfulStatusCode,
  title: string,
  options: ProblemOptions = {},
) {
  const body: ProblemDetails = {
    type: options.type ?? "about:blank",
    title,
    status,
  };
  if (options.detail !== undefined) {
    body.detail = options.detail;
  }
  if (options.instance !== undefined) {
    body.instance = options.instance;
  }
  if (options.extensions) {
    for (const [key, value] of Object.entries(options.extensions)) {
      body[key] = value;
    }
  }
  return c.body(JSON.stringify(body), status, { "content-type": PROBLEM_CONTENT_TYPE });
}

/** How many stack frames an unexpected error keeps in the log. */
const LOGGED_FRAMES = 12;

/**
 * One JSON line on stderr for an error answered with 500: the route (path only, never the
 * query string, which can carry a token), the error's name, its message without the text of a
 * failed query (safeErrorMessage) and the first frames of its stack (frames only: the message
 * line is not repeated).
 */
function logUnexpected(err: Error, c: Context): void {
  const frames = (err.stack ?? "")
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .slice(0, LOGGED_FRAMES)
    .map((line) => line.trim());
  console.error(
    JSON.stringify({
      level: "error",
      message: "unexpected error, answered with 500",
      method: c.req.method,
      path: c.req.path,
      errorName: err.name,
      errorMessage: safeErrorMessage(err),
      stack: frames,
    }),
  );
}

/** Global `onError` handler: known problems pass through, everything else is a 500. */
export function errorHandler(err: Error, c: Context) {
  if (err instanceof ProblemError) {
    return sendProblem(c, err.status, err.title, {
      type: err.type,
      detail: err.detail,
      instance: err.instance,
      extensions: err.extensions,
    });
  }
  // The log names what went wrong (the body never does): without it a 500 leaves no trace.
  logUnexpected(err, c);
  // Never leak internals or secrets in the response body.
  return sendProblem(c, 500, "Internal Server Error", {
    detail: "An unexpected error occurred.",
  });
}

/** Global `notFound` handler as a problem response. */
export function notFoundHandler(c: Context) {
  return sendProblem(c, 404, "Not Found", {
    detail: `No handler for ${c.req.method} ${c.req.path}.`,
  });
}
