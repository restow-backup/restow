import type { EntryPreview } from "@/features/restore/api";
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

/** One entry of the chain, as a person finds it again: 1-based position, subject and date. */
export interface ChainEntryRef {
  /** 0-based index (kept for API clients of the first version). */
  index: number;
  /** 1-based position in the chain. */
  position: number;
  itemId: string;
  subject: string | null;
  receivedAt: string;
}

export interface ChainBreak extends ChainEntryRef {
  expectedChainHash: string;
  actualChainHash: string;
}

/** Why a stored message could not be compared: not recorded, different bytes, or not readable. */
export type ArchiveContentProblem = "not_recorded" | "mismatch" | "unreadable";

/**
 * The archive check (GET /archive/chain/verify, apps/api/src/features/archive/verify.ts):
 * links, daily anchors and an optional content sample, each with what it covered.
 */
export interface ChainVerification {
  ok: boolean;
  checkedAt: string;
  /** Entries whose links were recomputed: the whole chain. */
  checked: number;
  brokenAt: ChainBreak | null;
  anchors: {
    checked: number;
    latestDate: string | null;
    /** Entries after the newest anchor, not covered by the anchor check yet. */
    unsealed: number;
    failed: { date: string; count: number; reason: "missing" | "mismatch" } | null;
  };
  content: {
    requested: number;
    checked: number;
    notRecorded: number;
    failures: {
      itemId: string;
      subject: string | null;
      receivedAt: string;
      problem: ArchiveContentProblem;
    }[];
  };
}

/** How many messages the content sample reads back at most (MAX_CONTENT_SAMPLE in the API). */
export const CONTENT_SAMPLE = 100;

export function verifyArchiveChain(contentSample = 0): Promise<ChainVerification> {
  const query = contentSample > 0 ? `?contentSample=${contentSample}` : "";
  return apiFetch<ChainVerification>(`/archive/chain/verify${query}`);
}

/** The reading pane of an archived message: the same sanitised view as the restore explorer's. */
export function fetchArchivePreview(id: string): Promise<EntryPreview> {
  return apiFetch<EntryPreview>(`/archive/items/${encodeURIComponent(id)}/preview`);
}

const rawBaseUrl = import.meta.env.VITE_API_URL as string | undefined;
const API_BASE_URL = (rawBaseUrl ?? "/api/v1").replace(/\/+$/, "");

/**
 * The original message as `.eml`, verified against its recorded SHA-256 and
 * audited. A plain browser navigation cannot carry the tenant header, so the
 * tenant travels as a query parameter (as with the export and restore downloads).
 */
export function archiveItemDownloadUrl(id: string, tenantId: string | null): string {
  const query = tenantId ? `?tenant=${encodeURIComponent(tenantId)}` : "";
  return `${API_BASE_URL}/archive/items/${encodeURIComponent(id)}/download${query}`;
}

/** The retention that applies to the tenant's archive (GET /archive/retention). */
export interface ArchiveRetention {
  /** `from_capture` counts from the day of capture, `end_of_year` to the end of the year of receipt. */
  mode: "from_capture" | "end_of_year";
  /** Years to keep; null keeps without end. */
  years: number | null;
  /** A policy of the tenant's own, or the default every tenant starts with. */
  source: "default" | "tenant";
}

export function fetchArchiveRetention(): Promise<ArchiveRetention> {
  return apiFetch<ArchiveRetention>("/archive/retention");
}

export const archiveKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "archive"] as const,
  search: (tenantId: string | null, params: ArchiveSearchParams) =>
    ["tenant", tenantId, "archive", "search", params] as const,
  item: (tenantId: string | null, id: string) =>
    ["tenant", tenantId, "archive", "item", id] as const,
  preview: (tenantId: string | null, id: string) =>
    ["tenant", tenantId, "archive", "item", id, "preview"] as const,
  chain: (tenantId: string | null) => ["tenant", tenantId, "archive", "chain"] as const,
  retention: (tenantId: string | null) => ["tenant", tenantId, "archive", "retention"] as const,
};
