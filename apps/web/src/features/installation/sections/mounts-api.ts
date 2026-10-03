import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, apiFetch } from "@/lib/api";

/**
 * Client for `/api/v1/mounts` (apps/api src/features/mounts): network shares the
 * opt-in mounter adds to the compose project (docs/MOUNTS.md). Installation level:
 * requests carry no tenant. The types mirror apps/api src/mounter/protocol.ts.
 */

export const NFS_VERSIONS = ["3", "4", "4.1", "4.2"] as const;
export type NfsVersion = (typeof NFS_VERSIONS)[number];

export interface NfsMountSpec {
  protocol: "nfs";
  name: string;
  server: string;
  export: string;
  nfsVersion: NfsVersion;
  readOnly: boolean;
}

export type MountSpec = NfsMountSpec;

export interface MountView {
  mount: MountSpec;
  path: string;
  volume: string;
}

export const MOUNT_STEPS = ["validate", "probe", "write", "apply", "health", "cleanup"] as const;
export type MountStepId = (typeof MOUNT_STEPS)[number];
export type MountStepStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type OperationStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "needs_attention";

export interface MountOperation {
  id: string;
  kind: "add" | "remove";
  name: string;
  mount: MountSpec | null;
  status: OperationStatus;
  steps: {
    id: MountStepId;
    status: MountStepStatus;
    startedAt: string | null;
    finishedAt: string | null;
  }[];
  failure: { code: string; step: MountStepId; detail: string } | null;
  warnings: string[];
  requestedBy: { userId: string | null; label: string; ip: string | null };
  startedAt: string;
  finishedAt: string | null;
}

export type MounterBlockerCode =
  | "docker_unreachable"
  | "docker_cli_missing"
  | "compose_missing"
  | "compose_file_variable"
  | "override_invalid";

export interface MounterState {
  mounterVersion: string | null;
  mounts: MountView[];
  operation: MountOperation | null;
  history: MountOperation[];
  capabilities: {
    ready: boolean;
    blockers: { code: MounterBlockerCode; detail: string }[];
    runner: "cli" | "helper";
    composeFile: string | null;
    overrideFile: string;
    protocols: "nfs"[];
    checkedAt: string;
  };
  serverTime: string;
}

export type MounterFailure = "disabled" | "no_secret" | "unreachable" | "timeout" | "incompatible";

export interface MountsView {
  available: boolean;
  unavailableReason: MounterFailure | null;
  demo: boolean;
  enableCommand: string;
  mountRoot: string;
  state: MounterState | null;
}

export interface MountTestResult {
  ok: boolean;
  code: string | null;
  detail: string | null;
  wrote: boolean;
  durationMs: number;
}

/** A storage location that keeps a share from being removed (409 mount-in-use). */
export interface MountUser {
  kind: "target" | "installation_default";
  tenantId: string | null;
  tenantName: string | null;
  name: string | null;
  path: string;
}

export const MOUNT_PROBLEMS = {
  unavailable: "urn:restow:problem:mounter-unavailable",
  rejected: "urn:restow:problem:mounter-rejected",
  jobsRunning: "urn:restow:problem:mounts-jobs-running",
  inUse: "urn:restow:problem:mount-in-use",
  demo: "urn:restow:problem:mounts-demo",
} as const;

const REJECTED_CODES = new Set([
  "busy",
  "blocked",
  "exists",
  "not_found",
  "conflict",
  "limit",
  "invalid_request",
]);

/** The translation key (namespace `installation`) for an error of a mounts request. */
export function mountsErrorKey(error: unknown): string {
  const problem = error instanceof ApiError ? error.problem : null;
  switch (problem?.type) {
    case MOUNT_PROBLEMS.unavailable:
      return "installation:mounts.errors.unavailable";
    case MOUNT_PROBLEMS.jobsRunning:
      return "installation:mounts.errors.jobsRunning";
    case MOUNT_PROBLEMS.inUse:
      return "installation:mounts.errors.inUse";
    case MOUNT_PROBLEMS.demo:
      return "installation:mounts.errors.demo";
    case MOUNT_PROBLEMS.rejected: {
      const code = typeof problem.code === "string" ? problem.code : "";
      return REJECTED_CODES.has(code)
        ? `installation:mounts.errors.rejected.${code}`
        : "installation:mounts.errors.rejected.generic";
    }
    default:
      return "installation:mounts.errors.generic";
  }
}

