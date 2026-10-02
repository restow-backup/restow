import { describe, expect, it } from "vitest";

import { navItems, routes } from "./index";
import { RESOURCES_PATH, SOON_CONTENT, resourcesSoonItem, soonNavItems } from "./items";

describe("features of a later release", () => {
  it("lists capacity planning only: the job definitions shipped with 0.2.0", () => {
    expect(soonNavItems.map((item) => [item.id, item.path, item.soon])).toEqual([
      ["resources", RESOURCES_PATH, "0.5.0"],
    ]);
    expect(navItems).toBe(soonNavItems);
    expect(resourcesSoonItem().roles).toEqual(["provider_admin"]);
  });

  it("has a page for it, and none at /jobs, which belongs to the job definitions", () => {
    expect(routes.map((route) => (route.options as { path?: string }).path)).toEqual([
      RESOURCES_PATH,
    ]);
    expect(Object.keys(SOON_CONTENT)).toEqual(["resources"]);
  });
});
