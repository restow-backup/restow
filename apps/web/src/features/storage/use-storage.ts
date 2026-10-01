import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useSession } from "@/lib/session";
import {
  cancelMigration,
  checkCompleteness,
  createTarget,
  deleteTarget,
  fetchTargets,
  fetchUsage,
  probeSettings,
  promoteTarget,
  retryMigration,
  storageKeys,
  testInstallationDefault,
  testTarget,
  updateTarget,
} from "./api";
import { removeTarget, upsertTarget } from "./cache";
import type {
  CreateTargetInput,
  ProbeInput,
  StorageTargetDto,
  StorageTargetList,
  UpdateTargetInput,
} from "./types";

/** A migration still moving is polled fast enough to feel live; otherwise the usual slow poll. */
const MIGRATION_ACTIVE_STATUSES = new Set(["queued", "copying", "verifying", "switching"]);
const ACTIVE_REFETCH_MS = 2_000;
const IDLE_REFETCH_MS = 60_000;

function hasActiveMigration(list: StorageTargetList | undefined): boolean {
  return (list?.items ?? []).some(
    (target) => target.migration && MIGRATION_ACTIVE_STATUSES.has(target.migration.status),
  );
}

/**
 * Who may manage storage in the active tenant (the API requires tenant_admin
 * or a provider admin), and whether tenant-scoped queries may run yet.
 */
export function useStorageScope() {
  const { status, activeTenant, isProviderAdmin } = useSession();
  const tenantId = activeTenant?.id ?? null;
  const canManage = isProviderAdmin || activeTenant?.role === "tenant_admin";
  return {
    tenantId,
    tenantName: activeTenant?.name ?? null,
    canManage,
    isProviderAdmin,
    enabled: status === "authenticated" && tenantId !== null && canManage,
  };
}

export function useTargetList() {
  const scope = useStorageScope();
  const query = useQuery({
    queryKey: storageKeys.targets(scope.tenantId),
    queryFn: fetchTargets,
    enabled: scope.enabled,
    refetchInterval: (q) =>
      hasActiveMigration(q.state.data) ? ACTIVE_REFETCH_MS : IDLE_REFETCH_MS,
  });
  return { ...scope, query };
}

export function useStorageUsage() {
  const scope = useStorageScope();
  return useQuery({
    queryKey: storageKeys.usage(scope.tenantId),
    queryFn: fetchUsage,
    enabled: scope.enabled,
    staleTime: 60_000,
  });
}

/** Write a target the API returned into the list cache. */
function useStoreTarget() {
  const queryClient = useQueryClient();
  const { tenantId } = useStorageScope();
  return React.useCallback(
    (target: StorageTargetDto) => {
      queryClient.setQueryData<StorageTargetList>(storageKeys.targets(tenantId), (list) =>
        list ? upsertTarget(list, target) : list,
      );
    },
    [queryClient, tenantId],
  );
}

/** Refetch the list: role changes touch more than one target and the installation default. */
function useInvalidateTargets() {
  const queryClient = useQueryClient();
  const { tenantId } = useStorageScope();
  return React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: storageKeys.targets(tenantId) }),
    [queryClient, tenantId],
  );
}

export function useCreateTarget() {
  const invalidate = useInvalidateTargets();
  return useMutation({
    mutationFn: (input: CreateTargetInput) => createTarget(input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateTarget(targetId: string) {
  const store = useStoreTarget();
  return useMutation({
    mutationFn: (patch: UpdateTargetInput) => updateTarget(targetId, patch),
    onSuccess: store,
  });
}

export function useDeleteTarget(targetId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateTargets();
  const { tenantId } = useStorageScope();
  return useMutation({
    mutationFn: () => deleteTarget(targetId),
    onSuccess: () => {
      queryClient.setQueryData<StorageTargetList>(storageKeys.targets(tenantId), (list) =>
        list ? removeTarget(list, targetId) : list,
      );
      void invalidate();
    },
  });
}

const TEST_KEY = ["storage", "test"] as const;

/**
 * Test a stored target. Keyed, so a card can show a test that a closing
 * dialog started; the cache update lives in the mutation and survives that unmount.
 */
export function useTestTarget() {
  const store = useStoreTarget();
  return useMutation({
    mutationKey: TEST_KEY,
    mutationFn: (targetId: string) => testTarget(targetId),
    onSuccess: (result) => store(result.target),
  });
}

/** Whether a test of this target is in flight anywhere in the app. */
export function useIsTestingTarget(targetId: string): boolean {
  return (
    useIsMutating({
      mutationKey: TEST_KEY,
      predicate: (mutation) => mutation.state.variables === targetId,
    }) > 0
  );
}

export function useProbeSettings() {
  return useMutation({ mutationFn: (input: ProbeInput) => probeSettings(input) });
}

export function useTestInstallationDefault() {
  return useMutation({ mutationFn: testInstallationDefault });
}

export function useCompleteness(targetId: string) {
  return useMutation({ mutationFn: () => checkCompleteness(targetId) });
}

export function usePromoteTarget(targetId: string) {
  const invalidate = useInvalidateTargets();
  return useMutation({
    mutationFn: () => promoteTarget(targetId),
    onSuccess: () => invalidate(),
  });
}

/** Cancel the migration replacing the primary with `targetId` (its destination). */
export function useCancelMigration(targetId: string) {
  const invalidate = useInvalidateTargets();
  return useMutation({
    mutationFn: () => cancelMigration(targetId),
    onSuccess: () => invalidate(),
  });
}

/** Re-queue a failed "move" migration replacing the primary with `targetId`, with a fresh job. */
export function useRetryMigration(targetId: string) {
  const invalidate = useInvalidateTargets();
  return useMutation({
    mutationFn: () => retryMigration(targetId),
    onSuccess: () => invalidate(),
  });
}
