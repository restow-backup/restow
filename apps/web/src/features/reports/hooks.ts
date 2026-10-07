import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { sessionScope, useSession } from "@/lib/session";

import {
  DELIVERY_PAGE,
  type DeliveryFilters,
  type NotificationFilters,
  type ReportDelivery,
  type ReportRuleInput,
  type ReportRulePatch,
  createRule,
  deleteRule,
  fetchBell,
  fetchCatalog,
  fetchDeliveries,
  fetchHistory,
  fetchInstallationBell,
  fetchProviderDeliveries,
  fetchProviderHistory,
  fetchRules,
  markBellRead,
  markInstallationBellRead,
  markProviderBellRead,
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
  const session = useSession();
  const { status, activeTenant, isProviderAdmin } = session;
  const authenticated = status === "authenticated";
  /**
   * "All tenants" (Service Provider): the bell and the alerts look across every tenant, each
   * entry with its tenant, instead of silently showing the last tenant's.
   */
  const allTenants = authenticated && isProviderAdmin && sessionScope(session) === "all";
  return {
    allTenants,
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

/** A full page may have older rows behind it: page on from the last row's time. */
function nextBefore(page: readonly ReportDelivery[]): string | null {
  return page.length >= DELIVERY_PAGE ? (page.at(-1)?.createdAt ?? null) : null;
}

/**
 * The delivery log, filtered, a page at a time (`fetchNextPage` loads older entries). Under
 * "All tenants" it is every covered tenant's log, each row with its tenant.
 */
export function useReportDeliveries(filters: Omit<DeliveryFilters, "before"> = {}) {
  const { tenantId, enabled, canManage, allTenants } = useReportsScope();
  const query = useInfiniteQuery({
    queryKey: allTenants
      ? reportKeys.providerDeliveries(filters)
      : reportKeys.deliveries(tenantId, filters),
    queryFn: ({ pageParam }) =>
      allTenants
        ? fetchProviderDeliveries({ ...filters, before: pageParam })
        : fetchDeliveries({ ...filters, before: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: nextBefore,
    enabled: allTenants || (enabled && canManage),
    refetchInterval: DELIVERIES_REFRESH_MS,
  });
  const items = React.useMemo(() => (query.data?.pages ?? []).flat(), [query.data]);
  return { ...query, items };
}

/** The notification history behind the bell, a page at a time (all tenants under "All tenants"). */
export function useNotificationHistory(filters: NotificationFilters = {}) {
  const { tenantId, enabled, allTenants } = useReportsScope();
  const query = useInfiniteQuery({
    queryKey: allTenants
      ? reportKeys.providerHistory(filters)
      : reportKeys.history(tenantId, filters),
    queryFn: ({ pageParam }) =>
      allTenants ? fetchProviderHistory(filters, pageParam) : fetchHistory(filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
    enabled: allTenants || enabled,
  });
  const items = React.useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.items),
    [query.data],
  );
  return { ...query, items };
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
  const { tenantId, enabled, installationOnly, allTenants } = useReportsScope();
  return useQuery({
    queryKey: allTenants
      ? reportKeys.providerBell
      : installationOnly
        ? reportKeys.installationBell
        : reportKeys.bell(tenantId),
    queryFn: allTenants
      ? () => fetchProviderHistory({}, null)
      : installationOnly
        ? fetchInstallationBell
        : fetchBell,
    enabled: enabled || installationOnly || allTenants,
    refetchInterval: BELL_REFRESH_MS,
  });
}

export function useMarkBellRead() {
  const { tenantId, installationOnly, allTenants } = useReportsScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids?: string[]; all?: true }) =>
      allTenants
        ? markProviderBellRead(body)
        : installationOnly
          ? markInstallationBellRead(body)
          : markBellRead(body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: allTenants
            ? reportKeys.providerBell
            : installationOnly
              ? reportKeys.installationBell
              : reportKeys.bell(tenantId),
        }),
        // The history page shows the same entries.
        queryClient.invalidateQueries({
          queryKey: allTenants ? ["provider", "notifications"] : reportKeys.bell(tenantId),
        }),
      ]),
  });
}
