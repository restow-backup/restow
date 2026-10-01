import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useSession } from "@/lib/session";
import {
  createConsentLink,
  createSource,
  deleteSource,
  fetchEntraStatus,
  fetchSource,
  fetchSources,
  sourceKeys,
  testImapConnection,
  testSource,
  updateSource,
  verifySource,
} from "./api";
import { removeSource, upsertSource } from "./cache";
import type { CreateSourceInput, ImapTestInput, SourceDto, UpdateSourceInput } from "./types";

/** How often the detail page asks whether the admin consent has come back. */
export const CONSENT_POLL_INTERVAL_MS = 4_000;

/**
 * Who may manage sources in the active tenant (the API requires tenant_admin
 * or a provider admin), and whether tenant-scoped queries may run yet.
 */
export function useSourcesScope() {
  const { status, activeTenant, isProviderAdmin } = useSession();
  const tenantId = activeTenant?.id ?? null;
  const canManage = isProviderAdmin || activeTenant?.role === "tenant_admin";
  return {
    tenantId,
    tenantName: activeTenant?.name ?? null,
    canManage,
    enabled: status === "authenticated" && tenantId !== null && canManage,
  };
}

export function useSourceList() {
  const scope = useSourcesScope();
  const query = useQuery({
    queryKey: sourceKeys.list(scope.tenantId),
    queryFn: fetchSources,
    enabled: scope.enabled,
    refetchInterval: 60_000,
  });
  return { ...scope, query };
}

export function useSourceDetail(sourceId: string, options: { poll: boolean; enabled?: boolean }) {
  const scope = useSourcesScope();
  const query = useQuery({
    queryKey: sourceKeys.detail(scope.tenantId, sourceId),
    queryFn: () => fetchSource(sourceId),
    enabled: scope.enabled && (options.enabled ?? true),
    refetchInterval: options.poll ? CONSENT_POLL_INTERVAL_MS : false,
    // The admin usually returns from the consent tab; look right away.
    refetchOnWindowFocus: options.poll,
  });
  return { ...scope, query };
}

export function useEntraStatus(enabled: boolean) {
  const scope = useSourcesScope();
  return useQuery({
    queryKey: sourceKeys.entraStatus(scope.tenantId),
    queryFn: fetchEntraStatus,
    enabled: scope.enabled && enabled,
    staleTime: 60_000,
  });
}

/** Write a source the API returned into the detail and list caches. */
function useStoreSource() {
  const queryClient = useQueryClient();
  const { tenantId } = useSourcesScope();
  return React.useCallback(
    (source: SourceDto) => {
      queryClient.setQueryData(sourceKeys.detail(tenantId, source.id), source);
      queryClient.setQueryData<SourceDto[]>(sourceKeys.list(tenantId), (list) =>
        list ? upsertSource(list, source) : list,
      );
    },
    [queryClient, tenantId],
  );
}

export function useCreateSource() {
  const store = useStoreSource();
  return useMutation({
    mutationFn: (input: CreateSourceInput) => createSource(input),
    onSuccess: store,
  });
}

export function useUpdateSource(sourceId: string) {
  const store = useStoreSource();
  return useMutation({
    mutationFn: (patch: UpdateSourceInput) => updateSource(sourceId, patch),
    onSuccess: store,
  });
}

export function useDeleteSource(sourceId: string) {
  const queryClient = useQueryClient();
  const { tenantId } = useSourcesScope();
  return useMutation({
    mutationFn: () => deleteSource(sourceId),
    onSuccess: () => {
      queryClient.setQueryData<SourceDto[]>(sourceKeys.list(tenantId), (list) =>
        list ? removeSource(list, sourceId) : list,
      );
      queryClient.removeQueries({ queryKey: sourceKeys.detail(tenantId, sourceId) });
    },
  });
}

export function useVerifySource(sourceId: string) {
  const store = useStoreSource();
  return useMutation({
    mutationFn: () => verifySource(sourceId),
    onSuccess: (result) => store(result.source),
  });
}

const STORED_TEST_KEY = ["sources", "stored-test"] as const;

/**
 * Test the stored IMAP connection. Keyed, so a page can show that a test is
 * running even when another component (a closing dialog) started it; the
 * cache update lives in the mutation options and survives that unmount.
 */
export function useTestSource() {
  const store = useStoreSource();
  return useMutation({
    mutationKey: STORED_TEST_KEY,
    mutationFn: (sourceId: string) => testSource(sourceId),
    onSuccess: (result) => store(result.source),
  });
}

/** Whether a stored-connection test for this source is in flight anywhere in the app. */
export function useIsTestingSource(sourceId: string): boolean {
  return (
    useIsMutating({
      mutationKey: STORED_TEST_KEY,
      predicate: (mutation) => mutation.state.variables === sourceId,
    }) > 0
  );
}

export function useConsentLink(sourceId: string) {
  return useMutation({
    mutationFn: (tenant: string | null | undefined) => createConsentLink(sourceId, tenant),
  });
}

export function useInlineImapTest() {
  return useMutation({ mutationFn: (input: ImapTestInput) => testImapConnection(input) });
}
