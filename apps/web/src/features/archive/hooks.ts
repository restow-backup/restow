import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/lib/session";

import {
  type ArchiveSearchParams,
  archiveKeys,
  fetchArchiveItem,
  fetchArchivePreview,
  fetchArchiveRetention,
  searchArchive,
  verifyArchiveChain,
} from "./api.js";

export function useTenantScope() {
  const { status, activeTenant, isProviderAdmin } = useSession();
  return {
    tenantId: activeTenant?.id ?? null,
    enabled: status === "authenticated" && activeTenant !== null,
    /** Search and reading are tenant-administrator only (see apps/api/src/features/archive/routes.ts). */
    canManage: isProviderAdmin || activeTenant?.role === "tenant_admin",
  };
}

export function useArchiveSearch(params: ArchiveSearchParams) {
  const { tenantId, enabled, canManage } = useTenantScope();
  return useQuery({
    queryKey: archiveKeys.search(tenantId, params),
    queryFn: () => searchArchive(params),
    enabled: enabled && canManage,
    placeholderData: (previous) => previous,
    // Every search is audited: run one when the person asks, not on every focus of the window.
    refetchOnWindowFocus: false,
  });
}

export function useArchiveItem(id: string | null) {
  const { tenantId, enabled, canManage } = useTenantScope();
  return useQuery({
    queryKey: archiveKeys.item(tenantId, id ?? ""),
    queryFn: () => fetchArchiveItem(id as string),
    enabled: enabled && canManage && id !== null,
    refetchOnWindowFocus: false,
  });
}

/** The reading pane of one archived message (an audited read, so only for the selected one). */
export function useArchivePreview(id: string | null) {
  const { tenantId, enabled, canManage } = useTenantScope();
  return useQuery({
    queryKey: archiveKeys.preview(tenantId, id ?? ""),
    queryFn: () => fetchArchivePreview(id as string),
    enabled: enabled && canManage && id !== null,
    // Each read is audited: keep what was read instead of reading it again on focus.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** The archive check; `contentSample` messages are read back from storage (0 skips that). */
export function useVerifyChain() {
  const { tenantId } = useTenantScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contentSample: number) => verifyArchiveChain(contentSample),
    onSuccess: (result) => {
      queryClient.setQueryData(archiveKeys.chain(tenantId), result);
    },
  });
}

/** The retention that applies to the active tenant's archive. */
export function useArchiveRetention() {
  const { tenantId, enabled, canManage } = useTenantScope();
  return useQuery({
    queryKey: archiveKeys.retention(tenantId),
    queryFn: fetchArchiveRetention,
    enabled: enabled && canManage,
  });
}
