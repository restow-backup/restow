/**
 * Which address a file share run may connect to (docs/FILESHARES.md 10.1). The host kernel mounts
 * the share from the Docker host's network, so a tenant admin who could enter any address could
 * make Restow read the provider's internal file servers into their backups. The rule is the IMAP
 * rule (../net/address-policy.ts): public addresses always; loopback and private addresses only
 * where a provider admin approved the share (the approval covers its address's /24 or /64, so a
 * DHCP renewal does not break backups) or the installation lets tenants use private networks;
 * link-local, multicast and reserved addresses never. Judged when a share is saved and on every
 * run and test: the worker resolves the name, judges every address and pins one (`addr=`).
 */
import { isIP } from "node:net";
import { classifyAddress } from "../net/address-policy.js";

export interface ShareAddressApproval {
  address: string;
}

export type ShareAddressDecision =
  | { ok: true; address: string }
  | { ok: false; reason: "forbidden_address" | "private_network" | "unresolvable" };

function ipv4Bytes(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return null;
  }
  return parts.map(Number);
}

/** The eight 16-bit groups of an IPv6 address, or null. */
function ipv6Groups(address: string): number[] | null {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (isIP(bare) !== 6) {
    return null;
  }
  let text = bare;
  // An embedded IPv4 tail becomes two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4?.[1]) {
    const bytes = ipv4Bytes(v4[1]);
    if (!bytes) {
      return null;
    }
    const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = bytes;
    const high = ((b0 << 8) | b1).toString(16);
    const low = ((b2 << 8) | b3).toString(16);
    text = `${text.slice(0, -v4[1].length)}${high}:${low}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) {
    return null;
  }
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

/** Whether `address` lies in the /24 (IPv4) or /64 (IPv6) of the approved address. */
export function approvalCovers(approved: string, address: string): boolean {
  const a4 = ipv4Bytes(approved);
  const b4 = ipv4Bytes(address);
  if (a4 && b4) {
    return a4[0] === b4[0] && a4[1] === b4[1] && a4[2] === b4[2];
  }
  const a6 = ipv6Groups(approved);
  const b6 = ipv6Groups(address);
  if (a6 && b6) {
    return a6.slice(0, 4).every((group, index) => group === b6[index]);
  }
  return false;
}

/** The range an approval covers, for the record (`10.0.0.0/24`, `fd00:1:2:3::/64`). */
export function approvalRange(address: string): string {
  const v4 = ipv4Bytes(address);
  if (v4) {
    return `${v4[0]}.${v4[1]}.${v4[2]}.0/24`;
  }
  const v6 = ipv6Groups(address);
  if (v6) {
    return `${v6
      .slice(0, 4)
      .map((group) => group.toString(16))
      .join(":")}::/64`;
  }
  return address;
}

/**
 * Judge the addresses a share's server resolves to and pick the one to pin: refused when any is
 * forbidden (the name could be rebound to it), or when a private one is neither approved nor
 * allowed for every tenant. IPv4 is preferred (cifs and NFS servers are reached over it more
 * often than not).
 */
export function judgeShareAddresses(
  addresses: readonly string[],
  policy: { privateNetworksAllowed: boolean; approval: ShareAddressApproval | null },
): ShareAddressDecision {
  if (addresses.length === 0) {
    return { ok: false, reason: "unresolvable" };
  }
  const allowed: string[] = [];
  for (const address of addresses) {
    const kind = classifyAddress(address);
    if (kind === "public") {
      allowed.push(address);
      continue;
    }
    if (kind !== "private" && kind !== "loopback") {
      return { ok: false, reason: "forbidden_address" };
    }
    if (
      policy.privateNetworksAllowed ||
      (policy.approval !== null && approvalCovers(policy.approval.address, address))
    ) {
      allowed.push(address);
      continue;
    }
    return { ok: false, reason: "private_network" };
  }
  const v4 = allowed.find((address) => isIP(address) === 4);
  return { ok: true, address: v4 ?? (allowed[0] as string) };
}
