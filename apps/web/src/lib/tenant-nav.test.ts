import { Settings } from "lucide-react";
import { describe, expect, it } from "vitest";

import type { NavItem } from "@/lib/navigation";

import { TENANT_PAGE_MATCH, TENANT_SETTINGS_PATH, withActiveTenant } from "./tenant-nav";

const settings: NavItem = {
  id: "tenant-settings",
  path: TENANT_SETTINGS_PATH,
  matches: [TENANT_PAGE_MATCH],
  labelKey: "nav.items.tenantSettings",
  icon: Settings,
};
const history: NavItem = { id: "history", path: "/history", labelKey: "x", icon: Settings };

describe("withActiveTenant", () => {
  it("opens the overview of the active tenant, and covers every page of it", () => {
    const [entry, other] = withActiveTenant([settings, history], "t1");
    expect(entry).toMatchObject({ path: "/tenants/t1/overview", matches: ["/tenants/t1"] });
    expect(other).toBe(history);
  });

  it("encodes the id", () => {
    expect(withActiveTenant([settings], "a b")[0]?.path).toBe("/tenants/a%20b/overview");
  });

  it("leads to the list of tenants while no tenant is active, instead of to an address with a hole", () => {
    expect(withActiveTenant([settings], null)[0]).toMatchObject({ path: "/tenants", matches: [] });
  });
});
