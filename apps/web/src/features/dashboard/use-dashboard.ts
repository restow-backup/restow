import { useQuery } from "@tanstack/react-query";

import { useLiveOpen } from "@/features/history/live/provider";
import { ownOrganisationPrompt } from "@/features/tenants/presenters";
import { providerMay } from "@/lib/provider-role";
import { hasFeature, sessionScope, useSession } from "@/lib/session";

import { type Dashboard, type DashboardMode, dashboardKeys, fetchDashboard } from "./api.js";

/** How often the page refreshes itself while open. */
export const DASHBOARD_REFRESH_MS = 60_000;

/**
 * The start page's one request. It is keyed by the active tenant, so a tenant
 * switch never shows the previous tenant's numbers, and it runs only once the
 * session is settled and a tenant is active.
 *
 * The overview follows the tenant switcher. `tenant` is the active tenant's
 * page; `all` is the provider view alone (the sum across tenants and the tenant
 * matrix) for "All tenants", asked for only where the session offers that scope.
 * The two are separate requests: the provider view reads every tenant, and an
 * ordinary tenant page does not repeat that walk.
 */
export function useDashboard(mode: DashboardMode = "tenant") {
  const session = useSession();
  const {
    status: sessionStatus,
    activeTenant,
    isProviderAdmin,
    role,
    tenants,
    setActiveTenant,
  } = session;
  const tenantId = activeTenant?.id ?? null;
  const allTenants = mode === "all";
  // "All tenants" is only ever asked for while the session is in that scope.
  const enabled =
    sessionStatus === "authenticated" &&
    tenantId !== null &&
    (!allTenants || sessionScope(session) === "all");

  const connected = useLiveOpen();
  const query = useQuery({
    queryKey: dashboardKeys.page(tenantId, mode),
    queryFn: () => fetchDashboard(mode),
    enabled,
    // The live channel brings the news that changes the overview (a run that ended); it polls only while that is down.
    refetchInterval: connected ? false : DASHBOARD_REFRESH_MS,
  });

  return {
    query,
    isProviderAdmin,
    /** Before the response says so, the session's role in the active tenant decides. */
    canAdminister:
      query.data?.viewer.canAdminister ?? (role === "provider_admin" || role === "tenant_admin"),
    tenantName: activeTenant?.name ?? null,
    setActiveTenant,
    /** Settled without an active tenant: nothing to show until one is chosen or created. */
    noTenant: sessionStatus === "authenticated" && tenantId === null,
    /**
     * What a provider admin is asked about the own organisation: to set it up
     * (first run after a failed setup step, or an installation from before it
     * existed), or to add the first customer. Null for everyone else.
     */
    ownOrganisation:
      sessionStatus === "authenticated"
        ? ownOrganisationPrompt({
            tenants,
            providerAdmin: isProviderAdmin,
            canManage: providerMay(session, "administrator", { everyTenant: true }),
            additionalTenants: hasFeature(session, "tenants.additional"),
          })
        : null,
  };
}

export type { Dashboard };