/** The mounter's own words for a refusal (redacted there), when it sent some. */
export function mountsErrorDetail(error: unknown): string | null {
  const problem = error instanceof ApiError ? error.problem : null;
  return problem?.type === MOUNT_PROBLEMS.rejected && typeof problem.detail === "string"
    ? problem.detail
    : null;
}

/** The storage locations a refused removal named, or null for any other error. */
export function mountUsersOf(error: unknown): MountUser[] | null {
  if (!(error instanceof ApiError) || error.problem?.type !== MOUNT_PROBLEMS.inUse) {
    return null;
  }
  const users = error.problem.users;
  return Array.isArray(users) ? (users as MountUser[]) : [];
}

export const mountsKeys = {
  view: ["installation", "mounts"] as const,
  paths: ["installation", "mounts", "paths"] as const,
};

/** While an operation runs the section follows it closely. */
export const MOUNTS_ACTIVE_REFRESH_MS = 2_000;

export function mountsRefetchInterval(view: MountsView | undefined): number | false {
  return view?.state?.operation?.status === "running" ? MOUNTS_ACTIVE_REFRESH_MS : false;
}

export function fetchMounts(refresh = false): Promise<MountsView> {
  return apiFetch<MountsView>(refresh ? "/mounts?refresh=1" : "/mounts", { tenantId: null });
}

export function fetchMountPaths(): Promise<{ paths: string[] }> {
  return apiFetch<{ paths: string[] }>("/mounts/paths", { tenantId: null });
}

export function addMount(mount: MountSpec): Promise<MountsView> {
  return apiFetch<MountsView>("/mounts", { method: "POST", body: { mount }, tenantId: null });
}

export function removeMount(name: string): Promise<MountsView> {
  return apiFetch<MountsView>(`/mounts/${encodeURIComponent(name)}`, {
    method: "DELETE",
    tenantId: null,
  });
}

export function testMount(
  target: { mount: MountSpec } | { name: string },
): Promise<MountTestResult> {
  return apiFetch<MountTestResult>("/mounts/test", {
    method: "POST",
    body: target,
    tenantId: null,
  });
}

export function useMounts() {
  return useQuery({
    queryKey: mountsKeys.view,
    queryFn: () => fetchMounts(),
    staleTime: 10_000,
    refetchInterval: (query) => mountsRefetchInterval(query.state.data),
    // The api restarts while a share is added or removed: keep the last view meanwhile.
    retry: 3,
  });
}

/** The paths of the shares, for the storage form; empty for anyone who may not read them. */
export function useMountPaths(enabled: boolean) {
  return useQuery({
    queryKey: mountsKeys.paths,
    queryFn: fetchMountPaths,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

function useViewWriter() {
  const queryClient = useQueryClient();
  return (view: MountsView) => {
    queryClient.setQueryData(mountsKeys.view, view);
    void queryClient.invalidateQueries({ queryKey: mountsKeys.paths });
  };
}

export function useAddMount() {
  const write = useViewWriter();
  return useMutation({ mutationFn: addMount, onSuccess: write });
}

export function useRemoveMount() {
  const write = useViewWriter();
  return useMutation({ mutationFn: removeMount, onSuccess: write });
}

export function useTestMount() {
  return useMutation({ mutationFn: testMount });
}

// ---------------------------------------------------------------------------
// Validation, mirrored from apps/api src/mounter/protocol.ts (the server decides)
// ---------------------------------------------------------------------------

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:.]+$/;
const EXPORT = /^\/[A-Za-z0-9._\-/@+~]*$/;

export function validMountName(value: string): boolean {
  return NAME.test(value.trim());
}

export function validNfsServer(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0 || value.length > 253 || /[\s,=%]/.test(value)) {
    return false;
  }
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (unbracketed.includes(":")) {
    return IPV6.test(unbracketed) && unbracketed.split(":").length >= 3;
  }
  if (unbracketed !== value) {
    return false;
  }
  if (/^[0-9.]+$/.test(value)) {
    return IPV4.test(value);
  }
  return value
    .replace(/\.$/, "")
    .split(".")
    .every((label) => HOST_LABEL.test(label));
}

export function validExportPath(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0 || value.length > 1024 || !EXPORT.test(value)) {
    return false;
  }
  const segments = value.split("/");
  return !segments.includes("..") && !segments.includes(".");
}
