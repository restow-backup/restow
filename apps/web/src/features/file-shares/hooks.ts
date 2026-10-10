import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { formatBytes, formatDateTime, formatInteger } from "@/lib/format";
import { useSession } from "@/lib/session";

import {
  type ConnectionInput,
  type CreateShareInput,
  type FileShareDetail,
  type FileShareList,
  type InstallationShareSettings,
  type RestoreInput,
  type UpdateShareInput,
  backupNow,
  cancelRun,
  createShare,
  createShareDownload,
  fetchInstallationShareSettings,
  fetchRestoreTargets,
  fetchRun,
  fetchRuns,
  fetchShare,
  fetchShareBrowse,
  fetchShareSettings,
  fetchShareSnapshots,
  fetchShareSource,
  fetchShares,
  fetchVersions,
  fileShareKeys,
  purgeShare,
  reactivateShare,
  requestRestore,
  requestVerify,
  retireShare,
  revealRepositoryPassword,
  searchShare,
  setApproval,
  setQuota,
  testConnection,
  testStoredShare,
  updateInstallationShareSettings,
  updateShare,
} from "./api.js";

/**
 * Queries and mutations of the file share pages. Keys carry the tenant, so a tenant switch never
 * shows another tenant's shares. A running run is followed closely (its progress), otherwise the
 * list is read now and then; restore points and folders never change and are not read twice.
 */

/** Locale-bound formatters and the `fileshares` texts, so every part says things the same way. */
export function useShareFormat() {
  const { t, i18n } = useTranslation("fileshares");
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

export type ShareFormat = ReturnType<typeof useShareFormat>;

export const ACTIVE_REFRESH_MS = 5_000;
export const IDLE_REFRESH_MS = 60_000;

export function useTenantScope() {
  const { status, activeTenant } = useSession();
  return {
    tenantId: activeTenant?.id ?? null,
    enabled: status === "authenticated" && activeTenant !== null,
  };
}

function busy(list: FileShareList | FileShareDetail | undefined): boolean {
  if (!list) return false;
  if ("items" in list) {
    return list.items.some((item) => item.activeRun !== null);
  }
  return list.activeRun !== null || list.runs.some((run) => run.status === "queued");
}

export function useShares() {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: fileShareKeys.list(tenantId),
    queryFn: fetchShares,
    enabled,
    refetchInterval: (query) => (busy(query.state.data) ? ACTIVE_REFRESH_MS * 3 : IDLE_REFRESH_MS),
  });
}

export function useShareSettings() {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: fileShareKeys.settings(tenantId),
    queryFn: fetchShareSettings,
    enabled,
    staleTime: 30_000,
  });
}

export function useRestoreTargets(wanted = true) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: fileShareKeys.targets(tenantId),
    queryFn: fetchRestoreTargets,
    enabled: enabled && wanted,
  });
}

export function useShare(id: string) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: fileShareKeys.detail(tenantId, id),
    queryFn: () => fetchShare(id),
    enabled: enabled && id !== "",
    retry: false,
    refetchInterval: (query) => (busy(query.state.data) ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS),
  });
}

export function useShareRuns(id: string) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: fileShareKeys.runs(tenantId, id),
    queryFn: () => fetchRuns(id),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.items.some((run) => ["queued", "starting", "running"].includes(run.status))
        ? ACTIVE_REFRESH_MS
        : IDLE_REFRESH_MS,
  });
}

export function useShareRun(id: string, runId: string | null, code: string | null) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: fileShareKeys.run(tenantId, id, runId ?? "", code ?? ""),
    queryFn: () => fetchRun(id, runId ?? "", { code: code ?? undefined, limit: 200 }),
    enabled: enabled && runId !== null,
    retry: false,
    refetchInterval: (query) =>
      ["queued", "starting", "running"].includes(query.state.data?.status ?? "")
        ? ACTIVE_REFRESH_MS
        : false,
  });
}

export function useShareSnapshots(id: string, wanted = true) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: fileShareKeys.snapshots(tenantId, id),
    queryFn: () => fetchShareSnapshots(id).then((result) => result.items),
    enabled: enabled && wanted,
    retry: false,
    staleTime: 60_000,
  });
}

