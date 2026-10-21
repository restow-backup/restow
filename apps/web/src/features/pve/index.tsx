import { createRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Container } from "lucide-react";

import { RequireRole } from "@/components/require-role";
import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import { PveGuestPage } from "./guest-page.js";
import { type PveSearch, parsePveSearch } from "./guests-search.js";
import "./i18n.js";
import { PVE_GUEST_PATTERN, PVE_PATH, PVE_ROLES } from "./paths.js";
import { PvePage } from "./pve-page.js";

/**
 * VMs and containers of Proxmox VE (docs/PVE.md), in "Servers & endpoints":
 * the nodes with their helper, the guests with job, state and "Back up now",
 * the jobs, the onboarding ("Connect Proxmox VE"), and one page per guest
 * with its restore points ("Sicherungsstände"), restore as a new guest,
 * restore check and runs. For administrators.
 */

export { PVE_ROLES };

/** The page behind the role gate; tab, filters, order, page and open guest come from the address. */
function PveRoute() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const search = parsePveSearch(raw);
  const change = (next: PveSearch) => {
    void navigate({
      to: PVE_PATH as never,
      search: parsePveSearch({ ...next }) as never,
      replace: true,
    });
  };
  return (
    <RequireRole roles={PVE_ROLES}>
      <PvePage search={search} onSearchChange={change} />
    </RequireRole>
  );
}

function PveGuestRoute() {
  const { guestId } = useParams({ strict: false }) as { guestId?: string };
  if (!guestId) {
    return null;
  }
  return (
    <RequireRole roles={PVE_ROLES}>
      <PveGuestPage key={guestId} guestId={guestId} />
    </RequireRole>
  );
}

export const pveRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: PVE_PATH,
  validateSearch: (search: Record<string, unknown>) => parsePveSearch(search),
  component: PveRoute,
});

export const pveGuestRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: PVE_GUEST_PATTERN,
  component: PveGuestRoute,
});

export const routes = [pveRoute, pveGuestRoute];

export const navItems: NavItem[] = [
  {
    id: "virtualization",
    path: PVE_PATH,
    labelKey: "pve:nav.label",
    icon: Container,
    roles: [...PVE_ROLES],
    group: "endpoints",
    order: 25,
  },
];
