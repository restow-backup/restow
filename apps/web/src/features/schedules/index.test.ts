import { CalendarClock } from "lucide-react";
import { describe, expect, it } from "vitest";

import { TENANT_SETUP_TABS } from "@/features/tenant-setup/tabs";

import { navItems, routes } from "./index.js";

describe("schedules feature module", () => {
  it("registers the page under the shell as a tab of the tenant setup area, not in the menu", () => {
    // Not yet in a route tree, so only the options know the path.
    expect(routes.map((route) => (route.options as { path?: string }).path)).toEqual([
      "/schedules",
    ]);
    expect(navItems).toEqual([]);
    const tab = TENANT_SETUP_TABS.find((candidate) => candidate.id === "schedules");
    expect(tab).toMatchObject({ path: "/schedules", icon: CalendarClock });
    // Every member of the tenant may open it (read-only for tenant users).
    expect(tab?.roles).toBeUndefined();
  });
});
