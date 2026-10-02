import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ObjectLockCapability, ProbeResult } from "@/features/storage/types";
import { apiFetch } from "@/lib/api";

/**
 * Client for `/api/v1/settings/default-storage` (apps/api
 * src/features/settings/default-storage.ts): the installation's default
 * storage as the server environment describes it, and a test of it that
 * belongs to no tenant. Installation level: requests carry no tenant.
 */

export interface DefaultStorageLastTest {
  ok: boolean;
  testedAt: string;
  /** Email of the provider admin who ran it. */
  testedBy: string;
  failedStep: string | null;
  errorCode: string | null;
}

export interface DefaultStorageView {
  /** False when the environment's storage settings are invalid. */
  configured: boolean;
  kind: "local" | "s3" | null;
  location: string | null;
  copyLocation: string | null;
  tenants: { total: number; usingDefault: number };
  lastTest: DefaultStorageLastTest | null;
}

export interface DefaultStorageTestResult {
  probe: ProbeResult;
  objectLock: ObjectLockCapability | null;
  view: DefaultStorageView;
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
