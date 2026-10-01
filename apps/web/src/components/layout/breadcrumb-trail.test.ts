import { describe, expect, it } from "vitest";

import { buildBreadcrumbTrail } from "./breadcrumb-trail.js";

const jobs = { id: "jobs", path: "/jobs", label: "Jobs" };

describe("buildBreadcrumbTrail", () => {
  it("ends at the menu entry on its own page", () => {
    expect(
      buildBreadcrumbTrail({
        pathname: "/jobs",
        entry: jobs,
        groupLabel: "Protection",
        pageTitle: "Backup jobs",
      }),
    ).toEqual([
      { key: "group", label: "Protection" },
      { key: "entry:jobs", label: "Jobs", current: true },
    ]);
  });

  it("names the entity on a detail page once the page published its title", () => {
    expect(
      buildBreadcrumbTrail({
        pathname: "/jobs/42",
        entry: jobs,
        groupLabel: "Protection",
        pageTitle: "Weekly mail backup",
      }),
    ).toEqual([
      { key: "group", label: "Protection" },
      { key: "entry:jobs", label: "Jobs", to: "/jobs" },
      { key: "page", label: "Weekly mail backup", current: true },
    ]);
  });

  it("falls back to the menu entry when a detail page publishes nothing", () => {
    const trail = buildBreadcrumbTrail({
      pathname: "/jobs/42",
      entry: jobs,
      groupLabel: "Protection",
      pageTitle: null,
    });
    expect(trail.at(-1)).toEqual({ key: "entry:jobs", label: "Jobs", to: "/jobs" });
  });

  it("does not repeat a group named like its entry", () => {
    expect(
      buildBreadcrumbTrail({
        pathname: "/",
        entry: { id: "dashboard", path: "/", label: "Overview" },
        groupLabel: "Overview",
        pageTitle: "Overview",
      }),
    ).toEqual([{ key: "entry:dashboard", label: "Overview", current: true }]);
  });

  it("shows only the page title outside the menu", () => {
    expect(
      buildBreadcrumbTrail({
        pathname: "/invitations/abc",
        entry: null,
        groupLabel: null,
        pageTitle: "Invitation",
      }),
    ).toEqual([{ key: "page", label: "Invitation", current: true }]);
    expect(
      buildBreadcrumbTrail({ pathname: "/x", entry: null, groupLabel: null, pageTitle: "  " }),
    ).toEqual([]);
  });

  it("marks the group crumb with its section, so it can open the section's entries", () => {
    expect(
      buildBreadcrumbTrail({
        pathname: "/audit",
        entry: { id: "audit", path: "/audit", label: "Audit log" },
        groupLabel: "Admin",
        groupId: "admin",
        pageTitle: "Audit log",
      }),
    ).toEqual([
      { key: "group", label: "Admin", group: "admin" },
      { key: "entry:audit", label: "Audit log", current: true },
    ]);
  });

  describe("tenant setup area", () => {
    const setup = { id: "tenants", path: "/protected-objects", label: "Contoso" };
    const protection = { id: "protection", path: "/protected-objects", label: "Protection" };
    const imports = { id: "imports", path: "/imports", label: "Imports" };

    it("reads Tenants › <tenant> › <tab>, the tenant leading to the area and the tab current", () => {
      expect(
        buildBreadcrumbTrail({
          pathname: "/protected-objects",
          entry: setup,
          groupLabel: "Tenants",
          groupId: "tenants",
          setupTab: protection,
          pageTitle: "Protected objects",
        }),
      ).toEqual([
        { key: "group", label: "Tenants", group: "tenants" },
        { key: "entry:tenants", label: "Contoso", to: "/protected-objects" },
        { key: "tab:protection", label: "Protection", current: true },
      ]);
    });

    it("links the tab from a page below it and names that page", () => {
      expect(
        buildBreadcrumbTrail({
          pathname: "/imports/42",
          entry: { id: "tenant-setup", path: "/protected-objects", label: "Setup" },
          groupLabel: "Tenants",
          groupId: "tenants",
          setupTab: imports,
          pageTitle: "mailstore-2025.zip",
        }),
      ).toEqual([
        { key: "group", label: "Tenants", group: "tenants" },
        { key: "entry:tenant-setup", label: "Setup", to: "/protected-objects" },
        { key: "tab:imports", label: "Imports", to: "/imports" },
        { key: "page", label: "mailstore-2025.zip", current: true },
      ]);
    });
  });
});
