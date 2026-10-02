import { describe, expect, it } from "vitest";

import { CORE_TENANT_SECTIONS } from "@/features/tenant-page/sections";

import { navItems, routes } from "./index.js";

describe("schedules feature module", () => {
  it("registers no route and no menu entry: the page is the Jobs & schedules section of the tenant page", () => {
    expect(routes).toEqual([]);
    expect(navItems).toEqual([]);
    expect(CORE_TENANT_SECTIONS.map((section) => section.id)).toContain("jobs");
  });
});
