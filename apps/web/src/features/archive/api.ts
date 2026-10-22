import type { Failure } from "@/features/failures/api";
import type { EntryPreview } from "@/features/restore/api";
import { apiFetch } from "@/lib/api";

/**
 * Typed client for /api/v1/archive (apps/api/src/features/archive).
 */

/**
 * How an item was captured: the journal receiver, a copy a provider forwarded
 * (`smtp_forward`, 0.4.4), a sync from the mailbox, or an imported mail file.
 */
export type ArchiveSource = "journal" | "smtp_forward" | "graph_sync" | "imap_sync" | "file_import";

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
  /** The weaker capture of the same mail this item replaced (0.4.4); null or absent if none. */
  supersedesItemId?: string | null;
  /** A stronger capture of the same mail replaced this one (listed only with `includeSuperseded`). */
  superseded?: boolean;
  /** The other ways that captured the same mail again, each once. */
  alsoCapturedVia?: ArchiveSource[];
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
  /** Also list items a stronger capture of the same mail superseded (hidden by default). */
  includeSuperseded?: boolean;
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
  /** The weaker capture of the same mail this item replaced (0.4.4). */
  supersedesItemId?: string | null;
  /** The stronger capture of the same mail that replaced this item. */
  supersededBy?: string | null;
  /** Each time another way captured the same mail again (at most 50, oldest first). */
  captures?: { via: ArchiveSource; receivedAt: string; protectedObjectId: string | null }[];
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

// --- Capture (GET /archive/capture*, apps/api/src/features/archive-capture) ------------------

export type MailboxWay = "graph_sync" | "imap_sync";
export type StreamStatus = "pending" | "backfilling" | "live" | "paused" | "disabled" | "error";

export const STREAM_STATUSES: readonly StreamStatus[] = [
  "live",
  "backfilling",
  "pending",
  "error",
  "paused",
  "disabled",
];

export interface CaptureCounts {
  lastCapturedAt: string | null;
  /** New archive items by this way. */
  items24h: number;
  items7d: number;
  /** Mail this way captured again that the archive already held. */
  captures24h: number;
  captures7d: number;
}

export interface MailboxWayStatus extends CaptureCounts {
  way: MailboxWay;
  /** The edition includes it (gate `archive.mailboxCapture`). */
  available: boolean;
  assurance: "mailbox";
  streams: Record<StreamStatus, number>;
  /** Live streams by how mail is noticed. */
  modes: { notifications: number; poll: number };
  /** Why streams poll (a failure code), with how many streams name it. */
  pollReasons: Record<string, number>;
  /** The one-time takeover of the mail already in the mailboxes. */
  backfill: { total: number; completed: number };
  capturedLate7d: number;
}

export interface SmtpWayStatus extends CaptureCounts {
  way: "journal" | "smtp_forward";
  available: boolean;
  assurance: "transport";
}

/**
 * A mail job that archives and could capture more from the mailboxes: Graph is off for its
 * Microsoft 365 mailboxes, or its IMAP or Google accounts wait for a way since the update to
 * 0.4.4 (such jobs keep capturing as before until someone chooses).
 */
export interface CaptureJobChoice {
  jobId: string;
  name: string;
  graphOff: boolean;
  pending: ("imap" | "google")[];
}

export interface CaptureStatus {
  mailbox: MailboxWayStatus[];
  smtp: SmtpWayStatus[];
  fileImport: CaptureCounts & { assurance: "late" };
  /** Absent from servers before 0.4.4. */
  jobs?: CaptureJobChoice[];
}

export interface CaptureMailbox {
  streamId: string;
  protectedObjectId: string;
  kind: string;
  externalId: string;
  displayName: string | null;
  way: MailboxWay;
  status: StreamStatus;
  mode: "notifications" | "poll" | null;
  activatedAt: string | null;
  backfillCompletedAt: string | null;
  lastCaptureAt: string | null;
  lastSuccessAt: string | null;
  nextDueAt: string | null;
  consecutiveFailures: number;
  /** The classified failure of the last pass (FailureRecordJson), null when it worked. */
  failure: Failure | null;
}

export interface CaptureMailboxPage {
  items: CaptureMailbox[];
  nextCursor: string | null;
}

export interface CaptureMailboxQuery {
  way?: MailboxWay;
  status?: StreamStatus;
  cursor?: string;
  limit?: number;
}

/** The hold confirmation of a Microsoft 365 source (GET /archive/capture/holds). */
export interface ArchiveHold {
  sourceId: string;
  name: string;
  status: "unknown" | "confirmed";
  confirmedBy: string | null;
  confirmedAt: string | null;
  /** Mailboxes of the source captured by Graph. */
  graphMailboxes: number;
}

/**
 * A read-only command that checks holds (apps/api archive-capture/hold-checks.ts): where it
 * runs and what it is. Its text is `archive:capture.holds.checks.<id>`.
 */
export interface HoldCheck {
  id: string;
  shell: "exchange" | "compliance";
  command: string;
}

export interface ArchiveHolds {
  items: ArchiveHold[];
  /** The same for every source; absent from a server before 0.4.4. */
  checks?: HoldCheck[];
}

function captureQuery(query: CaptureMailboxQuery): string {
  return toQueryString(query as ArchiveSearchParams);
}

export function fetchCaptureStatus(): Promise<CaptureStatus> {
  return apiFetch<CaptureStatus>("/archive/capture");
}

export function fetchCaptureMailboxes(query: CaptureMailboxQuery): Promise<CaptureMailboxPage> {
  return apiFetch<CaptureMailboxPage>(`/archive/capture/mailboxes${captureQuery(query)}`);
}

export function requestCaptureResync(objectId: string): Promise<{ streams: number }> {
  return apiFetch<{ streams: number }>(
    `/archive/capture/mailboxes/${encodeURIComponent(objectId)}/resync`,
    { method: "POST" },
  );
}

export function fetchArchiveHolds(): Promise<ArchiveHolds> {
  return apiFetch<ArchiveHolds>("/archive/capture/holds");
}

export function setArchiveHold(
  sourceId: string,
  status: ArchiveHold["status"],
): Promise<ArchiveHold> {
  return apiFetch<ArchiveHold>(`/archive/capture/holds/${encodeURIComponent(sourceId)}`, {
    method: "PUT",
    body: { status },
  });
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
  capture: (tenantId: string | null) => ["tenant", tenantId, "archive", "capture"] as const,
  captureMailboxes: (tenantId: string | null, query: CaptureMailboxQuery) =>
    ["tenant", tenantId, "archive", "capture", "mailboxes", query] as const,
  holds: (tenantId: string | null) => ["tenant", tenantId, "archive", "capture", "holds"] as const,
};
