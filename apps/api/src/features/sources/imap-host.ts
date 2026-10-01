import { type HostAssessment, type HostResolver, assessHost, systemResolver } from "@restow/core";
import type { SourceConfig } from "@restow/db";
import { productName } from "@restow/i18n";
import { ProblemError } from "../../problem.js";

/**
 * Which IMAP hosts a source may point at (docs/IMAP.md).
 *
 * Restow connects to the host from its own servers: for the connection test
 * in the API and for every backup and restore in the worker. A tenant admin
 * is a customer, so their hosts must be public; a host in a loopback or
 * private network (a container name, the provider's LAN) is the operator's
 * decision. It is made either for the whole installation
 * (`IMAP_ALLOW_PRIVATE_NETWORKS=true`) or per source, by a provider admin who
 * saves the host: that approval is recorded on the source and is what lets
 * the worker connect. Link-local and reserved addresses (the cloud metadata
 * service) are refused for everyone.
 *
 * What is decided here when a source is saved is checked again on every
 * connection (@restow/core net/address-policy.ts), so a name that resolves
 * elsewhere later gains nothing.
 */

export type PrivateNetworkApproval = NonNullable<SourceConfig["privateNetworkApproval"]>;

/** Who saves the host, and what the installation allows. */
export interface ImapHostContext {
  /** Provider admins operate the installation; their word approves an internal host. */
  isProviderAdmin: boolean;
  /** The installation flag `IMAP_ALLOW_PRIVATE_NETWORKS`. */
  privateNetworksAllowed: boolean;
  actorEmail: string;
  now: Date;
}

export type ImapHostRefusal = "private_network" | "forbidden_address";

export type ImapHostDecision =
  | {
      kind: "allowed";
      /** The approval to store on the source; null when the host needs none. */
      approval: PrivateNetworkApproval | null;
    }
  | { kind: "refused"; reason: ImapHostRefusal };

/** What saving a host with this assessment means (pure). */
export function decideImapHost(
  assessment: HostAssessment,
  context: ImapHostContext,
): ImapHostDecision {
  switch (assessment) {
    case "public":
    case "unresolvable":
      // An unresolvable name is judged again when a connection resolves it.
      return { kind: "allowed", approval: null };
    case "forbidden":
      return { kind: "refused", reason: "forbidden_address" };
    case "private":
      if (context.isProviderAdmin) {
        return {
          kind: "allowed",
          approval: { by: context.actorEmail, at: context.now.toISOString() },
        };
      }
      return context.privateNetworksAllowed
        ? { kind: "allowed", approval: null }
        : { kind: "refused", reason: "private_network" };
  }
}

/** What the refusal says; built per call so the product name is the configured one. */
function refusalDetail(reason: ImapHostRefusal): string {
  return reason === "private_network"
    ? "The IMAP server is in a loopback or private network. Only a provider admin can connect a source to an internal server."
    : `The IMAP server address is link-local, multicast or reserved; ${productName()} never connects there.`;
}

/** 422 for a host the actor may not save. */
export function imapHostNotAllowed(reason: ImapHostRefusal): ProblemError {
  return new ProblemError(422, "IMAP server not allowed", {
    type: "urn:restow:problem:imap-host-not-allowed",
    detail: refusalDetail(reason),
    extensions: { field: "host", reason },
  });
}

/**
 * Judge a host that is about to be saved and return the approval to store
 * with it; throws {@link imapHostNotAllowed} when the actor may not use it.
 */
export async function approveImapHost(
  host: string,
  context: ImapHostContext,
  resolve: HostResolver = systemResolver,
): Promise<PrivateNetworkApproval | null> {
  const decision = decideImapHost(await assessHost(host, resolve), context);
  if (decision.kind === "refused") {
    throw imapHostNotAllowed(decision.reason);
  }
  return decision.approval;
}

/**
 * Whether connections for a stored source may reach private networks: the
 * installation flag or the approval a provider admin left on the source.
 */
export function storedHostMayBePrivate(
  config: Pick<SourceConfig, "privateNetworkApproval">,
  privateNetworksAllowed: boolean,
): boolean {
  return privateNetworksAllowed || Boolean(config.privateNetworkApproval);
}

/** A stored IMAP endpoint and the approval it carries. */
export interface StoredImapEndpoint {
  host: string | null;
  port: number | null;
  config: Pick<SourceConfig, "privateNetworkApproval">;
}

/**
 * Whether a connection test from the form may reach private networks: a
 * provider admin may test any server, and an approved source may be tested
 * by its tenant admins as long as host and port are the approved ones.
 */
export function probeMayReachPrivateNetworks(
  context: Pick<ImapHostContext, "isProviderAdmin" | "privateNetworksAllowed">,
  stored: StoredImapEndpoint | null,
  target: { host: string; port: number },
): boolean {
  if (context.isProviderAdmin || context.privateNetworksAllowed) {
    return true;
  }
  return (
    stored !== null &&
    Boolean(stored.config.privateNetworkApproval) &&
    (stored.host ?? "").trim().toLowerCase() === target.host.trim().toLowerCase() &&
    stored.port === target.port
  );
}
