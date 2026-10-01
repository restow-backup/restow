import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Where a tenant admin may point an S3 target.
 *
 * Probing a target makes the Restow server open connections to the endpoint.
 * A tenant admin is a customer, not the operator of this server, so the
 * endpoint must be a public HTTPS service: no loopback, no private or
 * link-local network, no container-network names. Otherwise the storage test
 * would let a customer scan the provider's internal network (SSRF).
 *
 * Provider admins operate the installation and may use any endpoint, e.g. a
 * Garage node on the compose network (`http://garage:3900`).
 */

export type EndpointPolicyViolation =
  /** Only HTTPS endpoints are allowed for tenant admins. */
  | "https_required"
  /** The host is, or resolves to, a loopback, private, link-local or reserved address. */
  | "private_address"
  /** A name that only exists on a local network (`localhost`, `nas.local`, `garage`). */
  | "local_hostname"
  /** The host name does not resolve. */
  | "unresolvable";

// Two lists: Node matches IPv4 addresses against IPv4-mapped IPv6 rules
// (::ffff:0:0/96), which would block every IPv4 address in a shared list.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  // IPv4-mapped and NAT64 addresses can smuggle any IPv4 target.
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, "ipv6");
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain"];

/** True for an address a tenant-supplied endpoint must never reach. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return BLOCKED_V4.check(address, "ipv4");
  }
  if (family === 6) {
    return BLOCKED_V6.check(address, "ipv6");
  }
  return true;
}

/** The host of an endpoint URL without IPv6 brackets. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Checks that need no network: scheme, literal addresses and local-only names. */
export function checkEndpointShape(endpoint: string): EndpointPolicyViolation | null {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") {
    return "https_required";
  }
  const host = hostOf(url);
  if (isIP(host) !== 0) {
    return isBlockedAddress(host) ? "private_address" : null;
  }
  const trimmed = host.replace(/\.$/, "");
  if (
    trimmed === "localhost" ||
    !trimmed.includes(".") ||
    LOCAL_SUFFIXES.some((suffix) => trimmed.endsWith(suffix))
  ) {
    return "local_hostname";
  }
  return null;
}

export type HostResolver = (host: string) => Promise<readonly string[]>;

/** Every address the system resolver returns for a host. */
export const systemResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * The full policy for a tenant admin's endpoint: the shape, then every address
 * the name resolves to. Returns the first violation, or null when allowed.
 */
export async function checkTenantEndpoint(
  endpoint: string,
  resolve: HostResolver = systemResolver,
): Promise<EndpointPolicyViolation | null> {
  const shape = checkEndpointShape(endpoint);
  if (shape !== null) {
    return shape;
  }
  const host = hostOf(new URL(endpoint));
  if (isIP(host) !== 0) {
    return null;
  }
  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    return "unresolvable";
  }
  if (addresses.length === 0) {
    return "unresolvable";
  }
  return addresses.some(isBlockedAddress) ? "private_address" : null;
}
