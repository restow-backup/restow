import { useQuery } from "@tanstack/react-query";

import { useTenantScope } from "@/features/endpoints/hooks";
import { canAccess, useSession } from "@/lib/session";

import { fetchOverview, overviewRefreshMs, type PveOverview, pveKeys } from "./api.js";
import { PVE_ROLES } from "./paths.js";

/**
 * The tenant's Proxmox VE overview (clusters, guests, jobs) for pages outside VMs & containers:
 * the job list of Servers & clients, the machine picker's hint, the recommended jobs. Asks
 * nothing for a role that may not open the Proxmox VE pages. Refreshes often while a guest
 * waits or backs up.
 */
export function usePveOverview() {
  const { role } = useSession();
  const allowed = canAccess(role, PVE_ROLES);
  const { tenantId, enabled } = useTenantScope();
  const query = useQuery({
    queryKey: pveKeys.overview(tenantId),
    queryFn: fetchOverview,
    enabled: enabled && allowed,
    refetchInterval: (state) => overviewRefreshMs(state.state.data),
  });
  return { allowed, query };
}

/** Whether the tenant has Proxmox VE connected: a node, or guests it reported. */
export function pveConnected(data: PveOverview | undefined): boolean {
  if (!data) {
    return false;
  }
  return data.clusters.some((cluster) => cluster.nodes.length > 0) || data.guests.length > 0;
}
