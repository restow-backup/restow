import { createRoute } from "@tanstack/react-router";
import { HardDrive } from "lucide-react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";
import "./i18n";
import { StoragePage } from "./storage-page";

/**
 * Repositories: where the tenant's chunk store lives (installation default,
 * primary and copy repositories), whether each one works and can enforce
 * WORM, and how much the tenant stores. The page was "Storage" at `/storage`
 * before the final menu; that address leads here (features/redirects). The
 * code and the API keep the name storage (`/api/v1/storage`).
 */

export const REPOSITORIES_PATH = "/repositories";

export const storageRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: REPOSITORIES_PATH,
  component: StoragePage,
});

export const routes = [storageRoute];

export const navItems: NavItem[] = [
  {
    id: "repositories",
    path: REPOSITORIES_PATH,
    labelKey: "storage:nav",
    icon: HardDrive,
    // Repository settings need the tenant admin role (the page checks the active tenant).
    roles: ["provider_admin", "tenant_admin"],
    group: "admin",
    order: 10,
  },
];
