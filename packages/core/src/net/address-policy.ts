/**
 * Where Restow may open a connection to a host that someone other than the
 * operator named.
 *
 * A tenant admin configures hosts (IMAP servers) that the Restow server then
 * connects to. A tenant admin is a customer, not the operator of the server:
 * without a guard, "test connection" and every backup run would let them
 * reach the database, the other containers, the cloud metadata service and
 * the provider's LAN, and read the classified failures back (SSRF, port scan).
 *
 * The policy therefore allows public unicast addresses only. Loopback and
 * private networks are allowed where the operator decided so (an
 * installation flag, or a provider admin who saved an internal host).
 * Link-local (cloud metadata), multicast and reserved ranges are never
 * allowed. IPv4 addresses embedded in IPv6 (mapped, compatible, NAT64, 6to4)
 * are judged by the IPv4 address they reach.
 *
 * The check runs in the socket's DNS lookup ({@link guardedLookup}), so the
 * address that was checked is the address that is connected to: a name that
 * resolves to something else a second later (DNS rebinding) gains nothing.
 */
import { type LookupAddress, lookup as dnsLookup } from "node:dns";
import { lookup as dnsLookupAsync } from "node:dns/promises";
import { type LookupFunction, isIP } from "node:net";

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link_local"
  | "multicast"
  | "reserved"
  | "unspecified";

/** Error code of a connection refused by the policy (on the socket error). */
export const BLOCKED_ADDRESS_CODE = "BLOCKED_ADDRESS";

/** A connection the address policy refused; `code` is {@link BLOCKED_ADDRESS_CODE}. */
export class BlockedAddressError extends Error {
  readonly code = BLOCKED_ADDRESS_CODE;

  constructor(readonly host: string) {
    super(`connections to ${host} are not allowed: it is not a public address`);
    this.name = "BlockedAddressError";
  }
}

/** True for the policy's own refusal, however the socket layer wrapped it. */
export function isBlockedAddressError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown; _err?: unknown };
    if (candidate.code === BLOCKED_ADDRESS_CODE) {
      return true;
    }
    // imapflow keeps the underlying socket error in `_err`.
    current = candidate.cause ?? candidate._err;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function parseIPv4(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) {
    return null;
  }
  return octets as [number, number, number, number];
}

function inRange(octets: readonly number[], network: readonly number[], prefix: number): boolean {
  let remaining = prefix;
  for (let index = 0; index < 4 && remaining > 0; index++) {
    const bits = Math.min(8, remaining);
    const mask = (0xff << (8 - bits)) & 0xff;
    if (((octets[index] ?? 0) & mask) !== ((network[index] ?? 0) & mask)) {
      return false;
    }
    remaining -= bits;
  }
  return true;
}

const IPV4_RANGES: ReadonlyArray<readonly [readonly number[], number, AddressClass]> = [
  [[0, 0, 0, 0], 8, "unspecified"],
  [[10, 0, 0, 0], 8, "private"],
  [[100, 64, 0, 0], 10, "private"],
  [[127, 0, 0, 0], 8, "loopback"],
  [[169, 254, 0, 0], 16, "link_local"],
  [[172, 16, 0, 0], 12, "private"],
  [[192, 0, 0, 0], 24, "reserved"],
  [[192, 0, 2, 0], 24, "reserved"],
  [[192, 88, 99, 0], 24, "reserved"],
  [[192, 168, 0, 0], 16, "private"],
  [[198, 18, 0, 0], 15, "reserved"],
  [[198, 51, 100, 0], 24, "reserved"],
  [[203, 0, 113, 0], 24, "reserved"],
  [[224, 0, 0, 0], 4, "multicast"],
  [[240, 0, 0, 0], 4, "reserved"],
];

function classifyIPv4(octets: readonly number[]): AddressClass {
  for (const [network, prefix, kind] of IPV4_RANGES) {
    if (inRange(octets, network, prefix)) {
      return kind;
    }
  }
  return "public";
}

/** Eight 16-bit groups, or null for text that is not an IPv6 address. */
function parseIPv6(input: string): number[] | null {
  let text = input.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) {
    text = text.slice(0, zone);
  }
  // A trailing dotted quad (::ffff:10.0.0.1) becomes two groups.
  const lastColon = text.lastIndexOf(":");
  if (lastColon >= 0 && text.includes(".", lastColon)) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (!v4) {
      return null;
    }
    const [a, b, c, d] = v4;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 2 && missing < 1) || (halves.length === 1 && missing !== 0)) {
    return null;
  }
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const values = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN,
  );
  return values.length === 8 && values.every((value) => !Number.isNaN(value)) ? values : null;
}

