import { productName } from "@restow/i18n";
import type { HeaderReader } from "../lib/request.js";
import { ProblemError } from "../problem.js";

/**
 * Cross-site request protection for the session-authenticated routes
 * (middleware/session.ts applies it before it looks up the session).
 *
 * The web app and the API share one origin: the Caddy edge serves both, and
 * the Vite dev server proxies `/api`. A browser attaches the session cookie to
 * requests that other pages trigger as well, for example a form posted from a
 * sibling host of the same site, which SameSite cookies do not stop. So every
 * state-changing request (any method except GET, HEAD and OPTIONS) that the
 * browser marks as coming from elsewhere is refused with 403:
 *
 *   - `Sec-Fetch-Site` (sent by every current browser, and not settable by a
 *     page) must be `same-origin`, or `none` for a request the user started
 *     from the address bar. It compares the page with the URL the browser
 *     called, so it stays right behind proxies that rewrite the host;
 *   - without it (older browsers), `Origin` must be the origin the request
 *     arrived at (as the edge forwards it) or the configured public origin.
 *
 * A request that carries neither header does not come from a browser page (a
 * script, a monitoring probe, a test) and cannot carry a victim's session, so
 * it passes this check.
 *
 * Independently, a request that carries a body must declare it as JSON, or it
 * is refused with 415. The content types an HTML form or a CORS "simple"
 * request can send without a preflight (text/plain, form-urlencoded,
 * multipart) are exactly the ones a cross-site attack depends on, so this
 * also covers browsers that send neither header. Every session route reads
 * JSON (or nothing), so no route is exempt.
 *
 * The public routes that change state without a session use it too: the
 * setup wizard, set-password links and agent enrollment
 * (middleware/public-routes.test.ts keeps that list complete).
 *
 * API-key requests (`Authorization: Bearer rsk_...`), better-auth's own
 * routes (`/api/auth/*`) and the agent's HTTP Basic routes do not pass
 * through here: a browser never attaches an API key or an agent secret on its
 * own, and better-auth checks origins itself (its CSRF and origin checks).
 */

/** Methods that only read; everything else may change state. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** `Sec-Fetch-Site` values of the web app's own requests and of user-typed navigations. */
const TRUSTED_FETCH_SITES: ReadonlySet<string> = new Set(["same-origin", "none"]);

export const CROSS_SITE_PROBLEM = "urn:restow:problem:cross-site-request";
export const UNSUPPORTED_MEDIA_TYPE_PROBLEM = "urn:restow:problem:unsupported-media-type";

/**
 * What a route besides JSON accepts as request body. Chunked file uploads send
 * raw bytes; `application/octet-stream` is not a content type a cross-site
 * form or a CORS "simple" request can send (it needs a preflight, which the
 * API never grants), so admitting it keeps the protection above intact.
 */
export interface BodyPolicy {
  /** Also accept `application/octet-stream` (raw file chunks). */
  allowOctetStream?: boolean;
}

/** `application/octet-stream`, whatever its parameters. */
export function isOctetStreamContentType(value: string | undefined): boolean {
  return (value?.split(";")[0]?.trim().toLowerCase() ?? "") === "application/octet-stream";
}

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** The origin of a URL, or null for anything that is not one (including `null`). */
export function originOf(value: string | null | undefined): string | null {
  const origin = value ? parseUrl(value)?.origin : undefined;
  return origin && origin !== "null" ? origin : null;
}

function firstValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first ? first : undefined;
}

/**
 * The origin the request was sent to, as the browser saw it: the host and
 * scheme the edge forwards (`X-Forwarded-Host`, `X-Forwarded-Proto`), else the
 * request URL. A page on another site cannot set these headers on a browser
 * request without a CORS preflight, which the API never grants.
 */
export function arrivalOrigin(header: HeaderReader, requestUrl: string): string | null {
  const url = parseUrl(requestUrl);
  const host = firstValue(header("x-forwarded-host")) ?? url?.host;
  const scheme = firstValue(header("x-forwarded-proto")) ?? url?.protocol.replace(/:$/, "");
  return host && scheme ? originOf(`${scheme}://${host}`) : null;
}

/** Whether a `Sec-Fetch-Site` value (absent for non-browser clients) allows a change. */
export function fetchSiteAllowed(value: string | undefined): boolean {
  return value === undefined || TRUSTED_FETCH_SITES.has(value.trim().toLowerCase());
}

/** `application/json` or a `+json` structured syntax (e.g. `application/merge-patch+json`). */
export function isJsonContentType(value: string | undefined): boolean {
  const type = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"));
}

/**
 * Whether the request declares a body: a chunked transfer, a non-zero
 * `Content-Length`, or (with neither length header) a declared content type.
 * The node server hands every POST a body stream, even an empty one, so the
 * headers are what tells an empty change (cancel, retry) from one with data.
 */
export function declaresBody(header: HeaderReader): boolean {
  if (header("transfer-encoding")?.trim()) {
    return true;
  }
  const length = header("content-length")?.trim();
  if (length) {
    return Number(length) !== 0;
  }
  return header("content-type") !== undefined;
}

export interface BrowserRequest {
  method: string;
  header: HeaderReader;
  /** The request URL as the API received it. */
  url: string;
  /** The configured public origins (environment, setup wizard); read only when needed. */
  publicOrigins: () => Promise<readonly string[]>;
}

function crossSite(): ProblemError {
  return new ProblemError(403, "Cross-site request refused", {
    type: CROSS_SITE_PROBLEM,
    detail: `Changes are only accepted from the ${productName()} web app itself.`,
  });
}

function unsupportedMediaType(): ProblemError {
  return new ProblemError(415, "Unsupported Media Type", {
    type: UNSUPPORTED_MEDIA_TYPE_PROBLEM,
    detail: "Send the request body as application/json.",
    extensions: { accepted: ["application/json"] },
  });
}

async function originTrusted(origin: string, request: BrowserRequest): Promise<boolean> {
  const claimed = originOf(origin);
  if (claimed === null) {
    return false;
  }
  if (claimed === arrivalOrigin(request.header, request.url)) {
    return true;
  }
  return (await request.publicOrigins()).includes(claimed);
}

/** Whether the browser says the request comes from the page's own origin. */
async function fromOwnOrigin(request: BrowserRequest): Promise<boolean> {
  const site = request.header("sec-fetch-site");
  if (site !== undefined) {
    return fetchSiteAllowed(site);
  }
  const origin = request.header("origin");
  return origin === undefined || originTrusted(origin, request);
}

/**
 * Refuse a state-changing request from another site (403) or with a body
 * that is not JSON (415). Safe methods always pass.
 */
export async function assertSameOriginRequest(
  request: BrowserRequest,
  policy: BodyPolicy = {},
): Promise<void> {
  if (isSafeMethod(request.method)) {
    return;
  }
  if (!(await fromOwnOrigin(request))) {
    throw crossSite();
  }
  const contentType = request.header("content-type");
  const acceptable =
    isJsonContentType(contentType) ||
    (policy.allowOctetStream === true && isOctetStreamContentType(contentType));
  if (declaresBody(request.header) && !acceptable) {
    throw unsupportedMediaType();
  }
}
