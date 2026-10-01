import type { Context } from "hono";
import { config } from "../config.js";
import { type ProxyMatcher, clientFromForwardedFor, createProxyMatcher } from "./forwarded.js";

/**
 * Request helpers shared by routes: the client IP for the audit log and the
 * observed origin for the passkey-ready gate.
 */

export type HeaderReader = (name: string) => string | undefined;

let proxies: ProxyMatcher | null = null;

/** The trusted proxy ranges of this process (`RESTOW_EDGE_TRUSTED_PROXIES`), built once. */
export function trustedProxies(): ProxyMatcher {
  proxies ??= createProxyMatcher(config.trustedProxies);
  return proxies;
}

/**
 * The client IP as seen through the Caddy edge, or of a direct connection.
 *
 * Behind the edge, `X-Forwarded-For` is always present and decides alone: the
 * client is its right-most hop that is not a trusted proxy (lib/forwarded.ts).
 * The left-most hop is whatever the client sent and is never believed, so a
 * client behind a trusted front proxy cannot put an address of its choosing
 * into the audit log, the sign-in records or the lockout keys. `X-Real-IP` is
 * read only when no `X-Forwarded-For` arrived at all, i.e. a direct
 * connection to the api's loopback port. Null when neither header names an
 * address; the raw socket address is not available through the fetch-style
 * request.
 *
 * Always null in demo mode (security review finding 2, DSGVO): every demo
 * visitor shares the one demo account, so a visitor's IP stored in the audit
 * log would be visible to every other visitor who can read that tenant's
 * chain. This is the single place every audited action's `ip` comes from
 * (features/*\/routes.ts, middleware/apiKey.ts), so demo mode never records
 * one — deploy/demo/README.md documents this.
 */
export function clientIpOf(header: HeaderReader): string | null {
  if (config.demo.enabled) {
    return null;
  }
  const forwarded = header("x-forwarded-for");
  if (forwarded !== undefined && forwarded.trim().length > 0) {
    return clientFromForwardedFor(forwarded, trustedProxies().matches);
  }
  const real = header("x-real-ip")?.trim();
  return real && real.length > 0 ? real : null;
}

/** The client IP of a Hono request (see {@link clientIpOf}). */
export function clientIp(c: Context): string | null {
  return clientIpOf((name) => c.req.header(name));
}

function originOf(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const { origin } = new URL(value);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** First entry of a possibly comma-separated proxy header. */
function firstValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

/**
 * The origin the browser is on, for the passkey gate's origin check and the
 * public-origin fallback.
 *
 * Browsers send `Origin` on PATCH/POST but not on same-origin GET requests, and
 * behind the Caddy edge the request URL the API sees is plain HTTP. So the
 * browser origin is taken, in order, from `Origin`, the `Referer` (sent for
 * same-origin fetches by the default referrer policy), the proxy's
 * `X-Forwarded-Proto`/`X-Forwarded-Host`, and only then the request URL.
 */
export function browserOrigin(header: HeaderReader, requestUrl: string): string | null {
  const fromOrigin = originOf(header("origin"));
  if (fromOrigin) {
    return fromOrigin;
  }
  const fromReferer = originOf(header("referer"));
  if (fromReferer) {
    return fromReferer;
  }
  const host = firstValue(header("x-forwarded-host"));
  const proto = firstValue(header("x-forwarded-proto"));
  if (host && proto) {
    const forwarded = originOf(`${proto}://${host}`);
    if (forwarded) {
      return forwarded;
    }
  }
  return originOf(requestUrl);
}

/** The origin the browser reports for this request (see {@link browserOrigin}). */
export function observedOrigin(c: Context): string | null {
  return browserOrigin((name) => c.req.header(name), c.req.url);
}
