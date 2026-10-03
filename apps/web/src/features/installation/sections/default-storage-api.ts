import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { LocationInput } from "@/features/storage/forms";
import type {
  LocalTargetDto,
  ObjectLockCapability,
  ProbeResult,
  S3TargetDto,
} from "@/features/storage/types";
import { ApiError, apiFetch } from "@/lib/api";

/**
 * Client for `/api/v1/settings/default-storage` (apps/api
 * src/features/settings/default-storage.ts): the installation's default
 * storage (saved on the page, else the server environment), saving and
 * removing it, and a test of it that belongs to no tenant. Installation
 * level: requests carry no tenant.
 */

export interface DefaultStorageLastTest {
  ok: boolean;
  testedAt: string;
  /** Email of the provider admin who ran it. */
  testedBy: string;
  failedStep: string | null;
  errorCode: string | null;
}

/** Why a tenant keeps the default from moving (apps/api default-storage.ts). */
export type DefaultStorageBlockReason = "data" | "previous" | "migration" | "active_job";

export interface DefaultStorageBlocker {
  tenantId: string;
  tenantName: string;
  reasons: DefaultStorageBlockReason[];
}

/** The default saved on the page; the key pair itself is never sent back. */
export interface SavedDefaultStorage {
  kind: "local" | "s3";
  local: LocalTargetDto | null;
  s3: S3TargetDto | null;
  updatedAt: string;
  updatedBy: string;
}

export interface DefaultStorageView {
  /** False when the default that applies is not usable. */
  configured: boolean;
  /** Where the default that applies comes from. */
  source: "database" | "environment";
  kind: "local" | "s3" | null;
  location: string | null;
  copyLocation: string | null;
  /** Why the default is not usable, as the server says it. */
  problem: string | null;
  saved: SavedDefaultStorage | null;
  /** What the server environment describes (a saved default takes precedence). */
  environment: { configured: boolean; kind: "local" | "s3" | null; location: string | null };
  tenants: { total: number; usingDefault: number };
  /** Tenants that keep the location from changing. */
  blockers: DefaultStorageBlocker[];
  lastTest: DefaultStorageLastTest | null;
}

export interface DefaultStorageTestResult {
  probe: ProbeResult;
  objectLock: ObjectLockCapability | null;
  view: DefaultStorageView;
}

export interface DefaultStorageChangeResult {
  /** The probe the change ran first; null when nothing changed. */
  probe: ProbeResult | null;
  objectLock: ObjectLockCapability | null;
  view: DefaultStorageView;
}

export const DEFAULT_STORAGE_PROBLEMS = {
  inUse: "urn:restow:problem:settings-default-storage-in-use",
  unreachable: "urn:restow:problem:settings-default-storage-unreachable",
  environmentInvalid: "urn:restow:problem:settings-default-storage-environment-invalid",
  credentialsRequired: "urn:restow:problem:settings-default-storage-credentials-required",
  misconfigured: "urn:restow:problem:settings-default-storage-misconfigured",
} as const;

/** The tenants a refused change named (409 in-use), or null for any other error. */
export function blockersOf(error: unknown): DefaultStorageBlocker[] | null {
  if (!(error instanceof ApiError) || error.problem?.type !== DEFAULT_STORAGE_PROBLEMS.inUse) {
    return null;
  }
  const blockers = error.problem.blockers;
  return Array.isArray(blockers) ? (blockers as DefaultStorageBlocker[]) : [];
}

/** The probe a refused change ran (422 unreachable), or null for any other error. */
export function refusedProbeOf(error: unknown): ProbeResult | null {
  if (
    !(error instanceof ApiError) ||
    error.problem?.type !== DEFAULT_STORAGE_PROBLEMS.unreachable
  ) {
    return null;
  }
  const probe = error.problem.probe;
  return typeof probe === "object" && probe !== null ? (probe as ProbeResult) : null;
}

export const defaultStorageKeys = {
  view: ["installation", "default-storage"] as const,
};

export function fetchDefaultStorage(): Promise<DefaultStorageView> {
  return apiFetch<DefaultStorageView>("/settings/default-storage", { tenantId: null });
}

export function testDefaultStorage(): Promise<DefaultStorageTestResult> {
  return apiFetch<DefaultStorageTestResult>("/settings/default-storage/test", {
    method: "POST",
    tenantId: null,
  });
}

export function saveDefaultStorage(input: LocationInput): Promise<DefaultStorageChangeResult> {
  return apiFetch<DefaultStorageChangeResult>("/settings/default-storage", {
    method: "PUT",
    body: input,
    tenantId: null,
  });
}

export function removeDefaultStorage(): Promise<DefaultStorageChangeResult> {
  return apiFetch<DefaultStorageChangeResult>("/settings/default-storage", {
    method: "DELETE",
    tenantId: null,
  });
}

export function useDefaultStorage() {
  return useQuery({
    queryKey: defaultStorageKeys.view,
    queryFn: fetchDefaultStorage,
    staleTime: 30_000,
  });
}

/** Runs the test and keeps the view the server sends back, which already holds the new "last test". */
export function useTestDefaultStorage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: testDefaultStorage,
    onSuccess: (result) => {
      queryClient.setQueryData(defaultStorageKeys.view, result.view);
    },
  });
}

/** Saves the default (the server probes it first) and keeps the view it sends back. */
export function useSaveDefaultStorage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveDefaultStorage,
    onSuccess: (result) => {
      queryClient.setQueryData(defaultStorageKeys.view, result.view);
    },
  });
}

/** Removes the saved default, so the environment applies again. */
export function useRemoveDefaultStorage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeDefaultStorage,
    onSuccess: (result) => {
      queryClient.setQueryData(defaultStorageKeys.view, result.view);
    },
  });
}
