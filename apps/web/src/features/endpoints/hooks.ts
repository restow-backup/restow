import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { formatBytes, formatDateTime, formatInteger } from "@/lib/format";
import { useSession } from "@/lib/session";

import {
  type CreateTaskInput,
  type CreateTokenInput,
  type EndpointProfile,
  type TokenListState,
  type UpdateEndpointInput,
  createDownload,
  createTask,
  createToken,
  endpointKeys,
  fetchAgentUpdates,
  fetchBrowse,
  fetchEndpoint,
  fetchEndpoints,
  fetchRun,
  fetchRuns,
  fetchSnapshots,
  fetchTokens,
  requestRestoreTest,
  revealRepositoryPassword,
  revokeEndpoint,
  revokeToken,
  setAgentUpdates,
  uninstallEndpoint,
  updateEndpoint,
} from "./api.js";
import {
  IDLE_REFRESH_MS,
  RUN_REFRESH_MS,
  detailRefetchInterval,
  listRefetchInterval,
} from "./presenters.js";

/**
 * Data hooks of the endpoint pages. Every key carries the active tenant,
 * nothing runs before the session is settled, every change refreshes what it
 * touched, and lists and details follow a running backup on their own.
 */

export function useTenantScope() {
  const { status, activeTenant } = useSession();
  return {
    tenantId: activeTenant?.id ?? null,
    enabled: status === "authenticated" && activeTenant !== null,
  };
}

export function useEndpoints(profile: EndpointProfile | undefined) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: endpointKeys.list(tenantId, profile),
    queryFn: () => fetchEndpoints(profile),
    enabled,
    refetchInterval: (query) => listRefetchInterval(query.state.data),
  });
}

export function useEndpoint(endpointId: string) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: endpointKeys.detail(tenantId, endpointId),
    queryFn: () => fetchEndpoint(endpointId),
    enabled,
    retry: false,
    refetchInterval: (query) => detailRefetchInterval(query.state.data),
  });
}

/** The newest runs beyond the 20 the detail carries; only fetched on request. */
export function useRuns(endpointId: string, limit: number, enabled: boolean) {
  const scope = useTenantScope();
  return useQuery({
    queryKey: endpointKeys.runs(scope.tenantId, endpointId, limit),
    queryFn: () => fetchRuns(endpointId, limit),
    enabled: scope.enabled && enabled,
    refetchInterval: IDLE_REFRESH_MS,
  });
}

/** One run with log and errors; follows the run closely while it is running. */
export function useRun(endpointId: string, runId: string | null) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: endpointKeys.run(tenantId, endpointId, runId ?? ""),
    queryFn: () => fetchRun(endpointId, runId ?? ""),
    enabled: enabled && runId !== null,
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === "running" ? RUN_REFRESH_MS : false),
  });
}

/**
 * The snapshots come from reading the repository with restic on the server:
 * fetched when the tab opens, not polled.
 */
export function useSnapshots(endpointId: string, enabled: boolean) {
  const scope = useTenantScope();
  return useQuery({
    queryKey: endpointKeys.snapshots(scope.tenantId, endpointId),
    queryFn: () => fetchSnapshots(endpointId),
    enabled: scope.enabled && enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * One folder of a snapshot, page by page: the first page on opening it, the
 * next ones on request (`fetchNextPage`). A snapshot never changes, so a page
 * is not fetched twice (each read is audited and starts a restic process).
 */
export function useBrowse(endpointId: string, snapshotId: string | null, path: string) {
  const { tenantId, enabled } = useTenantScope();
  return useInfiniteQuery({
    queryKey: endpointKeys.browse(tenantId, endpointId, snapshotId ?? "", path),
    queryFn: ({ pageParam }) => fetchBrowse(endpointId, snapshotId ?? "", path, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && snapshotId !== null,
    retry: false,
    staleTime: 10 * 60_000,
  });
}

/** Checks the selected paths on the server and prepares the ZIP; starting it is a navigation. */
export function useCreateDownload(endpointId: string) {
  return useMutation({
    mutationFn: (input: { snapshotId: string; paths: readonly string[] }) =>
      createDownload(endpointId, input.snapshotId, input.paths),
  });
}

/**
 * Enrollment tokens: the valid ones by default, every state with `state: "all"`.
 * `pollMs` follows a token the wizard waits on (it asks for every state, since
 * a token that was just used is no longer a valid one).
 */
export function useEnrollmentTokens(
  options: { enabled?: boolean; pollMs?: number | false; state?: TokenListState } = {},
) {
  const { tenantId, enabled } = useTenantScope();
  const state = options.state ?? "valid";
  return useQuery({
    queryKey: endpointKeys.tokens(tenantId, state),
    queryFn: () => fetchTokens(state),
    enabled: enabled && (options.enabled ?? true),
    refetchInterval: options.pollMs ?? IDLE_REFRESH_MS,
  });
}

export function useCreateToken() {
  const { tenantId } = useTenantScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTokenInput) => createToken(input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: endpointKeys.tokensAll(tenantId) }),
  });
}

