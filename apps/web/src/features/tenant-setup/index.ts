import { Building2 } from "lucide-react";

import type { NavItem } from "@/lib/navigation";

import {
  TENANT_SETUP_NAV_ID,
  TENANT_SETUP_PATH,
  TENANT_SETUP_PATHS,
  TENANT_SETUP_TABS,
} from "./tabs";

export { TenantSetupTabs, useOpenTenantSetup } from "./setup-tabs";
export {
  TENANT_SETUP_NAV_ID,
  TENANT_SETUP_PATH,
  TENANT_SETUP_PATHS,
  TENANT_SETUP_TABS,
  type TenantSetupTab,
  findTenantSetupTab,
  isTenantSetupTabPage,
  visibleTenantSetupTabs,
} from "./tabs";

/** The area has no pages of its own: every tab is an existing route (see tabs.ts). */
export const routes = [];

/**
 * "Setup": the one entry of the Tenants section in an installation with one
 * tenant (Community, Business). Where the installation manages tenants
 * (`tenants.additional`), "All tenants" stands there instead and the area
 * opens per tenant ("Open tenant page"). The entry stays highlighted on
 * every page of the area.
 */
export const navItems: NavItem[] = [
  {
    id: TENANT_SETUP_NAV_ID,
    path: TENANT_SETUP_PATH,
    matches: TENANT_SETUP_PATHS,
    labelKey: "nav.items.setup",
    icon: Building2,
    // The area is for administrators; the schedules page itself stays open
    // to every member under its address.
    roles: [...new Set(TENANT_SETUP_TABS.flatMap((tab) => tab.roles ?? []))],
    group: "tenants",
    order: 20,
    visible: (context) => !(context.features ?? []).includes("tenants.additional"),
  },
];
