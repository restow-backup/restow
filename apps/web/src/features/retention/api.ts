import { apiFetch } from "@/lib/api";

/**
 * Typed client for /api/v1/retention (apps/api/src/features/retention). The
 * shapes mirror the API DTOs one to one; query keys carry the tenant so a
 * tenant switch never shows another tenant's policies.
 */

export const RETENTION_PRESETS = [
  "default",
  "30d",
  "90d",
  "1y",
  "3y",
  "7y",
  "keep_all",
  "custom",
] as const;
export type RetentionPreset = (typeof RETENTION_PRESETS)[number];

export interface RetentionTier {
  /** Age in days at which this tier starts (inclusive). */
  fromDays: number;
  /** Age in days at which this tier ends (exclusive); null = no upper bound. */
  toDays: number | null;
  /** Keep one restore point per this many days within the tier; 0 keeps every one. */
  keepEveryDays: number;
}

export type ObjectKind = "mailbox" | "onedrive" | "imap";

export interface RetentionScopeObject {
  id: string;
  name: string;
  kind: ObjectKind;
}

export interface RetentionPolicy {
  id: string;
  name: string;
  preset: RetentionPreset;
  tiers: RetentionTier[];
  /** Age past which nothing survives; null = kept without an age limit. */
  cutoffDays: number | null;
  /** The tenant-wide policy (there is at most one); false for an object override. */
  isDefault: boolean;
  /** The objects an override is limited to; empty for the tenant-wide policy. */
  protectedObjects: RetentionScopeObject[];
  createdAt: string;
  updatedAt: string;
}

export interface RetentionPolicyList {
  items: RetentionPolicy[];
  /** The recommended default rule, offered as the default preset when nothing exists yet. */
  recommendedPreset: RetentionPreset;
}

export interface RetentionPolicyInput {
  name: string;
  preset: RetentionPreset;
  /** Required (and only read) for preset "custom". */
  tiers?: RetentionTier[];
  /** null = the tenant-wide default; a non-empty list scopes the policy to those objects. */
  protectedObjectIds: string[] | null;
}

export type RetentionPolicyPatch = Partial<RetentionPolicyInput>;

export interface RetentionPreviewRequest {
  /** Preview as a change to this existing policy; omitted previews a new one. */
  id?: string;
  preset: RetentionPreset;
  tiers?: RetentionTier[];
  protectedObjectIds: string[] | null;
}

export interface RetentionPreview {
  /** Objects at least one restore point would be removed from. */
  objects: number;
  /** Restore points the next run would remove. */
  restorePoints: number;
  /** Rough size of what would be removed, in bytes. */
  bytesLogical: number;
  /** Restore points that would otherwise be due, but a legal hold currently suspends. */
  heldRestorePoints: number;
}

/** A protected object a policy can be scoped to. */
export interface ScopeCandidate {
  id: string;
  name: string;
  detail: string | null;
  kind: ObjectKind;
}

// --- Query keys ---------------------------------------------------------------

export const retentionKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "retention"] as const,
  list: (tenantId: string | null) => ["tenant", tenantId, "retention", "list"] as const,
  preview: (tenantId: string | null, request: RetentionPreviewRequest) =>
    ["tenant", tenantId, "retention", "preview", request] as const,
  scope: (tenantId: string | null, search: string) =>
    ["tenant", tenantId, "retention", "scope", search] as const,
};

// --- Endpoints ----------------------------------------------------------------

const base = "/retention/policies";

export function fetchRetentionPolicies(): Promise<RetentionPolicyList> {
  return apiFetch<RetentionPolicyList>(base);
}

export function createRetentionPolicy(input: RetentionPolicyInput): Promise<RetentionPolicy> {
  return apiFetch<RetentionPolicy>(base, { method: "POST", body: input });
}

export function updateRetentionPolicy(
  id: string,
  patch: RetentionPolicyPatch,
): Promise<RetentionPolicy> {
  return apiFetch<RetentionPolicy>(`${base}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });
}

export function deleteRetentionPolicy(id: string): Promise<void> {
  return apiFetch<void>(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function previewRetentionPolicy(
  request: RetentionPreviewRequest,
): Promise<RetentionPreview> {
  return apiFetch<RetentionPreview>(`${base}/preview`, { method: "POST", body: request });
}

interface DirectoryObject {
  id: string;
  kind: ObjectKind;
  displayName: string | null;
  email: string | null;
  externalId: string;
}

/**
 * Active protected objects matching `search`, from the directory
 * (GET /directory/objects, tenant administrators only), for the object picker.
 */
export async function searchScopeCandidates(search: string): Promise<ScopeCandidate[]> {
  const params = new URLSearchParams({
    status: "active",
    pageSize: "20",
    sort: "name",
    order: "asc",
  });
  if (search.trim()) {
    params.set("search", search.trim());
  }
  const page = await apiFetch<{ items: DirectoryObject[] }>(
    `/directory/objects?${params.toString()}`,
  );
  return page.items.map((object) => {
    const detail = object.email ?? object.externalId;
    const name = object.displayName?.trim() || detail;
    return { id: object.id, kind: object.kind, name, detail: name === detail ? null : detail };
  });
}
