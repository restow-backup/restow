import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/lib/session";

import {
  type ReportRuleInput,
  type ReportRulePatch,
  createRule,
  deleteRule,
  fetchBell,
  fetchCatalog,
  fetchDeliveries,
  fetchInstallationBell,
  fetchRules,
  markBellRead,
  markInstallationBellRead,
  reportKeys,
  testRule,
  updateRule,
} from "./api";

/**
 * Data hooks of the reports page and the bell. Every key carries the active
 * tenant; nothing runs before a tenant is chosen.
 */

const DELIVERIES_REFRESH_MS = 15_000;
const BELL_REFRESH_MS = 60_000;

export function useReportsScope() {
  const { status, activeTenant, isProviderAdmin } = useSession();
  const authenticated = status === "authenticated";
  return {
    tenantId: activeTenant?.id ?? null,
    tenantName: activeTenant?.name ?? null,
    enabled: authenticated && activeTenant !== null,
    canManage: isProviderAdmin || activeTenant?.role === "tenant_admin",
    isProviderAdmin,
    /**
     * A provider administrator with no tenant open: no tenant bell, but the installation's own
     * notifications (an update is available or finished) still reach them.
     */
    installationOnly: authenticated && activeTenant === null && isProviderAdmin,
  };
}

export function useReportCatalog() {
  const { tenantId, enabled, canManage } = useReportsScope();
  return useQuery({
    queryKey: reportKeys.catalog(tenantId),
    queryFn: fetchCatalog,
    enabled: enabled && canManage,
    staleTime: 5 * 60_000,
  });
}

export function useReportRules() {
  const { tenantId, enabled, canManage } = useReportsScope();
  return useQuery({
    queryKey: reportKeys.rules(tenantId),
    queryFn: fetchRules,
    enabled: enabled && canManage,
  });
}

export function useReportDeliveries(ruleId: string | null) {
  const { tenantId, enabled, canManage } = useReportsScope();
  return useQuery({
    queryKey: reportKeys.deliveries(tenantId, ruleId),
    queryFn: () => fetchDeliveries(ruleId),
    enabled: enabled && canManage,
    refetchInterval: DELIVERIES_REFRESH_MS,
  });
}

function useInvalidateReports() {
  const { tenantId } = useReportsScope();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: reportKeys.all(tenantId) });
}

export function useCreateRule() {
  const invalidate = useInvalidateReports();
  return useMutation({
    mutationFn: (input: ReportRuleInput) => createRule(input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateRule() {
  const invalidate = useInvalidateReports();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ReportRulePatch }) => updateRule(id, patch),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteRule() {
  const invalidate = useInvalidateReports();
  return useMutation({
    mutationFn: (id: string) => deleteRule(id),
    onSuccess: () => invalidate(),
  });
}

export function useTestRule() {
  const invalidate = useInvalidateReports();
  return useMutation({
    mutationFn: (id: string) => testRule(id),
    onSuccess: () => invalidate(),
  });
}

/**
 * The bell's list: the active tenant's notifications (plus the installation's, for a provider
 * administrator), or the installation's alone while no tenant is open.
 */
export function useBell() {
  const { tenantId, enabled, installationOnly } = useReportsScope();
  return useQuery({
    queryKey: installationOnly ? reportKeys.installationBell : reportKeys.bell(tenantId),
    queryFn: installationOnly ? fetchInstallationBell : fetchBell,
    enabled: enabled || installationOnly,
    refetchInterval: BELL_REFRESH_MS,
  });
}

export function useMarkBellRead() {
  const { tenantId, installationOnly } = useReportsScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids?: string[]; all?: true }) =>
      installationOnly ? markInstallationBellRead(body) : markBellRead(body),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: installationOnly ? reportKeys.installationBell : reportKeys.bell(tenantId),
      }),
  });
}
