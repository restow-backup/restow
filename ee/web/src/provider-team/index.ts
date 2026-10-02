import { createRoute } from "@tanstack/react-router";
import { Users } from "lucide-react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import { editionLock } from "../license/nav-lock";
import "./i18n";
import { TeamPage } from "./team-page";

/**
 * The team page (Business and Service Provider, `provider.team`):
 * installation-wide, so provider admins only; on Community the menu entry
 * shows locked like every other licensed feature.
 */
export const TEAM_ROUTE_PATH = "/team";

export const teamRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: TEAM_ROUTE_PATH,
  component: TeamPage,
});

export const teamNavItems: NavItem[] = [
  {
    id: "team",
    path: TEAM_ROUTE_PATH,
    labelKey: "team:nav",
    icon: Users,
    roles: ["provider_admin"],
    group: "installation",
    order: 20,
    lock: editionLock("business"),
  },
];
