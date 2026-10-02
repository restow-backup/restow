import { describe, expect, it } from "vitest";

import { featureNavItems, featureRoutes } from "@/features/registry";

import { JOB_ROLES, navItems, routes } from "./index.js";

describe("backup jobs feature module", () => {
  it("registers the list and the page of one job", () => {
    expect(routes.map((route) => (route.options as { path?: string }).path)).toEqual([
      "/jobs",
      "/jobs/definitions/$jobId",
    ]);
    // They are part of the application's routes, below the shell.
    for (const route of routes) {
      expect(featureRoutes).toContain(route);
    }
  });

  it("keeps the two menu entries Jobs: one per kind, for the operators, without a Soon badge", () => {
    expect(
      navItems.map((item) => [item.id, item.path, item.search, item.group, item.order]),
    ).toEqual([
      ["mail-jobs", "/jobs", { type: "mail" }, "mail", 10],
      ["endpoint-jobs", "/jobs", { type: "endpoint" }, "endpoints", 10],
    ]);
    for (const item of navItems) {
      expect(item.soon).toBeUndefined();
      expect(item.roles).toEqual([...JOB_ROLES]);
      expect(item.labelKey).toBe("nav.items.jobs");
      expect(featureNavItems.find((entry) => entry.id === item.id)?.soon).toBeUndefined();
    }
    expect(JOB_ROLES).toEqual(["provider_admin", "tenant_admin"]);
  });
});
