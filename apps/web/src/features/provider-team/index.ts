import { createRoute } from "@tanstack/react-router";
import { Users } from "lucide-react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import { TeamPage } from "./team-page";

/**
 * Members (the provider team), in every edition: who administers this
 * installation, with which role, and the owner's invitations, changes, removals
 * and access resets. Installation-wide, so provider admins only. Limiting a
 * member to chosen tenants is the gated feature `providerTeam.tenantScope`
 * (Service Provider in the full build); without it every member has every
 * tenant. The address stays `/team`, the id of the menu entry `team`.
 */
export const TEAM_ROUTE_PATH = "/team";

export const teamRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: TEAM_ROUTE_PATH,
  component: TeamPage,
});

export const routes = [teamRoute];

export const navItems: NavItem[] = [
  {
    id: "team",
    path: TEAM_ROUTE_PATH,
    labelKey: "team:nav",
    icon: Users,
    roles: ["provider_admin"],
    group: "installation",
    order: 20,
  },
];
