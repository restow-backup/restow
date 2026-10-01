import type { MiddlewareHandler } from "hono";
import { MAX_DOWNLOAD_BODY_BYTES } from "../features/endpoints/schemas.js";
import { ProblemError } from "../problem.js";

/**
 * Request body limits, for every route of the api (app.ts mounts this ahead
 * of all of them, better-auth's included).
 *
 * Most bodies are small JSON documents, and several routes read theirs before
 * anyone is authenticated (the setup wizard, set-password links, agent
 * enrollment, sign-in). Without a limit, one request with a body of several
 * gigabytes would be buffered in full by the JSON parser. So every body is
 * limited to {@link DEFAULT_BODY_LIMIT}, and only the routes listed in
 * {@link BODY_LIMIT_RULES} may send more, each for a documented reason.
 *
 * A declared `Content-Length` above the limit is refused before a byte is
 * read (Node's HTTP parser never hands a route more than the declared length).
 * A body without one (chunked) is counted while the route reads it, not
 * buffered here: the read fails as soon as the limit is passed, and whatever
 * the route made of that failure, the answer is 413. Nothing is read before
 * the route asks for it, so an unauthenticated caller never gets the api to
 * hold more than the limit of the route it called.
 *
 * The Caddy edge (root Caddyfile, `request_body`) applies the same limits as
 * an outer bound for the public routes and the agent API.
 */

export const PAYLOAD_TOO_LARGE_PROBLEM = "urn:restow:problem:payload-too-large";

/** Every request body unless a rule below says otherwise. */
export const DEFAULT_BODY_LIMIT = 1024 * 1024;

/**
 * Bulk JSON documents whose schema allows several megabytes: a restore or
 * export selection (up to 5,000 paths), the IMAP account list and its CSV
 * import (5,000 accounts, 2 MB of CSV), a directory exclusion list (5,000
 * identities), an import request (500 files) and an agent's run report (log
 * tail and error list).
 */
export const BULK_BODY_LIMIT = 16 * 1024 * 1024;

export interface BodyLimitRule {
  /** HTTP method, or `*` for every method. */
  method: string;
  /** Matched against the whole request path. */
  path: RegExp;
  /** Bytes, or null where the route streams the body and enforces its own cap. */
  limit: number | null;
}

const SEGMENT = "[^/]+";

/** The routes that may send more than {@link DEFAULT_BODY_LIMIT}; the first match wins. */
export const BODY_LIMIT_RULES: readonly BodyLimitRule[] = [
  // The restic REST backend streams pack files to storage; @restow/core refuses
  // anything over MAX_RESTIC_BODY_BYTES (128 MiB) itself.
  { method: "*", path: /^\/agent\/restic\//, limit: null },
  // One upload segment (application/octet-stream), read with a hard cap of
  // exactly the segment size, at most 32 MiB (features/imports/body.ts).
  {
    method: "PUT",
    path: new RegExp(`^/api/v1/imports/uploads/${SEGMENT}/segments/${SEGMENT}$`),
    limit: null,
  },
  // The selected paths of an endpoint download; the route checks the same limit.
  {
    method: "POST",
    path: new RegExp(`^/api/v1/endpoints/${SEGMENT}/downloads$`),
    limit: MAX_DOWNLOAD_BODY_BYTES,
  },
  {
    method: "POST",
    path: new RegExp(`^/agent/v1/runs/${SEGMENT}/finish$`),
    limit: BULK_BODY_LIMIT,
  },
  // Web UI and integration API share the path.
  { method: "POST", path: /^\/api\/v1\/restore$/, limit: BULK_BODY_LIMIT },
  { method: "POST", path: /^\/api\/v1\/exports$/, limit: BULK_BODY_LIMIT },
  { method: "POST", path: /^\/api\/v1\/imports$/, limit: BULK_BODY_LIMIT },
  {
    method: "PUT",
    path: new RegExp(`^/api/v1/directory/sources/${SEGMENT}/rules$`),
    limit: BULK_BODY_LIMIT,
  },
  {
    method: "POST",
    path: new RegExp(`^/api/v1/directory/sources/${SEGMENT}/accounts(?:/import)?$`),
    limit: BULK_BODY_LIMIT,
  },
];

/** The body limit of a request in bytes; null when the route enforces its own. */
export function bodyLimitFor(method: string, path: string): number | null {
  const upper = method.toUpperCase();
  for (const rule of BODY_LIMIT_RULES) {
    if ((rule.method === "*" || rule.method === upper) && rule.path.test(path)) {
      return rule.limit;
    }
  }
  return DEFAULT_BODY_LIMIT;
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}

export function payloadTooLarge(limit: number): ProblemError {
  return new ProblemError(413, "Payload Too Large", {
    type: PAYLOAD_TOO_LARGE_PROBLEM,
    detail: `The request body is larger than this endpoint accepts (${megabytes(limit)}).`,
    extensions: { limitBytes: limit },
  });
}

/** A declared Content-Length, when it is the one that applies (no chunked transfer). */
function declaredLength(header: (name: string) => string | undefined): number | null {
  if (header("transfer-encoding") !== undefined) {
    return null;
  }
  const value = header("content-length")?.trim();
  if (value === undefined || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}

export const requestBodyLimit: MiddlewareHandler = async (c, next) => {
  const limit = bodyLimitFor(c.req.method, c.req.path);
  const body = c.req.raw.body;
  if (limit === null || body === null) {
    await next();
    return;
  }
  const declared = declaredLength((name) => c.req.header(name));
  if (declared !== null) {
    if (declared > limit) {
      throw payloadTooLarge(limit);
    }
    await next();
    return;
  }
  let received = 0;
  let exceeded = false;
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > limit) {
          exceeded = true;
          controller.error(payloadTooLarge(limit));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  c.req.raw = new Request(c.req.raw, { body: counted, duplex: "half" } as RequestInit);
  await next();
  if (exceeded) {
    throw payloadTooLarge(limit);
  }
};
