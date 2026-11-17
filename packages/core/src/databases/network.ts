import { isIP } from "node:net";
import {
  type AddressClass,
  assessHost,
  classifyAddress,
  type HostAssessment,
  type HostResolver,
  isLocalHostname,
  normalizeHost,
  systemResolver,
} from "../net/address-policy.js";

/**
 * Network protection of the Restow server as executor (docs/DATABASES.md 4.2 and 10), as for
 * IMAP (apps/api features/sources/imap-host.ts, net/address-policy.ts): a tenant admin may only
 * enter public addresses. An address in a private network or a container name is approved by a
 * provider admin (per connection, audited) or by the installation with
 * `RESTOW_DB_ALLOW_PRIVATE_NETWORKS=true`. Link-local and reserved addresses (the cloud metadata
 * service) are refused for everyone. It is checked when a connection is saved and again on every
 * connection: the probe's socket resolves through the guarded lookup, so a name that resolves
 * elsewhere later gains nothing.
 *
 * The server never connects to a public address without TLS (3.2), whatever the connection says.
 * An agent as executor is in the customer's own network and is not limited here.
 */

/** The installation flag. */
export const DB_ALLOW_PRIVATE_NETWORKS_ENV = "RESTOW_DB_ALLOW_PRIVATE_NETWORKS";

/**
 * A provider admin's approval of a private address, stored with the connection. It holds the
 * address the approved test connected to and signed in on (or the literal address): the server's
 * connections reach those and no other private address, so a name that later points elsewhere in
 * the network gains nothing.
 */
export interface DbPrivateNetworkApproval {
  by: string;
  at: string;
  addresses?: string[];
}

/** An address as the approval keeps it: lowercase, no brackets, IPv4 without the IPv6 mapping. */
export function dbCanonicalAddress(address: string): string {
  const bare = normalizeHost(address);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  return mapped?.[1] ?? bare;
}

/** Whether a connection with this approval may reach `address` (public ones are no question). */
export function dbApprovedAddress(
  approval:
    | Pick<DbPrivateNetworkApproval, "addresses">
    | DbPrivateNetworkApproval
    | null
    | undefined,
  address: string,
): boolean {
  const canonical = dbCanonicalAddress(address);
  const kind = classifyAddress(canonical);
  return (
    (kind === "private" || kind === "loopback") &&
    (approval?.addresses ?? []).some((entry) => dbCanonicalAddress(entry) === canonical)
  );
}

export interface DbHostContext {
  isProviderAdmin: boolean;
  /** `RESTOW_DB_ALLOW_PRIVATE_NETWORKS=true`. */
  privateNetworksAllowed: boolean;
  actorEmail: string;
  now: Date;
}

export type DbHostRefusal = "db_private_network" | "db_forbidden_address";

export type DbHostDecision =
  | { kind: "allowed"; approval: DbPrivateNetworkApproval | null }
  | { kind: "refused"; reason: DbHostRefusal };

/** What saving (or testing) a host with this assessment means for the server executor (pure). */
export function decideDbHost(
  assessment: HostAssessment,
  context: DbHostContext,
  addresses?: readonly string[],
): DbHostDecision {
  switch (assessment) {
    case "public":
    case "unresolvable":
      // An unresolvable name is judged again when the connection resolves it.
      return { kind: "allowed", approval: null };
    case "forbidden":
      return { kind: "refused", reason: "db_forbidden_address" };
    case "private":
      if (context.isProviderAdmin) {
        return {
          kind: "allowed",
          approval: {
            by: context.actorEmail,
            at: context.now.toISOString(),
            addresses: [...new Set((addresses ?? []).map(dbCanonicalAddress))].slice(0, 16),
          },
        };
      }
      return context.privateNetworksAllowed
        ? { kind: "allowed", approval: null }
        : { kind: "refused", reason: "db_private_network" };
  }
}

/** Judge a host for the server executor: by name, and by what it resolves to now. */
export async function judgeDbHost(
  host: string,
  context: DbHostContext,
  resolve: HostResolver = systemResolver,
): Promise<DbHostDecision> {
  const assessment = await assessHost(host, resolve);
  // An approval names the addresses it is for: a literal here; for a name, the address the
  // probe actually connected to and signed in on is added by the server (never a lookup of
  // its own, which could see another answer than the probe's connection).
  const name = normalizeHost(host);
  const literal = isIP(name) !== 0 && dbPlaintextAllowedFor(classifyAddress(name));
  return decideDbHost(assessment, context, literal ? [name] : []);
}

/**
 * Whether the server's connections for a stored connection may reach a private address at all:
 * with the installation flag any, with an approval only the addresses it names.
 */
export function dbMayReachPrivateNetworks(
  approval: DbPrivateNetworkApproval | null | undefined,
  privateNetworksAllowed: boolean,
): boolean {
  return privateNetworksAllowed || (approval?.addresses?.length ?? 0) > 0;
}

/**
 * Whether the server may connect to this address without TLS: never to a public one (3.2). A
 * name is judged by what it resolves to; a local-only name and a literal private or loopback
 * address may go unencrypted when the administrator ticked it.
 */
export function dbPlaintextAllowedFor(addressClass: AddressClass): boolean {
  return addressClass === "private" || addressClass === "loopback";
}

/** The class of the address a host stands for, as far as it can be told: local names count as private. */
export async function dbHostClass(
  host: string,
  resolve: HostResolver = systemResolver,
): Promise<AddressClass | "unresolvable"> {
  const name = normalizeHost(host);
  if (isIP(name) !== 0) {
    return classifyAddress(name);
  }
  if (isLocalHostname(name)) {
    return "private";
  }
  try {
    const addresses = await resolve(name);
    if (addresses.length === 0) {
      return "unresolvable";
    }
    const classes = addresses.map(classifyAddress);
    // The weakest answer counts: one public address makes the name public.
    return classes.includes("public") ? "public" : (classes[0] as AddressClass);
  } catch {
    return "unresolvable";
  }
}
