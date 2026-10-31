import { createRoute } from "@tanstack/react-router";
import { Activity } from "lucide-react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import { RESOURCES_PATH } from "./paths.js";
import { ResourcesPage } from "./resources-page.js";
import "./i18n.js";

/**
 * Capacity planning (0.5.0): utilisation and growth per tenant and per repository, with a plain
 * forecast, for provider admins. The entry sits in the Installation section since the menu was
 * laid out (it showed "Soon" until this release). The page works with or without the
 * all-tenants view: the server lists every tenant the viewer may enter where the installation
 * has it, and the installation's one tenant otherwise.
 */

export { RESOURCES_PATH } from "./paths.js";
export { ResourcesPage } from "./resources-page.js";

export const resourcesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: RESOURCES_PATH,
  component: ResourcesPage,
  // `?sort=price` opens the table by monthly amount (the link of the price card on "All tenants").
  validateSearch: (search: Record<string, unknown>): { sort?: "price" } =>
    search.sort === "price" ? { sort: "price" } : {},
});

export const routes = [resourcesRoute];

export const navItems: NavItem[] = [
  {
    id: "resources",
    path: RESOURCES_PATH,
    labelKey: "nav.items.resources",
    icon: Activity,
    // Capacity planning (utilisation and growth per tenant and repository): provider admins.
    roles: ["provider_admin"],
    group: "installation",
    order: 50,
  },
];
