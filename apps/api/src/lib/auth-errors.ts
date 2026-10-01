import { APIError } from "better-auth/api";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ProblemError } from "../problem.js";

/**
 * Translate errors thrown by the better-auth server API into RFC 7807 problems,
 * so a failed organization/member/user call never surfaces as a bare 500. The
 * better-auth error `code` is exposed as an extension for the UI to map to a
 * translated message; the message itself is passed through as `detail`.
 */

const STATUS_BY_NAME: Record<string, ContentfulStatusCode> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
};

/** Error codes better-auth reports as 400 that are conflicts in REST terms. */
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  "ORGANIZATION_ALREADY_EXISTS",
  "USER_ALREADY_EXISTS",
  "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
  "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
  "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION",
]);

function statusOf(error: APIError): ContentfulStatusCode {
  const code = typeof error.body?.code === "string" ? error.body.code : undefined;
  if (code && CONFLICT_CODES.has(code)) {
    return 409;
  }
  if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600) {
    return error.statusCode as ContentfulStatusCode;
  }
  return STATUS_BY_NAME[String(error.status)] ?? 500;
}

/** Convert a better-auth API error into a problem; other errors pass through. */
export function toProblem(error: unknown): unknown {
  if (!(error instanceof APIError)) {
    return error;
  }
  const status = statusOf(error);
  const code = typeof error.body?.code === "string" ? error.body.code : undefined;
  return new ProblemError(status, status === 409 ? "Conflict" : "Authentication service error", {
    type: code ? `urn:restow:problem:auth:${code.toLowerCase()}` : "about:blank",
    detail: error.body?.message ?? error.message,
    extensions: code ? { code } : undefined,
  });
}

/** Await a better-auth call and rethrow its failures as problems. */
export async function authCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toProblem(error);
  }
}
