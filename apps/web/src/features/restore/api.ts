import type { JobThrottle } from "@/features/jobs/api";
import type { ObjectState, SnapshotVerification } from "@/features/verify/api";
import { apiFetch } from "@/lib/api";

/**
 * Typed client for the snapshot explorer and restore endpoints
 * (apps/api/src/features/snapshots, apps/api/src/features/restore). The
 * shapes mirror the API DTOs one to one; query keys carry the tenant so a
 * tenant switch never shows another tenant's data.
 */

export type ObjectKind = "mailbox" | "onedrive" | "imap";
export type ObjectStatus = "active" | "excluded" | "orphaned";
export type EntryKind = "mail" | "folder" | "file" | "event" | "contact";
export type RestoreTargetType = "original" | "other" | "download";
export type RestoreMode = "rename" | "replace" | "skip";
export type RestoreStatus = "queued" | "active" | "completed" | "failed" | "cancelled" | "unknown";

/** m365 or imap: which source backs an object up (apps/api .../snapshots/service.ts). */
export type SourceKind = "m365" | "imap" | "import";

export interface SnapshotObject {
  id: string;
  kind: ObjectKind;
  externalId: string;
  displayName: string | null;
  status: ObjectStatus;
  sourceKind: SourceKind;
  ownerEmail: string | null;
  /** The object belongs to the signed-in person (self-service restore). */
  own: boolean;
  snapshotCount: number;
  latestSnapshotId: string | null;
  latestSnapshotAt: string | null;
  /** Whether the newest backup (if any) is proven restorable; see `@/features/verify/api`. */
  readiness: ObjectState;
}

