import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/lib/session";

import { type Dashboard, dashboardKeys, fetchDashboard } from "./api.js";
import { wantsProviderView } from "./presenters.js";

/** How often the page refreshes itself while open. */
export const DASHBOARD_REFRESH_MS = 60_000;

/** The two views of a provider admin where the provider view exists. */
export type DashboardTab = "provider" | "tenant";

/**
 * The start page's one request. It is keyed by the active tenant, so a
 * tenant switch never shows the previous tenant's numbers, and it runs only
 * once the session is settled and a tenant is active.
 *
 * Provider admins get the provider view (where the installation enables it,
 * see `wantsProviderView`) in the same request, but only while its tab is shown: the provider view reads
 * every tenant, so the tenant tab's refreshes and opening a tenant from the
 * matrix do not repeat that walk. The provider response carries the active
 * tenant's widgets too; switching to the tenant tab shows them while the
 * tenant-only request runs, instead of skeletons.
 */
export function useDashboard(tab: DashboardTab) {
  const queryClient = useQueryClient();
  const {
    status: sessionStatus,
    activeTenant,
    isProviderAdmin,
    features,
    role,
    tenants,
    setActiveTenant,
  } = useSession();
  const tenantId = activeTenant?.id ?? null;
  const provider = wantsProviderView(isProviderAdmin, features);
  const withProvider = provider && tab === "provider";

  const query = useQuery({
    queryKey: dashboardKeys.page(tenantId, withProvider),
    queryFn: () => fetchDashboard(withProvider),
    enabled: sessionStatus === "authenticated" && tenantId !== null,
    refetchInterval: DASHBOARD_REFRESH_MS,
    placeholderData: withProvider
      ? undefined
      : () => queryClient.getQueryData<Dashboard>(dashboardKeys.page(tenantId, true)),
  });

  return {
    query,
    /** The provider view exists for this session (the tabs are shown). */
    provider,
    isProviderAdmin,
    /** Before the response says so, the session's role in the active tenant decides. */
    canAdminister:
      query.data?.viewer.canAdminister ?? (role === "provider_admin" || role === "tenant_admin"),
    tenantName: activeTenant?.name ?? null,
    setActiveTenant,
    /** Settled without an active tenant: nothing to show until one is chosen or created. */
    noTenant: sessionStatus === "authenticated" && tenantId === null,
    /** A provider admin before the first tenant exists (first run after setup). */
    firstTenantPending: isProviderAdmin && tenants.length === 0,
  };
}
