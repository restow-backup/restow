import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { sourceKeys } from "@/features/sources/api";
import { fetchPages } from "@/lib/paged-list";
import { useSession } from "@/lib/session";
import {
  cancelImport,
  createImport,
  deleteUpload,
  fetchFolder,
  fetchImport,
  fetchImportConfig,
  fetchImports,
  fetchObjectList,
  fetchUploads,
  importKeys,
} from "./api";
import { type ImportedMailbox, collectMailboxes, isLive } from "./presenters";
import type { CreateImportInput, ImportDetail } from "./types";

/** How often a running import is asked for its progress. */
export const LIVE_POLL_MS = 3_000;
/** The history refreshes slowly while nothing runs. */
export const IDLE_POLL_MS = 30_000;

/**
 * Who may import in the active tenant (the API requires tenant_admin or a
 * provider admin), and whether tenant-scoped queries may run yet.
 */
export function useImportScope() {
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

export function useImportConfig() {
  const scope = useImportScope();
  const query = useQuery({
    queryKey: importKeys.config(scope.tenantId),
    queryFn: fetchImportConfig,
    enabled: scope.enabled,
    staleTime: 60_000,
  });
  return { ...scope, query };
}

/** Imports per page of the list (the API's maximum). */
export const IMPORTS_PAGE = 50;

/** The newest `pages` pages of imports, and whether older ones exist. */
export function useImportList(pages = 1) {
  const scope = useImportScope();
  const query = useQuery({
    queryKey: [...importKeys.list(scope.tenantId), pages],
    queryFn: () => fetchPages((offset) => fetchImports(offset), IMPORTS_PAGE, pages),
    enabled: scope.enabled,
    placeholderData: keepPreviousData,
    refetchInterval: (current) =>
      current.state.data?.items.some((entry) => isLive(entry)) ? LIVE_POLL_MS : IDLE_POLL_MS,
  });
  return { ...scope, query };
}

export function useImportDetail(importId: string) {
  const scope = useImportScope();
  const query = useQuery({
    queryKey: importKeys.detail(scope.tenantId, importId),
    queryFn: () => fetchImport(importId),
    enabled: scope.enabled,
    // Poll while queued or running; a finished import never changes again.
    refetchInterval: (current) =>
      current.state.data && isLive(current.state.data) ? LIVE_POLL_MS : false,
  });
  return { ...scope, query };
}

export function useFolderListing(path: string, enabled: boolean) {
  const scope = useImportScope();
  return useQuery({
    queryKey: importKeys.folder(scope.tenantId, path),
    queryFn: () => fetchFolder(path),
    enabled: scope.enabled && enabled,
    // A folder the operator fills while the page is open should show up on the next visit.
    staleTime: 0,
  });
}

/** Uploads started earlier and not used yet: the ones that can be continued or used. */
export function useUnfinishedUploads(enabled: boolean) {
  const scope = useImportScope();
  return useQuery({
    queryKey: importKeys.uploads(scope.tenantId),
    queryFn: fetchUploads,
    enabled: scope.enabled && enabled,
    staleTime: 0,
  });
}

export function useDiscardUpload() {
  const queryClient = useQueryClient();
  const { tenantId } = useImportScope();
  return useMutation({
    mutationFn: (uploadId: string) => deleteUpload(uploadId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: importKeys.uploads(tenantId) }),
  });
}

/** Imported mailboxes to add to: the account list's imported accounts merged with the history. */
export function useImportedMailboxes(enabled: boolean) {
  const scope = useImportScope();
  return useQuery<ImportedMailbox[]>({
    queryKey: importKeys.mailboxes(scope.tenantId),
    queryFn: async () => {
      const [objects, imports] = await Promise.allSettled([fetchObjectList(), fetchImports()]);
      if (objects.status === "rejected" && imports.status === "rejected") {
        throw imports.reason;
      }
      return collectMailboxes(
        objects.status === "fulfilled" ? objects.value : [],
        imports.status === "fulfilled" ? imports.value : [],
      );
    },
    enabled: scope.enabled && enabled,
    staleTime: 0,
  });
}

/** What a new import changes elsewhere: the history, the mailbox list and the source cards. */
function useInvalidateAfterChange() {
  const queryClient = useQueryClient();
  const { tenantId } = useImportScope();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: importKeys.all(tenantId) }),
      queryClient.invalidateQueries({ queryKey: sourceKeys.all(tenantId) }),
    ]);
}

export function useCreateImport() {
  const invalidate = useInvalidateAfterChange();
  return useMutation({
    mutationFn: (input: CreateImportInput) => createImport(input),
    onSuccess: () => invalidate(),
  });
}

export function useCancelImport() {
  const queryClient = useQueryClient();
  const { tenantId } = useImportScope();
  return useMutation({
    mutationFn: (importId: string) => cancelImport(importId),
    onSuccess: (detail: ImportDetail) => {
      queryClient.setQueryData(importKeys.detail(tenantId, detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: importKeys.list(tenantId) });
    },
  });
}
