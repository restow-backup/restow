import { BlockList, isIP } from "node:net";

/**
 * Which hop of `X-Forwarded-For` is the client (lib/request.ts `clientIpOf`).
 *
 * The Caddy edge (root Caddyfile) keeps an incoming `X-Forwarded-For` only
 * when the peer that sent it is one of its trusted proxies
 * (`RESTOW_EDGE_TRUSTED_PROXIES`), and appends the address of that peer; from
 * any other peer it replaces the header with the peer's address. So the
 * right-most entry is always the peer Caddy saw, and every entry to its left
 * was written by whoever sent the request to that peer. Only the hops added by
 * trusted proxies can be believed: the left-most entry is whatever the client
 * put there. The client is therefore the right-most entry that is not a
 * trusted proxy, found by walking from the right, the way Caddy's own
 * `trusted_proxies_strict` mode and better-auth's `trustedProxies` resolve it.
 *
 * The api reads the same variable as the edge, with the same default and the
 * same `private_ranges` shorthand, so both agree on who is trusted.
 */

/** What Caddy trusts when `RESTOW_EDGE_TRUSTED_PROXIES` is unset (root Caddyfile). */
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = ["127.0.0.1/32", "::1/128"];

/** Caddy's `private_ranges` shorthand, expanded exactly as Caddy expands it. */
export const PRIVATE_RANGES: readonly string[] = [
  "192.168.0.0/16",
  "172.16.0.0/12",
  "10.0.0.0/8",
  "127.0.0.1/8",
  "fd00::/8",
  "::1",
];

/**
 * The trusted proxy ranges from the variable's value: space- or
 * comma-separated addresses and CIDR ranges, `private_ranges` expanded. Unset
 * or empty is Caddy's default (loopback only).
 */
export function trustedProxyEntries(value: string | undefined): string[] {
  const tokens = (value ?? "")
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return [...DEFAULT_TRUSTED_PROXIES];
  }
  return tokens.flatMap((token) => (token === "private_ranges" ? [...PRIVATE_RANGES] : [token]));
}

function familyOf(address: string): "ipv4" | "ipv6" | null {
  const family = isIP(address);
  return family === 4 ? "ipv4" : family === 6 ? "ipv6" : null;
}

export interface ProxyMatcher {
  /** Whether `address` lies in one of the trusted ranges. */
  matches(address: string): boolean;
  /** Entries that are neither an address nor a CIDR range; they trust nothing. */
  invalid: readonly string[];
}

/** A matcher for trusted proxy ranges; an entry that does not parse trusts nothing. */
export function createProxyMatcher(entries: readonly string[]): ProxyMatcher {
  const list = new BlockList();
  const invalid: string[] = [];
  for (const entry of entries) {
    const [address = "", prefixText, extra] = entry.split("/");
    const family = familyOf(address);
    const bits = family === "ipv4" ? 32 : 128;
    const prefix =
      prefixText === undefined ? bits : /^\d+$/.test(prefixText) ? Number(prefixText) : -1;
    if (family === null || extra !== undefined || prefix < 0 || prefix > bits) {
      invalid.push(entry);
      continue;
    }
    list.addSubnet(address, prefix, family);
  }
  return {
    matches: (address) => {
      const family = familyOf(address);
      return family !== null && list.check(address, family);
    },
    invalid,
  };
}

const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;

/** The address of one hop: a bare address, `[v6]:port` or `v4:port`; null for anything else. */
export function hopAddress(hop: string): string | null {
  let value = hop.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) {
      return null;
    }
    value = value.slice(1, end);
  } else {
    const withPort = IPV4_WITH_PORT.exec(value);
    if (withPort?.[1]) {
      value = withPort[1];
    }
  }
  return familyOf(value) === null ? null : value;
}

/**
 * The client address in an `X-Forwarded-For` value: the right-most hop that is
 * not a trusted proxy, or the left-most hop when every hop is trusted. Null
 * when a hop on the way is not an address (nothing to its left can be
 * believed) or the value is empty.
 */
export function clientFromForwardedFor(
  value: string,
  isTrusted: (address: string) => boolean,
): string | null {
  const hops = value
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  for (let index = hops.length - 1; index >= 0; index--) {
    const address = hopAddress(hops[index] ?? "");
    if (address === null) {
      return null;
    }
    if (index === 0 || !isTrusted(address)) {
      return address;
    }
  }
  return null;
}
