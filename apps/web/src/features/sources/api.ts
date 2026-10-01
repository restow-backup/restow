import { apiFetch, unwrapList } from "@/lib/api";
import type {
  ConsentLinkDto,
  CreateSourceInput,
  EntraAppStatus,
  ImapProbeResult,
  ImapTestInput,
  SourceDto,
  TestResultDto,
  UpdateSourceInput,
  VerifyResultDto,
} from "./types";

/**
 * Typed calls against `/api/v1/sources`. Every request is tenant-scoped
 * through the shared `apiFetch` (X-Restow-Tenant from the active tenant).
 */

/** Query keys, scoped by tenant so a tenant switch never shows another tenant's sources. */
export const sourceKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "sources"] as const,
  list: (tenantId: string | null) => ["tenant", tenantId, "sources", "list"] as const,
  detail: (tenantId: string | null, sourceId: string) =>
    ["tenant", tenantId, "sources", "detail", sourceId] as const,
  entraStatus: (tenantId: string | null) => ["tenant", tenantId, "sources", "entra"] as const,
};

function sourcePath(sourceId: string, action?: string): string {
  const base = `/sources/${encodeURIComponent(sourceId)}`;
  return action ? `${base}/${action}` : base;
}

export async function fetchSources(): Promise<SourceDto[]> {
  return unwrapList<SourceDto>(await apiFetch<unknown>("/sources"));
}

export function fetchSource(sourceId: string): Promise<SourceDto> {
  return apiFetch<SourceDto>(sourcePath(sourceId));
}

export function fetchEntraStatus(): Promise<EntraAppStatus> {
  return apiFetch<EntraAppStatus>("/sources/entra/status");
}

export function createSource(input: CreateSourceInput): Promise<SourceDto> {
  return apiFetch<SourceDto>("/sources", { method: "POST", body: input });
}

export function updateSource(sourceId: string, patch: UpdateSourceInput): Promise<SourceDto> {
  return apiFetch<SourceDto>(sourcePath(sourceId), { method: "PATCH", body: patch });
}

export function deleteSource(sourceId: string): Promise<void> {
  return apiFetch<void>(sourcePath(sourceId), { method: "DELETE" });
}

/**
 * A signed admin-consent link. `tenant`: a tenant id or domain, `null` to let
 * the admin pick their organisation, omitted to reuse the stored hint.
 */
export function createConsentLink(
  sourceId: string,
  tenant?: string | null,
): Promise<ConsentLinkDto> {
  return apiFetch<ConsentLinkDto>(sourcePath(sourceId, "consent-link"), {
    method: "POST",
    body: tenant === undefined ? {} : { tenant },
  });
}

export function verifySource(sourceId: string): Promise<VerifyResultDto> {
  return apiFetch<VerifyResultDto>(sourcePath(sourceId, "verify"), { method: "POST" });
}

/** Probe the stored connection with the stored password and record the result. */
export function testSource(sourceId: string): Promise<TestResultDto> {
  return apiFetch<TestResultDto>(sourcePath(sourceId, "test"), { method: "POST" });
}

/** Probe connection details from a form; nothing is saved. */
export function testImapConnection(input: ImapTestInput): Promise<ImapProbeResult> {
  return apiFetch<ImapProbeResult>("/sources/imap/test", { method: "POST", body: input });
}
