import { createRoute } from "@tanstack/react-router";
import { Boxes, FolderSearch } from "lucide-react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n.js";
import {
  BAREMETAL_WIZARD_PATTERN,
  ENDPOINT_DETAIL_PATTERN,
  FILE_RESTORE_PATH,
  FILE_RESTORE_ROLES,
  INVENTORY_PATH,
  parseDetailSearch,
  parseFileRestoreSearch,
  parseInventorySearch,
} from "./paths.js";
import {
  BaremetalWizardRoute,
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
 * directly. Everything is for administrators; File restore also for restore operators.
 */

export { ENDPOINT_ROLES, FILE_RESTORE_ROLES };

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

/** The bare metal restore wizard (preview, docs/BAREMETAL.md 14.6); not found without a verified ISO. */
export const baremetalWizardRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: BAREMETAL_WIZARD_PATTERN,
  component: BaremetalWizardRoute,
});

export const routes = [inventoryRoute, detailRoute, baremetalWizardRoute, fileRestoreRoute];

export const navItems: NavItem[] = [
  {
    id: "inventory",
    modules: ["endpoints"],
    path: INVENTORY_PATH,
    labelKey: "endpoints:nav.inventory",
    icon: Boxes,
    roles: [...ENDPOINT_ROLES],
    group: "endpoints",
    order: 20,
  },
  {
    id: "file-restore",
    // Files of machines and file shares, and of the guests of Proxmox VE.
    modules: ["endpoints", "pve"],
    path: FILE_RESTORE_PATH,
    labelKey: "endpoints:nav.fileRestore",
    icon: FolderSearch,
    roles: [...FILE_RESTORE_ROLES],
    group: "endpoints",
    order: 30,
  },
];
