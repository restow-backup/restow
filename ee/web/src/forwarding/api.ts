import { apiFetch } from "@/lib/api";

import type { HostnameIssue, ReceiverReason } from "../journal/api";

/**
 * Typed client for /api/v1/archive/forwarding (ee/api/src/forwarding, 0.4.4).
 *
 * ASSUMED CONTRACT (workstream C, not on this branch's base yet; the merge reconciles it):
 *
 *   GET  /archive/forwarding?cursor&limit        the IMAP accounts whose job chose forwarding,
 *                                                keyset-paginated, with their address and status
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

export interface ForwardingAccount {
  objectId: string;
  displayName: string | null;
  /** The account's login (its mail address). */
  login: string;
  captureKind: "imap" | "imap_microsoft" | "google";
  /** `archive+<token>@<journal host>`; null until issued or while no journal host is set. */
  address: string | null;
  addressCreatedAt: string | null;
  lastCopyAt: string | null;
  counts: { last24Hours: number; last7Days: number };
  status: ForwardingStatus;
}

export interface ForwardingOverview {
  hostname: string | null;
  hostnameIssue: HostnameIssue | null;
  receiver: { listening: boolean; reason: ReceiverReason | null };
  items: ForwardingAccount[];
  nextCursor: string | null;
}

const FORWARDING = "/archive/forwarding";

export function fetchForwarding(cursor?: string): Promise<ForwardingOverview> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return apiFetch<ForwardingOverview>(`${FORWARDING}${query}`);
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
