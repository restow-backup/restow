import { apiFetch, unwrapList } from "@/lib/api";

import type {
  BulkProtectionInput,
  BulkProtectionResult,
  CredentialTestResult,
  CsvImportOutcome,
  DirectorySource,
  EnqueueOutcome,
  GroupSummary,
  ObjectsFilter,
  ObjectsPage,
  ObjectsQuery,
  PeoplePage,
  ProtectedObject,
  ProtectionAction,
  ProtectionResult,
  ProtectionRules,
  RulesResult,
} from "./types";

/**
 * Typed calls against `/api/v1/directory`. Every request is tenant-scoped
 * through the shared `apiFetch` (X-Restow-Tenant from the active tenant).
 */

/** Query keys, scoped by tenant so a tenant switch never shows another tenant's data. */
export const directoryKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "directory"] as const,
  sources: (tenantId: string | null) => ["tenant", tenantId, "directory", "sources"] as const,
  objects: (tenantId: string | null) => ["tenant", tenantId, "directory", "objects"] as const,
  objectsPage: (tenantId: string | null, query: ObjectsQuery) =>
    ["tenant", tenantId, "directory", "objects", query] as const,
  people: (tenantId: string | null, search: string) =>
    ["tenant", tenantId, "directory", "people", search] as const,
  groups: (tenantId: string | null, sourceId: string, search: string) =>
    ["tenant", tenantId, "directory", "groups", sourceId, search] as const,
};

const base = "/directory";

function sourcePath(sourceId: string, suffix: string): string {
  return `${base}/sources/${encodeURIComponent(sourceId)}${suffix}`;
}

/** Query string of the filter fields shared by the objects list and a bulk "select all matching". */
export function objectsFilterParams(filter: ObjectsFilter): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ["search", "kind", "status", "sourceId", "job"] as const) {
    const value = filter[key]?.trim();
    if (value) {
      params.set(key, value);
    }
  }
  if (filter.sharedOrBlocked !== undefined) {
    params.set("sharedOrBlocked", String(filter.sharedOrBlocked));
  }
  return params;
}

/** Query string of an objects query; empty filters are left out. */
export function objectsSearchParams(query: ObjectsQuery): URLSearchParams {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
    sort: query.sort,
    order: query.order,
  });
  for (const [key, value] of objectsFilterParams(query)) {
    params.set(key, value);
  }
  return params;
}

export async function fetchDirectorySources(): Promise<DirectorySource[]> {
  return unwrapList<DirectorySource>(await apiFetch<unknown>(`${base}/sources`));
}

export function fetchObjects(query: ObjectsQuery): Promise<ObjectsPage> {
  return apiFetch<ObjectsPage>(`${base}/objects?${objectsSearchParams(query).toString()}`);
}

/** People of the directory whose name, address or UPN contains `search` (all when empty). */
export function fetchPeople(search: string, limit = 20): Promise<PeoplePage> {
  const params = new URLSearchParams({ search, limit: String(limit) });
  return apiFetch<PeoplePage>(`${base}/people?${params.toString()}`);
}

export async function searchGroups(sourceId: string, search: string): Promise<GroupSummary[]> {
  const params = new URLSearchParams({ search });
  return unwrapList<GroupSummary>(
    await apiFetch<unknown>(`${sourcePath(sourceId, "/groups")}?${params.toString()}`),
  );
}

export function saveRules(sourceId: string, rules: ProtectionRules): Promise<RulesResult> {
  return apiFetch<RulesResult>(sourcePath(sourceId, "/rules"), { method: "PUT", body: rules });
}

export function requestSync(sourceId: string, full: boolean): Promise<EnqueueOutcome> {
  return apiFetch<EnqueueOutcome>(sourcePath(sourceId, "/sync"), {
    method: "POST",
    body: { full },
  });
}

export function setProtection(
  objectId: string,
  action: ProtectionAction,
): Promise<ProtectionResult> {
  return apiFetch<ProtectionResult>(`${base}/objects/${encodeURIComponent(objectId)}/protection`, {
    method: "POST",
    body: { action },
  });
}

export function bulkSetProtection(
  sourceId: string,
  input: BulkProtectionInput,
): Promise<BulkProtectionResult> {
  return apiFetch<BulkProtectionResult>(sourcePath(sourceId, "/protection/bulk"), {
    method: "POST",
    body: input,
  });
}

export function deleteAccount(objectId: string): Promise<void> {
  return apiFetch<void>(`${base}/objects/${encodeURIComponent(objectId)}`, { method: "DELETE" });
}

export function importAccounts(
  sourceId: string,
  csv: string,
  dryRun: boolean,
): Promise<CsvImportOutcome> {
  return apiFetch<CsvImportOutcome>(sourcePath(sourceId, "/accounts/import"), {
    method: "POST",
    body: { csv, dryRun },
  });
}

/** Set or replace one IMAP account's own password (per_mailbox auth, docs/IMAP.md). */
export function setObjectCredential(objectId: string, password: string): Promise<ProtectedObject> {
  return apiFetch<ProtectedObject>(`${base}/objects/${encodeURIComponent(objectId)}/credential`, {
    method: "POST",
    body: { password },
  });
}

/** Try that account's login right now; never sends or returns the password. */
export function testObjectCredential(objectId: string): Promise<CredentialTestResult> {
  return apiFetch<CredentialTestResult>(
    `${base}/objects/${encodeURIComponent(objectId)}/credential/test`,
    { method: "POST" },
  );
}
