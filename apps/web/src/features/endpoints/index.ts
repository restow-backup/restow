import { createRoute } from "@tanstack/react-router";
import { Boxes, FolderSearch } from "lucide-react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n.js";
import {
  ENDPOINT_DETAIL_PATTERN,
  FILE_RESTORE_PATH,
  INVENTORY_PATH,
  parseDetailSearch,
  parseFileRestoreSearch,
  parseInventorySearch,
} from "./paths.js";
import {
  ENDPOINT_ROLES,
  EndpointDetailRoute,
  FileRestoreRoute,
  InventoryRoute,
} from "./route-pages.js";

/**
 * Server and client backup through an agent (docs/AGENT.md), the section
 * "Servers & endpoints": the inventory of machines with their status and
 * readiness (filter chips All, Servers, Clients), the wizard that enrolls one,
 * one page per machine with runs, snapshots, the file browser, restore and
 * settings, and File restore, which opens the file browser of any machine
 * directly. Everything is for administrators.
 */

export { ENDPOINT_ROLES };

export const inventoryRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: INVENTORY_PATH,
  validateSearch: (search: Record<string, unknown>) => parseInventorySearch(search),
  component: InventoryRoute,
});

export const detailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: ENDPOINT_DETAIL_PATTERN,
  validateSearch: (search: Record<string, unknown>) => parseDetailSearch(search),
  component: EndpointDetailRoute,
});

export const fileRestoreRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: FILE_RESTORE_PATH,
  validateSearch: (search: Record<string, unknown>) => parseFileRestoreSearch(search),
  component: FileRestoreRoute,
});

export const routes = [inventoryRoute, detailRoute, fileRestoreRoute];

export const navItems: NavItem[] = [
  {
    id: "inventory",
    path: INVENTORY_PATH,
    labelKey: "endpoints:nav.inventory",
    icon: Boxes,
    roles: [...ENDPOINT_ROLES],
    group: "endpoints",
    order: 20,
  },
  {
    id: "file-restore",
    path: FILE_RESTORE_PATH,
    labelKey: "endpoints:nav.fileRestore",
    icon: FolderSearch,
    roles: [...ENDPOINT_ROLES],
    group: "endpoints",
    order: 30,
  },
];
