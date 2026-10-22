import { apiFetch } from "@/lib/api";

import type { HostnameIssue, ReceiverReason } from "../journal/api";

/**
 * Typed client for /api/v1/archive/forwarding (ee/api/src/forwarding/service.ts, 0.4.4;
 * aligned with workstream C's contract, which merges separately):
 *
 *   GET  /archive/forwarding?wanted&cursor&limit the IMAP accounts (with `wanted=true` those
 *                                                whose job chose forwarding), by login,
 *                                                keyset-paginated, with address and status
 *   POST /archive/forwarding/:objectId/address   issue the account's address (idempotent,
 *                                                audited `archive.forward.address_created`)
 *   POST /archive/forwarding/:objectId/rotate    a new address, the old one stops at once
 *                                                (audited `archive.forward.address_rotated`)
 *
 * The routes answer 404 without `archive.journalReceiver`, like the journal's.
 */

/**
 * `receiving`: a copy arrived in the last 24 hours; `stale`: copies came, but none for 24
 * hours; `no_copies`: the address exists, nothing arrived yet; `no_address`: no address issued.
 */
export type ForwardingStatus = "receiving" | "stale" | "no_copies" | "no_address";

/** Forwarded copies of the last 7 days (items and capture rows). */
export interface ForwardActivity {
  lastCopyAt: string | null;
  last24Hours: number;
  last7Days: number;
}

export interface ForwardingAccount {
  objectId: string;
  /** The account's login (its mail address). */
  login: string;
  displayName: string | null;
  sourceId: string;
  sourceName: string;
  captureKind: "imap" | "imap_microsoft" | "google";
  /** A mail job that archives the account chose the forwarded copy. */
  forwardWanted: boolean;
  /** `archive+<token>@<journal host>`; null until issued or while no journal host is set. */
  address: string | null;
  localPart: string | null;
  addressCreatedAt: string | null;
  status: ForwardingStatus;
  activity: ForwardActivity;
}

export interface ForwardingOverview {
  hostname: string | null;
  hostnameIssue: HostnameIssue | null;
  receiver: { listening: boolean; reason: ReceiverReason | null };
  /** The tenant's journal address for domain-wide routing; null until the journal setup issued it. */
  tenantAddress: string | null;
  /** Plain copies that arrived at the tenant's journal address. */
  tenantActivity: ForwardActivity;
  accounts: ForwardingAccount[];
  nextCursor: string | null;
  docsUrl: string | null;
}

const FORWARDING = "/archive/forwarding";

/** The accounts whose job chose forwarding, one page. */
export function fetchForwarding(cursor?: string): Promise<ForwardingOverview> {
  const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
  return apiFetch<ForwardingOverview>(`${FORWARDING}?wanted=true${query}`);
}

export function createForwardAddress(objectId: string): Promise<ForwardingAccount> {
  return apiFetch<ForwardingAccount>(`${FORWARDING}/${encodeURIComponent(objectId)}/address`, {
    method: "POST",
  });
}

export function rotateForwardAddress(objectId: string): Promise<ForwardingAccount> {
  return apiFetch<ForwardingAccount>(`${FORWARDING}/${encodeURIComponent(objectId)}/rotate`, {
    method: "POST",
  });
}

export const forwardingKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "archive", "forwarding"] as const,
  page: (tenantId: string | null, cursor: string | null) =>
    ["tenant", tenantId, "archive", "forwarding", cursor] as const,
};