export interface Snapshot {
  id: string;
  objectId: string;
  sequence: number;
  itemCount: number;
  byteSize: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** A point in time in the snapshot list, with the verification of exactly that backup. */
export interface ListedSnapshot extends Snapshot {
  verification: SnapshotVerification;
}

/**
 * Why a mail cannot be previewed or exported in the clear: rights-managed by
 * Microsoft Purview, or S/MIME-encrypted. Restoring the item into a mailbox
 * still works either way (the recipient's own rights apply there); only
 * reading it back through Restow is blocked. Mirrors the API's
 * `MailProtection` (apps/api/src/features/snapshots/tree.ts) one to one.
 */
export type MailProtectionKind = "rights-protected" | "smime-encrypted";

export interface MailSummary {
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  /** Total recipients on the To line, even when `to` shows only the first few. */
  toCount: number | null;
  ccCount: number | null;
  date: string | null;
  /** When the sender sent it, if different from `date` (the mailbox's received time). */
  sentDateTime: string | null;
  hasAttachments: boolean | null;
  isRead: boolean | null;
  flagged: boolean | null;
  /** Set when the mail cannot be read back in the clear (see {@link MailProtectionKind}). */
  protection: MailProtectionKind | null;
}

export interface TreeEntry {
  id: string;
  kind: EntryKind;
  name: string;
  path: string;
  parentPath: string;
  size: number;
  mtime: string | null;
  itemId: string | null;
  deleted: boolean;
  /** A folder the backup did not record on its own (it exists through its contents). */
  implicit: boolean;
  mail: MailSummary | null;
  contentType: string | null;
}

export interface BreadcrumbSegment {
  name: string;
  path: string;
}

export interface Tree {
  snapshot: Snapshot;
  object: Pick<SnapshotObject, "id" | "kind" | "externalId" | "displayName" | "own">;
  folder: { path: string; name: string };
  breadcrumb: BreadcrumbSegment[];
  entries: TreeEntry[];
  total: number;
  offset: number;
  hasMore: boolean;
}

/** One distinct version of an item across snapshots. */
export interface Version {
  objectId: string;
  snapshotId: string;
  sequence: number;
  snapshotAt: string | null;
  firstSeenSequence: number;
  firstSeenAt: string | null;
  snapshotCount: number;
  path: string;
  name: string;
  kind: EntryKind;
  size: number;
  mtime: string | null;
  itemId: string | null;
  deleted: boolean;
}

/** An earlier version the source (OneDrive) kept, captured in a snapshot. */
export interface StoredVersion {
  path: string;
  versionId: string;
  size: number;
  modifiedAt: string | null;
  modifiedBy: string | null;
}

export interface Versions {
  objectId: string;
  path: string;
  versions: Version[];
  stored: StoredVersion[];
}

export interface SearchHit extends TreeEntry {
  snapshotId: string;
  objectId: string;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  searchedSnapshots: number;
  truncated: boolean;
}

// --- Reading pane (mail preview) ------------------------------------------

export type PreviewBodyKind = "html" | "text";

export interface PreviewBody {
  kind: PreviewBodyKind;
  /** For `kind: "html"`, already sanitised by the server; safe to place in an `srcdoc`. */
  content: string;
}

export interface PreviewHeaders {
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  date: string | null;
  messageId: string | null;
}

export interface PreviewAttachment {
  id: string;
  filename: string | null;
  contentType: string;
  size: number;
  /** A `cid:`-embedded part already inlined into the body; not a separate download. */
  inline: boolean;
}

/**
 * Why `body` is missing even though the item exists (the API's
 * `MailPreviewUnavailableReason`, apps/api/src/features/snapshots/preview.ts):
 * rights-managed, S/MIME-encrypted, above the preview size cap, stored in
 * a format (the Graph JSON/attachments fallback) this preview does not parse,
 * or unreadable (parsing it ran over its time or memory limit).
 */
export type PreviewUnavailableReason =
  | "rights-protected"
  | "smime-encrypted"
  | "too-large"
  | "unsupported-format"
  | "unreadable";

/** Mirrors the API's discriminated `MailPreviewDto` one to one. */
export type EntryPreview =
  | {
      previewable: true;
      headers: PreviewHeaders;
      body: PreviewBody;
      attachments: PreviewAttachment[];
      /** The formatted view was not prepared; the plain text of the message is shown instead. */
      simplified?: true;
    }
  | {
      previewable: false;
      reason: PreviewUnavailableReason;
      headers: PreviewHeaders;
      attachments: PreviewAttachment[];
    };

export type SelectionEntry = { path: string; kind?: "folder" | "item" } | { itemId: string };

export type RestoreTarget =
  | { type: "original" }
  | { type: "other"; accountId: string }
  | { type: "download" };

export interface RestoreOptions {
  restoreFolderName?: string;
  archiveName?: string;
}

export interface CreateRestoreRequest {
  snapshotId: string;
  selection: SelectionEntry[];
  target: RestoreTarget;
  mode: RestoreMode;
  reason?: string;
  options?: RestoreOptions;
}

export interface SelectionSummary {
  all: boolean;
  folders: number;
  items: number;
}

export interface RestoreCreated {
  id: string;
  jobId: string;
  status: "queued";
  impersonated: boolean;
  selection: SelectionSummary;
}

/** An account a restore may be written into (tenant admins only). */
export interface RestoreTargetAccount {
  id: string;
  kind: ObjectKind;
  externalId: string;
  displayName: string | null;
}

export interface RestoreProgress {
  total: number;
  done: number;
  failed: number;
  bytes: number;
  etaSeconds: number | null;
}

export interface RestoreResult {
  restored: number;
  skipped: number;
  failures: number;
  unverified: number;
  folders: number;
  bytes: number;
  downloadKey: string | null;
  /** Pauses Microsoft Graph imposed on the run and their summed duration. */
  throttleWaits: number;
  throttleWaitMs: number;
}

export interface RestoreJob {
  id: string;
  jobId: string | null;
  snapshotId: string | null;
  snapshotSequence: number | null;
  snapshotAt: string | null;
  object: { id: string; kind: ObjectKind; externalId: string; displayName: string | null } | null;
  target: { type: RestoreTargetType; ref: string | null };
  mode: RestoreMode;
  selection: SelectionSummary;
  reason: string | null;
  impersonated: boolean;
  actor: { userId: string | null; name: string | null; email: string | null };
  status: RestoreStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  progress: RestoreProgress | null;
  /** The current (or last) wait Microsoft Graph imposed; only while the restore runs. */
  throttle: JobThrottle | null;
  result: RestoreResult | null;
  download: { available: boolean; expiresAt: string | null };
}

export interface RestoreFailure {
  itemRef: string;
  reason: string;
  attempts: number;
}

export type RestoreItemStatus = "restored" | "skipped" | "failed";

export const RESTORE_ITEM_CODES = [
  "restored",
  "unverified",
  "exists",
  "not_restorable",
  "parent_not_restored",
  "wrong_target",
  "data_missing",
  "integrity",
  "target_rejected",
  "error",
] as const;
export type RestoreItemCode = (typeof RESTORE_ITEM_CODES)[number];

export interface RestoreItem {
  path: string;
  itemId: string | null;
  type: string;
  status: RestoreItemStatus;
  code: RestoreItemCode | null;
  targetRef: string | null;
  bytes: number;
  verified: boolean;
  reason: string | null;
  /** Subject and sender from the backup; null for files and for older jobs. */
  subject?: string | null;
  from?: string | null;
}

export interface RestoreItems {
  items: RestoreItem[];
  total: number;
  truncated: boolean;
}

export interface RestoreJobDetail extends RestoreJob {
  failures: RestoreFailure[];
  items: RestoreItems | null;
}

// --- Query keys ---------------------------------------------------------------

type TenantKey = string | null;

export const restoreKeys = {
  all: (tenantId: TenantKey) => ["tenant", tenantId, "restore"] as const,
  objects: (tenantId: TenantKey, includeAll: boolean) =>
    ["tenant", tenantId, "restore", "objects", includeAll] as const,
  snapshots: (tenantId: TenantKey, objectId: string | null) =>
    ["tenant", tenantId, "restore", "snapshots", objectId] as const,
  tree: (tenantId: TenantKey, snapshotId: string | null, path: string, sort: TreeSort) =>
    ["tenant", tenantId, "restore", "tree", snapshotId, path, sort] as const,
  folders: (tenantId: TenantKey, snapshotId: string | null, path: string) =>
    ["tenant", tenantId, "restore", "folders", snapshotId, path] as const,
  preview: (tenantId: TenantKey, snapshotId: string | null, entryId: string | null) =>
    ["tenant", tenantId, "restore", "preview", snapshotId, entryId] as const,
  versions: (
    tenantId: TenantKey,
    objectId: string | null,
    path: string,
    itemId: string | null,
    snapshotId: string | null,
  ) => ["tenant", tenantId, "restore", "versions", objectId, path, itemId, snapshotId] as const,
  search: (tenantId: TenantKey, snapshotId: string | null, q: string) =>
    ["tenant", tenantId, "restore", "search", snapshotId, q] as const,
  targets: (tenantId: TenantKey, objectId: string | null) =>
    ["tenant", tenantId, "restore", "targets", objectId] as const,
  jobs: (tenantId: TenantKey) => ["tenant", tenantId, "restore", "jobs"] as const,
  job: (tenantId: TenantKey, id: string) => ["tenant", tenantId, "restore", "jobs", id] as const,
};

// --- Endpoints ----------------------------------------------------------------

type QueryValue = string | number | boolean | null | undefined;

function queryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

const id = encodeURIComponent;

/**
 * Every mailbox, OneDrive and IMAP account of the tenant the viewer may
 * browse. `includeAll` also lists accounts excluded from protection or
 * without a restore point yet (`?include=all`), for the explorer's account
 * list; the default (unset) matches the previous behaviour of other callers.
 */
export async function fetchSnapshotObjects(includeAll = false): Promise<SnapshotObject[]> {
  const body = await apiFetch<{ items: SnapshotObject[] }>(
    `/snapshots/objects${queryString({ include: includeAll ? "all" : undefined })}`,
  );
  return body.items;
}

export async function fetchSnapshots(objectId: string): Promise<ListedSnapshot[]> {
  const body = await apiFetch<{ items: ListedSnapshot[] }>(
    `/snapshots${queryString({ objectId, limit: 500 })}`,
  );
  return body.items;
}

export const TREE_PAGE_SIZE = 500;
/** The API's maximum page; folder levels are listed in one request. */
export const FOLDER_PAGE_SIZE = 2000;

/** How the item list orders a folder's contents; folders always come first. */
export type TreeSort = "date" | "name";
export const DEFAULT_TREE_SORT: TreeSort = "date";

export function fetchTree(
  snapshotId: string,
  path: string,
  page: { offset?: number; foldersOnly?: boolean; sort?: TreeSort } = {},
): Promise<Tree> {
  const limit = page.foldersOnly ? FOLDER_PAGE_SIZE : TREE_PAGE_SIZE;
  return apiFetch<Tree>(
    `/snapshots/${id(snapshotId)}/tree${queryString({
      path,
      offset: page.offset,
      limit,
      foldersOnly: page.foldersOnly ? "true" : undefined,
      sort: page.foldersOnly ? undefined : page.sort,
    })}`,
  );
}

/** The reading pane's content for one entry: headers, body and attachments. */
export function fetchEntryPreview(snapshotId: string, entryId: string): Promise<EntryPreview> {
  return apiFetch<EntryPreview>(`/snapshots/${id(snapshotId)}/entries/${id(entryId)}/preview`);
}

/**
 * A plain navigation (not `fetch`), same reasoning as {@link restoreDownloadUrl}:
 * the cookie authenticates, the file streams straight to disk, and the tenant
 * travels as a query parameter because a navigation cannot carry the header.
 */
export function attachmentDownloadUrl(
  snapshotId: string,
  entryId: string,
  attachmentId: string,
  tenantId: string | null,
): string {
  return `${API_BASE_URL}/snapshots/${id(snapshotId)}/entries/${id(entryId)}/attachments/${id(attachmentId)}${queryString(
    { tenant: tenantId },
  )}`;
}

export function fetchVersions(
  objectId: string,
  path: string,
  itemId: string | null,
  snapshotId: string | null,
): Promise<Versions> {
  return apiFetch<Versions>(
    `/snapshots/objects/${id(objectId)}/versions${queryString({ path, itemId, snapshotId })}`,
  );
}

export function searchSnapshot(snapshotId: string, q: string): Promise<SearchResult> {
  return apiFetch<SearchResult>(`/snapshots/search${queryString({ q, snapshotId, limit: 200 })}`);
}

export function createRestore(request: CreateRestoreRequest): Promise<RestoreCreated> {
  return apiFetch<RestoreCreated>("/restore", { method: "POST", body: request });
}

export async function fetchRestoreTargets(objectId: string): Promise<RestoreTargetAccount[]> {
  const body = await apiFetch<{ items: RestoreTargetAccount[] }>(
    `/restore/targets${queryString({ objectId })}`,
  );
  return body.items;
}

export async function fetchRestoreJobs(limit = 100): Promise<RestoreJob[]> {
  const body = await apiFetch<{ items: RestoreJob[] }>(`/restore${queryString({ limit })}`);
  return body.items;
}

export function fetchRestoreJob(restoreId: string): Promise<RestoreJobDetail> {
  return apiFetch<RestoreJobDetail>(`/restore/${id(restoreId)}`);
}

export function cancelRestoreJob(restoreId: string): Promise<RestoreJobDetail> {
  return apiFetch<RestoreJobDetail>(`/restore/${id(restoreId)}/cancel`, { method: "POST" });
}

const rawBaseUrl = import.meta.env.VITE_API_URL as string | undefined;
const API_BASE_URL = (rawBaseUrl ?? "/api/v1").replace(/\/+$/, "");

/**
 * The browser downloads the ZIP with a plain navigation (the cookie
 * authenticates, the archive streams straight to disk). A navigation cannot
 * carry the tenant header, so the tenant travels as a query parameter, which
 * the API accepts for this route only.
 */
export function restoreDownloadUrl(restoreId: string, tenantId: string | null): string {
  return `${API_BASE_URL}/restore/${id(restoreId)}/download${queryString({ tenant: tenantId })}`;
}
