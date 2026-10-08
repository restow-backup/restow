import { ApiError, NetworkError, TENANT_HEADER, apiFetch, unwrapList } from "@/lib/api";
import type {
  CreateImportInput,
  CreateUploadInput,
  FolderListing,
  ImportConfig,
  ImportCreated,
  ImportDetail,
  ImportSummary,
  ImportUploadDto,
  ObjectListEntry,
  SegmentAck,
} from "./types";
import type { UploadTransport } from "./upload/types";

/**
 * Typed calls against `/api/v1/imports`. Every request is tenant-scoped
 * through the shared `apiFetch` (X-Restow-Tenant from the active tenant); the
 * segment upload, whose body is raw bytes, has its own small sender below.
 */

type TenantKey = string | null;

/** Query keys, scoped by tenant so a tenant switch never shows another tenant's imports. */
export const importKeys = {
  all: (tenantId: TenantKey) => ["tenant", tenantId, "imports"] as const,
  config: (tenantId: TenantKey) => ["tenant", tenantId, "imports", "config"] as const,
  list: (tenantId: TenantKey) => ["tenant", tenantId, "imports", "list"] as const,
  detail: (tenantId: TenantKey, importId: string) =>
    ["tenant", tenantId, "imports", "detail", importId] as const,
  folder: (tenantId: TenantKey, path: string) =>
    ["tenant", tenantId, "imports", "folder", path] as const,
  uploads: (tenantId: TenantKey) => ["tenant", tenantId, "imports", "uploads"] as const,
  mailboxes: (tenantId: TenantKey) => ["tenant", tenantId, "imports", "mailboxes"] as const,
};

const id = encodeURIComponent;

export function fetchImportConfig(): Promise<ImportConfig> {
  return apiFetch<ImportConfig>("/imports/config");
}

/** One page of the tenant's imports, newest first (the first page without an offset). */
export async function fetchImports(offset = 0): Promise<ImportSummary[]> {
  const query = offset > 0 ? `?offset=${offset}` : "";
  return unwrapList<ImportSummary>(await apiFetch<unknown>(`/imports${query}`));
}

export function fetchImport(importId: string): Promise<ImportDetail> {
  return apiFetch<ImportDetail>(`/imports/${id(importId)}`);
}

export function createImport(input: CreateImportInput): Promise<ImportCreated> {
  return apiFetch<ImportCreated>("/imports", { method: "POST", body: input });
}

export function cancelImport(importId: string): Promise<ImportDetail> {
  return apiFetch<ImportDetail>(`/imports/${id(importId)}/cancel`, { method: "POST" });
}

export function fetchFolder(path: string): Promise<FolderListing> {
  const query = path ? `?${new URLSearchParams({ path }).toString()}` : "";
  return apiFetch<FolderListing>(`/imports/folder${query}`);
}

/**
 * Uploads that were started and not used yet (unfinished or complete), for
 * continuing after a reload. A server without the listing simply has none.
 */
export async function fetchUploads(): Promise<ImportUploadDto[]> {
  try {
    return unwrapList<ImportUploadDto>(await apiFetch<unknown>("/imports/uploads"));
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      return [];
    }
    throw error;
  }
}

export function deleteUpload(uploadId: string): Promise<void> {
  return apiFetch<void>(`/imports/uploads/${id(uploadId)}`, { method: "DELETE" });
}

// --- Segment upload ---------------------------------------------------------------

const rawBaseUrl = import.meta.env.VITE_API_URL as string | undefined;
const API_BASE_URL = (rawBaseUrl ?? "/api/v1").replace(/\/+$/, "");

async function readProblem(response: Response) {
  if (!(response.headers.get("content-type") ?? "").includes("json")) {
    return null;
  }
  try {
    const body = (await response.json()) as Record<string, unknown> | null;
    if (typeof body !== "object" || body === null) {
      return null;
    }
    return {
      type: typeof body.type === "string" ? body.type : "about:blank",
      title: typeof body.title === "string" ? body.title : response.statusText,
      status: typeof body.status === "number" ? body.status : response.status,
      ...body,
    };
  } catch {
    return null;
  }
}

/** PUT raw bytes and decode the JSON answer; errors are the same `ApiError`/`NetworkError` as `apiFetch`. */
async function putBytes<T>(
  path: string,
  body: Blob,
  headers: Record<string, string>,
  tenantId: TenantKey,
  signal: AbortSignal,
): Promise<T> {
  const requestHeaders = new Headers({ accept: "application/json", ...headers });
  if (tenantId) {
    requestHeaders.set(TENANT_HEADER, tenantId);
  }
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: "PUT",
      credentials: "include",
      headers: requestHeaders,
      body,
      signal,
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      await readProblem(response),
      `Request to ${path} failed with status ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

/**
 * The upload engine's view of the API for one tenant. The tenant is fixed
 * when the transport is made: switching tenants mid-upload must not send the
 * remaining segments to another tenant's upload.
 */
export function createUploadTransport(tenantId: TenantKey): UploadTransport {
  return {
    create: (input: CreateUploadInput, signal) =>
      apiFetch<ImportUploadDto>("/imports/uploads", {
        method: "POST",
        body: input,
        tenantId,
        signal,
      }),
    get: (uploadId, signal) =>
      apiFetch<ImportUploadDto>(`/imports/uploads/${id(uploadId)}`, { tenantId, signal }),
    putSegment: (uploadId, index, body, sha256, signal) =>
      putBytes<SegmentAck>(
        `/imports/uploads/${id(uploadId)}/segments/${index}`,
        body,
        {
          "content-type": "application/octet-stream",
          ...(sha256 ? { "X-Segment-Sha256": sha256 } : {}),
        },
        tenantId,
        signal,
      ),
    complete: (uploadId, signal) =>
      apiFetch<ImportUploadDto>(`/imports/uploads/${id(uploadId)}/complete`, {
        method: "POST",
        tenantId,
        signal,
      }),
    remove: (uploadId) =>
      apiFetch<void>(`/imports/uploads/${id(uploadId)}`, { method: "DELETE", tenantId }),
  };
}

// --- Imported mailboxes for the target step -----------------------------------------

/** Accounts the explorer lists, including imported mailboxes (`sourceKind: "import"`). */
export async function fetchObjectList(): Promise<ObjectListEntry[]> {
  const body = await apiFetch<{ items?: ObjectListEntry[] }>("/snapshots/objects?include=all");
  return body.items ?? [];
}
