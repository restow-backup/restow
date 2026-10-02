import { useRouter } from "@tanstack/react-router";
import * as React from "react";

import type { NavItem } from "@/lib/navigation";
import { sessionScope, useSession } from "@/lib/session";
import { withActiveTenant } from "@/lib/tenant-nav";

/**
 * Navigation items are assembled once in `router.tsx` (base items plus the
 * feature registry) and carried in the router context, so the sidebar never
 * imports feature modules and no import cycle forms through `routes/tree.ts`.
 * The entry that opens the tenant page leads to whichever tenant is active, so
 * its address is filled in here (lib/tenant-nav.ts). Under "All tenants" there is
 * no tenant to open: the entry then leads to the list of tenants, like it does
 * before any tenant is known.
 */
export function useNavItems(): readonly NavItem[] {
  const items = useRouter().options.context.navItems;
  const session = useSession();
  const { activeTenant } = session;
  const allTenants = sessionScope(session) === "all";
  const activeTenantId = allTenants ? null : (activeTenant?.id ?? null);
  return React.useMemo(() => withActiveTenant(items, activeTenantId), [items, activeTenantId]);
}
