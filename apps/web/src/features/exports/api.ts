import type { Failure } from "@/features/failures";
import type { SelectionEntry } from "@/features/restore/api";
import { apiFetch } from "@/lib/api";

/**
 * Typed client for the mail export endpoints (apps/api/src/features/exports,
 * contract in the import/export specification). The shapes mirror the API
 * DTOs one to one; query keys carry the tenant so a tenant switch never shows
 * another tenant's exports.
 */

export type ExportFormatId = "eml_zip" | "mbox" | "msg_zip" | "pst";
export type ExportOrigin = "snapshot" | "archive";
export type ExportStatus = "queued" | "active" | "completed" | "failed" | "cancelled" | "unknown";

/** One format as `GET /exports/formats` lists it. `reason` is an English note; the UI has its own text. */
export interface ExportFormatInfo {
  id: ExportFormatId;
  available: boolean;
  planned?: boolean;
  reason?: string;
}

export interface ExportProgress {
  total: number;
  done: number;
  failed: number;
  bytes: number;
  etaSeconds: number | null;
}

export interface ExportObject {
  id: string;
  kind: "mailbox" | "onedrive" | "imap";
  externalId: string;
  displayName: string | null;
}

export interface ExportActor {
  userId: string | null;
  name: string | null;
  email: string | null;
}

export interface MailExport {
  id: string;
  jobId: string | null;
  origin: ExportOrigin;
  format: ExportFormatId;
  status: ExportStatus;
  object: ExportObject | null;
  snapshotId: string | null;
  selection: { items: number | null; folders: number | null };
  fileName: string | null;
  fileSize: number | null;
  sha256: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  /** The file can be downloaded right now (completed, not expired, not purged). */
  available: boolean;
  progress: ExportProgress | null;
  /** What the export is doing right now; only while it runs. */
  phase: string | null;
  actor: ExportActor;
  /** Exported on behalf of the owner (an admin export). */
  impersonated: boolean;
}

export interface ExportReport {
  messages: number;
  folders: number;
  bytes: number;
  failed: number;
  /** Items that are not mail and therefore left out. */
  skipped: { calendar: number; contacts: number; other: number };
  /** Messages that could not be exported, capped by the API. */
  items: { ref: string; reason: string }[];
}

export interface ExportFailure {
  itemRef: string;
  reason: string;
  attempts: number;
}

export interface MailExportDetail extends MailExport {
  reason: string | null;
  errorMessage: string | null;
  /** The classified cause of a failure, translated by FailureExplanation; null without one (older rows). */
  failure?: Failure | null;
  report: ExportReport | null;
  failures: ExportFailure[];
}

/** The archive search a filtered export repeats on the server (a subset of the archive search). */
export interface ArchiveExportFilter {
  q?: string;
  mailbox?: string;
  from?: string;
  dateFrom?: string;
  dateTo?: string;
  hasAttachment?: boolean;
}

export type ArchiveExportSelection = { itemIds: string[] } | { filter: ArchiveExportFilter };

export type CreateExportRequest =
  | {
      origin: "snapshot";
      snapshotId: string;
      selection: SelectionEntry[];
      format: ExportFormatId;
      reason?: string;
      fileName?: string;
    }
  | {
      origin: "archive";
      selection: ArchiveExportSelection;
      format: ExportFormatId;
      fileName?: string;
    };

export interface ExportCreated {
  id: string;
  jobId: string;
  status: "queued";
}

// --- Query keys ---------------------------------------------------------------

type TenantKey = string | null;

export const exportKeys = {
  all: (tenantId: TenantKey) => ["tenant", tenantId, "exports"] as const,
  formats: (tenantId: TenantKey) => ["tenant", tenantId, "exports", "formats"] as const,
  list: (tenantId: TenantKey) => ["tenant", tenantId, "exports", "list"] as const,
  detail: (tenantId: TenantKey, id: string) =>
    ["tenant", tenantId, "exports", "detail", id] as const,
};

// --- Endpoints ----------------------------------------------------------------

const id = encodeURIComponent;

export async function fetchExportFormats(): Promise<ExportFormatInfo[]> {
  const body = await apiFetch<{ formats: ExportFormatInfo[] }>("/exports/formats");
  return body.formats;
}

export function createExport(request: CreateExportRequest): Promise<ExportCreated> {
  return apiFetch<ExportCreated>("/exports", { method: "POST", body: request });
}

export async function fetchExports(): Promise<MailExport[]> {
  return (await fetchExportList()).items;
}

/** One page of the viewer's exports, newest first, with how long a finished file stays downloadable. */
export async function fetchExportList(
  offset = 0,
): Promise<{ items: MailExport[]; ttlHours: number | null }> {
  const query = offset > 0 ? `?offset=${offset}` : "";
  const body = await apiFetch<{ items: MailExport[]; ttlHours?: number }>(`/exports${query}`);
  return { items: body.items, ttlHours: typeof body.ttlHours === "number" ? body.ttlHours : null };
}

export function fetchExport(exportId: string): Promise<MailExportDetail> {
  return apiFetch<MailExportDetail>(`/exports/${id(exportId)}`);
}

export function cancelExport(exportId: string): Promise<MailExportDetail> {
  return apiFetch<MailExportDetail>(`/exports/${id(exportId)}/cancel`, { method: "POST" });
}

const rawBaseUrl = import.meta.env.VITE_API_URL as string | undefined;
const API_BASE_URL = (rawBaseUrl ?? "/api/v1").replace(/\/+$/, "");

/**
 * The browser downloads the file with a plain navigation (the cookie
 * authenticates, the file streams straight to disk). A navigation cannot
 * carry the tenant header, so the tenant travels as a query parameter, which
 * the API accepts for this route only (same as the restore download).
 */
export function exportDownloadUrl(exportId: string, tenantId: string | null): string {
  const query = tenantId ? `?tenant=${encodeURIComponent(tenantId)}` : "";
  return `${API_BASE_URL}/exports/${id(exportId)}/download${query}`;
}
