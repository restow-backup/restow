import { useRouter } from "@tanstack/react-router";
import * as React from "react";

import { isModuleShown } from "@/lib/modules";
import type { NavItem } from "@/lib/navigation";
import { sessionScope, useSession } from "@/lib/session";
import { withActiveTenant } from "@/lib/tenant-nav";
import { isTenantOffered, useTenantNavOffers } from "@/lib/tenant-nav-offers";

/**
 * Navigation items are assembled once in `router.tsx` (base items plus the
 * feature registry) and carried in the router context, so the sidebar never
 * imports feature modules and no import cycle forms through `routes/tree.ts`.
 * The entry that opens the tenant page leads to whichever tenant is active, so
 * its address is filled in here (lib/tenant-nav.ts). Under "All tenants" there is
 * no tenant to open: the entry then leads to the list of tenants, like it does
 * before any tenant is known. Entries that depend on the active tenant's state
 * (`tenantOffer`) are left out while the tenant does not offer them, and so are the
 * entries of a module of the installation that is off (`modules`, lib/modules.ts):
 * the one place where the sidebar and the command palette lose them.
 */
export function useNavItems(
  options: {
    /**
     * Keep the entries the active tenant does not offer (lib/tenant-nav-offers.ts) and those of
     * a module that is off: the breadcrumbs and the page header still know the page when it is
     * opened by its address.
     */
    includeNotOffered?: boolean;
  } = {},
): readonly NavItem[] {
  const items = useRouter().options.context.navItems;
  const session = useSession();
  const { activeTenant } = session;
  const modules = session.modules ?? null;
  const allTenants = sessionScope(session) === "all";
  const activeTenantId = allTenants ? null : (activeTenant?.id ?? null);
  const includeNotOffered = options.includeNotOffered === true;
  // Asked only where entries are left out (the sidebar, the command palette, the switcher).
  const offers = useTenantNavOffers({ enabled: !includeNotOffered });
  return React.useMemo(() => {
    const placed = withActiveTenant(items, activeTenantId);
    return includeNotOffered
      ? placed
      : placed.filter(
          (item) => isTenantOffered(item, offers) && isModuleShown(item.modules, modules),
        );
  }, [items, activeTenantId, offers, includeNotOffered, modules]);
}