export function useShareBrowse(id: string, snapshotId: string | null, path: string) {
  const { tenantId, enabled } = useTenantScope();
  return useInfiniteQuery({
    queryKey: fileShareKeys.browse(tenantId, id, snapshotId ?? "", path),
    queryFn: ({ pageParam }) => fetchShareBrowse(id, snapshotId ?? "", path, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && snapshotId !== null,
    retry: false,
    staleTime: 10 * 60_000,
  });
}

/** One folder of the live share (the runner's listing), for picking folders. */
export function useShareSource(id: string | null, path: string, wanted = true) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: fileShareKeys.source(tenantId, id ?? "", path),
    queryFn: () => fetchShareSource(id ?? "", path),
    enabled: enabled && wanted && id !== null,
    retry: false,
    staleTime: 30_000,
  });
}

export function useShareSearch(id: string, q: string) {
  const { tenantId, enabled } = useTenantScope();
  const term = q.trim();
  return useQuery({
    queryKey: fileShareKeys.search(tenantId, id, term),
    queryFn: () => searchShare(id, term),
    enabled: enabled && term.length >= 2,
    retry: false,
    staleTime: 60_000,
  });
}

export function useShareVersions(id: string, path: string | null) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: fileShareKeys.versions(tenantId, id, path ?? ""),
    queryFn: () => fetchVersions(id, path ?? ""),
    enabled: enabled && path !== null,
    retry: false,
  });
}

/** Everything about the shares of the tenant is read again after a change. */
function useInvalidate() {
  const client = useQueryClient();
  const { tenantId } = useTenantScope();
  return () => client.invalidateQueries({ queryKey: fileShareKeys.all(tenantId) });
}

export function useTestConnection() {
  return useMutation({ mutationFn: (input: ConnectionInput) => testConnection(input) });
}

export function useCreateShare() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateShareInput) => createShare(input),
    onSuccess: () => void invalidate(),
  });
}

export function useUpdateShare(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (patch: UpdateShareInput) => updateShare(id, patch),
    onSuccess: () => void invalidate(),
  });
}

export function useTestStoredShare(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => testStoredShare(id), onSuccess: () => void invalidate() });
}

export function useBackupNow(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (allowEmptyOnce: boolean) => backupNow(id, allowEmptyOnce),
    onSuccess: () => void invalidate(),
  });
}

export function useCancelRun(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (runId: string) => cancelRun(id, runId),
    onSuccess: () => void invalidate(),
  });
}

export function useRetireShare(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => retireShare(id), onSuccess: () => void invalidate() });
}

export function useReactivateShare(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => reactivateShare(id), onSuccess: () => void invalidate() });
}

export function usePurgeShare(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (confirmName: string) => purgeShare(id, confirmName),
    onSuccess: () => void invalidate(),
  });
}

export function useRequestRestore(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: RestoreInput) => requestRestore(id, input),
    onSuccess: () => void invalidate(),
  });
}

export function useRequestVerify(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => requestVerify(id), onSuccess: () => void invalidate() });
}

export function useSetQuota(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (quotaGib: number | null) => setQuota(id, quotaGib),
    onSuccess: () => void invalidate(),
  });
}

export function useSetApproval(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (approved: boolean) => setApproval(id, approved),
    onSuccess: () => void invalidate(),
  });
}

export function useRevealRepositoryPassword(id: string) {
  return useMutation({ mutationFn: () => revealRepositoryPassword(id) });
}

export function useCreateShareDownload(id: string) {
  return useMutation({
    mutationFn: (input: { snapshotId: string; paths: readonly string[] }) =>
      createShareDownload(id, input.snapshotId, input.paths),
  });
}

export function useInstallationShareSettings(enabled = true) {
  return useQuery({
    queryKey: fileShareKeys.installation(),
    queryFn: fetchInstallationShareSettings,
    enabled,
  });
}

export function useUpdateInstallationShareSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<typeof updateInstallationShareSettings>[0]) =>
      updateInstallationShareSettings(patch),
    onSuccess: (data: InstallationShareSettings) =>
      client.setQueryData(fileShareKeys.installation(), data),
  });
}
