import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/lib/session";

import {
  type ArchiveSearchParams,
  archiveKeys,
  fetchArchiveItem,
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
  });
}

export function useArchiveItem(id: string | null) {
  const { tenantId, enabled, canManage } = useTenantScope();
  return useQuery({
    queryKey: archiveKeys.item(tenantId, id ?? ""),
    queryFn: () => fetchArchiveItem(id as string),
    enabled: enabled && canManage && id !== null,
  });
}

export function useVerifyChain() {
  const { tenantId } = useTenantScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => verifyArchiveChain(),
    onSuccess: (result) => {
      queryClient.setQueryData(archiveKeys.chain(tenantId), result);
    },
  });
}