function embeddedIPv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function classifyIPv6(groups: readonly number[]): AddressClass {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (leadingZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return g7 === 0 ? "unspecified" : "loopback";
  }
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
  if (leadingZero && (g5 === 0xffff || g5 === 0)) {
    return classifyIPv4(embeddedIPv4(g6, g7));
  }
  // NAT64 (64:ff9b::/96) reaches the embedded IPv4 host.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyIPv4(embeddedIPv4(g6, g7));
  }
  // 6to4 (2002::/16) embeds the IPv4 address in the next 32 bits.
  if (g0 === 0x2002) {
    return classifyIPv4(embeddedIPv4(g1, g2));
  }
  if ((g0 & 0xffc0) === 0xfe80) {
    return "link_local";
  }
  // Unique local (fc00::/7) and the deprecated site-local (fec0::/10).
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfec0) {
    return "private";
  }
  if ((g0 & 0xff00) === 0xff00) {
    return "multicast";
  }
  // Teredo (2001::/32) tunnels to an obfuscated IPv4 host; documentation (2001:db8::/32).
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0x0db8)) {
    return "reserved";
  }
  // Only global unicast (2000::/3) is public; everything else is unassigned or special.
  return (g0 & 0xe000) === 0x2000 ? "public" : "reserved";
}

/** Classify a literal IPv4 or IPv6 address; anything unparseable counts as reserved. */
export function classifyAddress(address: string): AddressClass {
  const bare = address.trim().replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(bare);
  if (v4) {
    return classifyIPv4(v4);
  }
  const v6 = parseIPv6(bare);
  return v6 ? classifyIPv6(v6) : "reserved";
}

/** Public addresses always; loopback and private networks only where the operator allows them. */
export function isAddressAllowed(address: string, allowPrivateNetworks: boolean): boolean {
  const kind = classifyAddress(address);
  if (kind === "public") {
    return true;
  }
  return allowPrivateNetworks && (kind === "private" || kind === "loopback");
}

// ---------------------------------------------------------------------------
// Host names
// ---------------------------------------------------------------------------

const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".home.arpa",
  ".localdomain",
];

/** Lowercase, without IPv6 brackets and without the root dot. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

/**
 * A name that only exists on a local network: `localhost`, single labels
 * (container and NetBIOS names such as `postgres`) and the local-only suffixes.
 */
export function isLocalHostname(host: string): boolean {
  const name = normalizeHost(host);
  return (
    name === "localhost" ||
    !name.includes(".") ||
    LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/** How a configured host relates to the policy, as far as it can be told without connecting. */
export type HostAssessment =
  /** Every address the name resolves to (or the literal) is public. */
  | "public"
  /** Loopback, a private network or a local-only name: allowed only with the operator's consent. */
  | "private"
  /** Link-local, multicast or reserved: never allowed. */
  | "forbidden"
  /** The name does not resolve right now; the connection itself will be judged again. */
  | "unresolvable";

export type HostResolver = (host: string) => Promise<readonly string[]>;

/** Every address the system resolver returns for a host. */
export const systemResolver: HostResolver = async (host) =>
  (await dnsLookupAsync(host, { all: true, verbatim: true })).map((entry) => entry.address);

function assessAddresses(addresses: readonly string[]): HostAssessment {
  const kinds = addresses.map(classifyAddress);
  if (kinds.some((kind) => kind !== "public" && kind !== "private" && kind !== "loopback")) {
    return "forbidden";
  }
  return kinds.every((kind) => kind === "public") ? "public" : "private";
}

/**
 * Judge a host before it is saved: literal addresses and local-only names
 * without the network, other names by what they resolve to right now.
 */
export async function assessHost(
  host: string,
  resolve: HostResolver = systemResolver,
): Promise<HostAssessment> {
  const name = normalizeHost(host);
  if (isIP(name) !== 0) {
    return assessAddresses([name]);
  }
  if (isLocalHostname(name)) {
    return "private";
  }
  let addresses: readonly string[];
  try {
    addresses = await resolve(name);
  } catch {
    return "unresolvable";
  }
  return addresses.length === 0 ? "unresolvable" : assessAddresses(addresses);
}

/**
 * The checks that need no network, for the moment right before connecting:
 * a literal address never goes through the lookup, and a local-only name is
 * refused without asking the resolver (whose answer would tell a customer
 * which internal names exist). Returns the refusal, or null to go ahead.
 */
export function refuseHostBeforeConnect(
  host: string,
  allowPrivateNetworks: boolean,
): BlockedAddressError | null {
  const name = normalizeHost(host);
  if (isIP(name) !== 0) {
    return isAddressAllowed(name, allowPrivateNetworks) ? null : new BlockedAddressError(host);
  }
  if (!allowPrivateNetworks && isLocalHostname(name)) {
    return new BlockedAddressError(host);
  }
  return null;
}

/**
 * A DNS lookup for `net.connect` / `tls.connect` that refuses to hand out a
 * disallowed address: when any address of the name is not allowed, the
 * connection fails with a {@link BlockedAddressError}.
 */
export function guardedLookup(allowPrivateNetworks: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, found) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      const addresses: LookupAddress[] = Array.isArray(found) ? found : [];
      const refused =
        addresses.length === 0 ||
        addresses.some((entry) => !isAddressAllowed(entry.address, allowPrivateNetworks));
      if (refused) {
        callback(new BlockedAddressError(hostname), "", 0);
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const [first] = addresses;
      callback(null, first?.address ?? "", first?.family ?? 4);
    });
  };
}