export function useRevokeToken() {
  const { tenantId } = useTenantScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => revokeToken(tokenId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: endpointKeys.tokensAll(tenantId) }),
  });
}

/** Refresh lists and the detail of one machine, but not the snapshots (restic reads). */
function useRefreshEndpoint() {
  const { tenantId } = useTenantScope();
  const queryClient = useQueryClient();
  return React.useCallback(
    (endpointId: string) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: endpointKeys.lists(tenantId) }),
        queryClient.invalidateQueries({ queryKey: endpointKeys.detail(tenantId, endpointId) }),
      ]),
    [queryClient, tenantId],
  );
}

export function useUpdateEndpoint(endpointId: string) {
  const refresh = useRefreshEndpoint();
  return useMutation({
    mutationFn: (input: UpdateEndpointInput) => updateEndpoint(endpointId, input),
    onSettled: () => refresh(endpointId),
  });
}

export function useRevokeEndpoint(endpointId: string) {
  const refresh = useRefreshEndpoint();
  return useMutation({
    mutationFn: () => revokeEndpoint(endpointId),
    onSettled: () => refresh(endpointId),
  });
}

export function useUninstallEndpoint(endpointId: string) {
  const refresh = useRefreshEndpoint();
  return useMutation({
    mutationFn: () => uninstallEndpoint(endpointId),
    onSettled: () => refresh(endpointId),
  });
}

export function useCreateTask(endpointId: string) {
  const refresh = useRefreshEndpoint();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => createTask(endpointId, input),
    onSettled: () => refresh(endpointId),
  });
}

export function useRestoreTest(endpointId: string) {
  const refresh = useRefreshEndpoint();
  return useMutation({
    mutationFn: () => requestRestoreTest(endpointId),
    onSettled: () => refresh(endpointId),
  });
}

/**
 * Asks for the repository password. The answer is a secret, so the mutation is
 * dropped from the cache at once (`gcTime: 0`) and the dialog resets it on close.
 */
export function useRevealRepositoryPassword(endpointId: string) {
  return useMutation({
    mutationFn: () => revealRepositoryPassword(endpointId),
    gcTime: 0,
  });
}

/** Locale-bound formatters so every component says the same thing the same way. */
export function useEndpointFormat() {
  const { t, i18n } = useTranslation("endpoints");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return React.useMemo(
    () => ({
      t,
      language,
      bytes: (value: number) => formatBytes(value, language),
      integer: (value: number) => formatInteger(value, language),
      dateTime: (value: string | null | undefined) => formatDateTime(value, language),
    }),
    [t, language],
  );
}

export type EndpointFormat = ReturnType<typeof useEndpointFormat>;

/** The tenant-wide switch for automatic agent updates. */
export function useAgentUpdates() {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: endpointKeys.agentUpdates(tenantId),
    queryFn: fetchAgentUpdates,
    enabled,
  });
}

export function useSetAgentUpdates() {
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  return useMutation({
    mutationFn: (paused: boolean) => setAgentUpdates(paused),
    onSuccess: (result) => {
      queryClient.setQueryData(endpointKeys.agentUpdates(tenantId), result);
      void queryClient.invalidateQueries({ queryKey: endpointKeys.all(tenantId) });
    },
  });
}
