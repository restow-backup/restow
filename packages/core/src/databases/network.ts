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

/** A provider admin's approval of a private address, stored with the connection. */
export interface DbPrivateNetworkApproval {
  by: string;
  at: string;
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
export function decideDbHost(assessment: HostAssessment, context: DbHostContext): DbHostDecision {
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
          approval: { by: context.actorEmail, at: context.now.toISOString() },
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
  return decideDbHost(await assessHost(host, resolve), context);
}

/** Whether the server's connections for a stored connection may reach private networks. */
export function dbMayReachPrivateNetworks(
  approval: DbPrivateNetworkApproval | null | undefined,
  privateNetworksAllowed: boolean,
): boolean {
  return privateNetworksAllowed || Boolean(approval);
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
