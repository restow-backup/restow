import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useSession } from "@/lib/session";

import {
  bulkSetProtection,
  deleteAccount,
  directoryKeys,
  fetchDirectorySources,
  fetchObjects,
  importAccounts,
  requestSync,
  saveRules,
  searchGroups,
  setObjectCredential,
  setProtection,
  testObjectCredential,
} from "./api";
import type {
  BulkProtectionInput,
  DirectorySource,
  ObjectsQuery,
  ProtectionAction,
  ProtectionRules,
} from "./types";

/** How often sources are re-read while a sync is queued or running. */
const SYNC_POLL_MS = 4000;

/** The active tenant and whether tenant-scoped queries may run. */
export function useDirectoryTenant() {
  const { status, activeTenant } = useSession();
  return {
    tenantId: activeTenant?.id ?? null,
    tenantName: activeTenant?.name ?? null,
    enabled: status === "authenticated" && activeTenant !== null,
  };
}

function hasPendingSync(sources: readonly DirectorySource[] | undefined): boolean {
  return (sources ?? []).some((source) => source.sync?.pendingJob);
}

/** Sources with rules and sync state; polls while a sync is pending. */
export function useDirectorySources() {
  const { tenantId, enabled } = useDirectoryTenant();
  return useQuery({
    queryKey: directoryKeys.sources(tenantId),
    queryFn: fetchDirectorySources,
    enabled,
    refetchInterval: (query) => (hasPendingSync(query.state.data) ? SYNC_POLL_MS : 60_000),
  });
}

/** One page of protected objects; the previous page stays visible while the next loads. */
export function useProtectedObjects(query: ObjectsQuery) {
  const { tenantId, enabled } = useDirectoryTenant();
  return useQuery({
    queryKey: directoryKeys.objectsPage(tenantId, query),
    queryFn: () => fetchObjects(query),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * Re-read the object list when a sync finishes: the list changes then, and
 * the admin who pressed "Sync now" is looking at it.
 */
export function useRefreshAfterSync(sources: readonly DirectorySource[] | undefined): void {
  const queryClient = useQueryClient();
  const { tenantId } = useDirectoryTenant();
  const pending = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const now = new Set(
      (sources ?? []).flatMap((source) =>
        source.sync?.pendingJob ? [source.sync.pendingJob.id] : [],
      ),
    );
    const finished = [...pending.current].some((id) => !now.has(id));
    pending.current = now;
    if (finished) {
      void queryClient.invalidateQueries({ queryKey: directoryKeys.objects(tenantId) });
    }
  }, [sources, queryClient, tenantId]);
}

export function useGroupSearch(sourceId: string, search: string, active: boolean) {
  const { tenantId, enabled } = useDirectoryTenant();
  return useQuery({
    queryKey: directoryKeys.groups(tenantId, sourceId, search),
    queryFn: () => searchGroups(sourceId, search),
    enabled: enabled && active,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** Invalidate everything the directory shows (sources, counts, objects). */
function useInvalidateDirectory() {
  const queryClient = useQueryClient();
  const { tenantId } = useDirectoryTenant();
  return React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: directoryKeys.all(tenantId) }),
    [queryClient, tenantId],
  );
}

export function useSetProtection() {
  const invalidate = useInvalidateDirectory();
  return useMutation({
    mutationFn: ({ objectId, action }: { objectId: string; action: ProtectionAction }) =>
      setProtection(objectId, action),
    onSuccess: () => invalidate(),
  });
}

export function useBulkSetProtection() {
  const invalidate = useInvalidateDirectory();
  return useMutation({
    mutationFn: ({ sourceId, input }: { sourceId: string; input: BulkProtectionInput }) =>
      bulkSetProtection(sourceId, input),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteAccount() {
  const invalidate = useInvalidateDirectory();
  return useMutation({
    mutationFn: (objectId: string) => deleteAccount(objectId),
    onSuccess: () => invalidate(),
  });
}

export function useSaveRules() {
  const invalidate = useInvalidateDirectory();
  return useMutation({
    mutationFn: ({ sourceId, rules }: { sourceId: string; rules: ProtectionRules }) =>
      saveRules(sourceId, rules),
    onSuccess: () => invalidate(),
  });
}

export function useRequestSync() {
  const invalidate = useInvalidateDirectory();
  return useMutation({
    mutationFn: ({ sourceId, full }: { sourceId: string; full: boolean }) =>
      requestSync(sourceId, full),
    onSuccess: () => invalidate(),
  });
}

export function useSetObjectCredential() {
  const invalidate = useInvalidateDirectory();
  return useMutation({
    mutationFn: ({ objectId, password }: { objectId: string; password: string }) =>
      setObjectCredential(objectId, password),
    onSuccess: () => invalidate(),
  });
}

export function useTestObjectCredential() {
  const invalidate = useInvalidateDirectory();
  return useMutation({
    mutationFn: (objectId: string) => testObjectCredential(objectId),
    onSuccess: () => invalidate(),
  });
}

export function useImportAccounts() {
  const invalidate = useInvalidateDirectory();
  return useMutation({
    mutationFn: ({ sourceId, csv, dryRun }: { sourceId: string; csv: string; dryRun: boolean }) =>
      importAccounts(sourceId, csv, dryRun),
    onSuccess: (outcome) => {
      if (!outcome.dryRun) {
        void invalidate();
      }
    },
  });
}

/** A value that follows `value` after it stopped changing for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
