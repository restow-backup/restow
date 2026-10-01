import { apiFetch } from "@/lib/api";

/**
 * Typed client for /api/v1/archive (apps/api/src/features/archive).
 */

/** How an item was captured: the journal receiver, a sync, or an imported mail file. */
export type ArchiveSource = "journal" | "graph_sync" | "imap_sync" | "file_import";

export interface ArchiveSearchResult {
  id: string;
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  receivedAt: string;
  /** When the sender sent the mail, if the message says so; the date the list shows in preference to `receivedAt`. */
  sentAt?: string | null;
  hasAttachment: boolean;
  sizeBytes: number | null;
  flags: string[];
  source: ArchiveSource;
}

export interface ArchiveSearchResponse {
  items: ArchiveSearchResult[];
  total: number;
  limit: number;
  offset: number;
}

export interface ArchiveSearchParams {
  q?: string;
  mailbox?: string;
  from?: string;
  dateFrom?: string;
  dateTo?: string;
  hasAttachment?: boolean;
  limit?: number;
  offset?: number;
}

function toQueryString(params: ArchiveSearchParams): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      usp.set(key, String(value));
    }
  }
  const query = usp.toString();
  return query ? `?${query}` : "";
}

export function searchArchive(params: ArchiveSearchParams): Promise<ArchiveSearchResponse> {
  return apiFetch<ArchiveSearchResponse>(`/archive/search${toQueryString(params)}`);
}

export interface ArchiveItem {
  id: string;
  tenantId: string;
  receivedAt: string;
  itemHash: string;
  chainHash: string;
  size: number;
  envelope: {
    sender: string | null;
    subject: string | null;
    messageId: string | null;
    recipients: { address: string; type: "to" | "cc" | "bcc" }[];
  } | null;
  flags: string[];
  source: ArchiveSource;
  retentionUntil: string | null;
}

export function fetchArchiveItem(id: string): Promise<ArchiveItem> {
  return apiFetch<ArchiveItem>(`/archive/items/${encodeURIComponent(id)}`);
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenAt: { index: number; expectedChainHash: string; actualChainHash: string } | null;
}

export function verifyArchiveChain(): Promise<ChainVerification> {
  return apiFetch<ChainVerification>("/archive/chain/verify");
}

export const archiveKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "archive"] as const,
  search: (tenantId: string | null, params: ArchiveSearchParams) =>
    ["tenant", tenantId, "archive", "search", params] as const,
  item: (tenantId: string | null, id: string) =>
    ["tenant", tenantId, "archive", "item", id] as const,
  chain: (tenantId: string | null) => ["tenant", tenantId, "archive", "chain"] as const,
};
