import { apiFetch } from "@/lib/api";

/**
 * Typed client of `/api/v1/audit` (apps/api/src/features/audit). Times are
 * ISO-8601 strings; `tenantId: null` always means the installation chain.
 */

export const INSTALLATION_CHAIN = "installation";

export interface AuditEntry {
  id: string;
  tenantId: string | null;
  tenantName: string | null;
  actor: string;
  actorUserId: string | null;
  action: string;
  target: string | null;
  targetType: string | null;
  /** The target's current name, when the server could resolve it (older servers omit it). */
  targetLabel?: string | null;
  onBehalfOf: string | null;
  ip: string | null;
  details: Record<string, unknown> | null;
  prevHash: string | null;
  chainHash: string;
  /** The entry's own hash still recomputes from its stored fields. */
  hashValid: boolean;
  createdAt: string;
}

export interface AuditPage {
  items: AuditEntry[];
  next: string | null;
}

export interface AuditActionCount {
  action: string;
  count: number;
}

export type ChainStatus = "intact" | "broken" | "empty";

export type ChainBreak =
  | {
      reason: "hash_mismatch";
      position: number;
      entryId: string;
      createdAt: string;
      storedHash: string;
      computedHash: string;
    }
  | {
      reason: "link_mismatch";
      position: number;
      entryId: string;
      createdAt: string;
      expectedPrevHash: string | null;
      storedPrevHash: string | null;
    }
  | {
      reason: "anchor_mismatch";
      position: number;
      anchorDate: string;
      anchoredHash: string;
      anchoredCount: number;
      chainHash: string | null;
      chainCount: number;
    };

export interface AnchorRecord {
  date: string;
  lastHash: string;
  count: number;
}

export interface ChainReport {
  tenantId: string | null;
  tenantName: string | null;
  status: ChainStatus;
  verifiedEntries: number;
  head: { hash: string; createdAt: string } | null;
  anchors: { total: number; verified: number; latest: AnchorRecord | null };
  firstBreak: ChainBreak | null;
}

export interface ChainVerification {
  status: ChainStatus;
  verifiedAt: string;
  durationMs: number;
  chains: ChainReport[];
}

/** Filters as the API takes them (instants, not calendar days). */
export interface AuditQuery {
  tenant?: string;
  action?: string;
  actor?: string;
  target?: string;
  from?: string;
  to?: string;
}

export const AUDIT_PAGE_SIZE = 50;

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

/** The export of the filtered log (GET /audit/export), as CSV or JSON. */
export function auditExportPath(query: AuditQuery, format: "csv" | "json"): string {
  return `/audit/export${queryString({ ...query, format })}`;
}

export function fetchAuditEntries(query: AuditQuery, cursor: string | null): Promise<AuditPage> {
  return apiFetch<AuditPage>(
    `/audit${queryString({ ...query, limit: AUDIT_PAGE_SIZE, cursor: cursor ?? undefined })}`,
  );
}

export function fetchAuditEntry(entryId: string): Promise<AuditEntry> {
  return apiFetch<AuditEntry>(`/audit/${encodeURIComponent(entryId)}`);
}

export async function fetchAuditActions(tenant: string | undefined): Promise<AuditActionCount[]> {
  const page = await apiFetch<{ items: AuditActionCount[] }>(
    `/audit/actions${queryString({ tenant })}`,
  );
  return page.items;
}

export function fetchChainVerification(tenant: string | undefined): Promise<ChainVerification> {
  return apiFetch<ChainVerification>(`/audit/verify${queryString({ tenant })}`);
}

/**
 * Query keys. `scope` separates what differs per requester: the provider's
 * installation-wide view, or a tenant admin's active tenant.
 */
export const auditKeys = {
  all: (scope: string) => ["audit", scope] as const,
  entries: (scope: string, query: AuditQuery) => ["audit", scope, "entries", query] as const,
  entry: (scope: string, entryId: string) => ["audit", scope, "entry", entryId] as const,
  actions: (scope: string, tenant: string | undefined) =>
    ["audit", scope, "actions", tenant ?? "all"] as const,
  verification: (scope: string, tenant: string | undefined) =>
    ["audit", scope, "verify", tenant ?? "all"] as const,
};
