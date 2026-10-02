import { describe, expect, it } from "vitest";

import { buildBreadcrumbTrail, scopeKindOf, scopeOpensGroup } from "./breadcrumb-trail.js";

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
        groupLabel: "Daily",
        groupId: "daily",
        pageTitle: "Audit log",
      }),
    ).toEqual([
      { key: "group", label: "Daily", group: "daily" },
      { key: "entry:audit", label: "Audit log", current: true },
    ]);
  });

  describe("tenant page", () => {
    // The entry crumb stands for the whole page of the tenant; the section is the title it publishes.
    const entry = { id: "tenant-settings", path: "/tenants/t1", label: "Tenant settings" };

    it("reads Tenants > Tenant settings > <section>, the entry leading to the page and the section current", () => {
      expect(
        buildBreadcrumbTrail({
          pathname: "/tenants/t1/connections",
          entry,
          groupLabel: "Tenants",
          groupId: "tenants",
          pageTitle: "Connections",
        }),
      ).toEqual([
        { key: "group", label: "Tenants", group: "tenants" },
        { key: "entry:tenant-settings", label: "Tenant settings", to: "/tenants/t1" },
        { key: "page", label: "Connections", current: true },
      ]);
    });

    it("keeps the section as the current page below it too", () => {
      expect(
        buildBreadcrumbTrail({
          pathname: "/tenants/t1/connections/imports/42",
          entry,
          groupLabel: "Tenants",
          groupId: "tenants",
          pageTitle: "Connections",
        }),
      ).toEqual([
        { key: "group", label: "Tenants", group: "tenants" },
        { key: "entry:tenant-settings", label: "Tenant settings", to: "/tenants/t1" },
        { key: "page", label: "Connections", current: true },
      ]);
    });
  });
});

describe("scope crumb", () => {
  const tenantScope = { kind: "tenant", label: "Tenant: Contoso" } as const;

  it("comes first and leaves the rest of the trail as it was", () => {
    expect(
      buildBreadcrumbTrail({
        pathname: "/history",
        entry: { id: "history", path: "/history", label: "History" },
        groupLabel: "Daily",
        groupId: "daily",
        pageTitle: "History",
        scope: tenantScope,
      }),
    ).toEqual([
      { key: "scope", label: "Tenant: Contoso", scope: "tenant" },
      { key: "group", label: "Daily", group: "daily" },
      { key: "entry:history", label: "History", current: true },
    ]);
  });

  it("keeps the entry a link on a detail page and the page title the current page", () => {
    expect(
      buildBreadcrumbTrail({
        pathname: "/history/7",
        entry: { id: "history", path: "/history", label: "History" },
        groupLabel: "Daily",
        groupId: "daily",
        pageTitle: "Weekly mail backup",
        scope: tenantScope,
      }),
    ).toEqual([
      { key: "scope", label: "Tenant: Contoso", scope: "tenant" },
      { key: "group", label: "Daily", group: "daily" },
      { key: "entry:history", label: "History", to: "/history" },
      { key: "page", label: "Weekly mail backup", current: true },
    ]);
  });

  it("is the menu of the group where the group is named like the scope (Installation)", () => {
    expect(
      buildBreadcrumbTrail({
        pathname: "/audit",
        entry: { id: "audit", path: "/audit", label: "Audit log" },
        groupLabel: "Installation",
        groupId: "installation",
        pageTitle: "Audit log",
        scope: { kind: "installation", label: "Installation" },
      }),
    ).toEqual([
      { key: "scope", label: "Installation", scope: "installation", group: "installation" },
      { key: "entry:audit", label: "Audit log", current: true },
    ]);
  });

  it("is the menu of the organisation's section too, where there is one organisation and no tenants", () => {
    // "Organisation: Contoso" > "Organisation" would say it twice.
    expect(
      buildBreadcrumbTrail({
        pathname: "/tenants/t1/protection",
        entry: { id: "organisation-settings", path: "/tenants/t1", label: "Settings" },
        groupLabel: "Organisation",
        groupId: "tenants",
        pageTitle: "Protection",
        scope: { kind: "organisation", label: "Organisation: Contoso", opensGroup: true },
      }),
    ).toEqual([
      { key: "scope", label: "Organisation: Contoso", scope: "organisation", group: "tenants" },
      { key: "entry:organisation-settings", label: "Settings", to: "/tenants/t1" },
      { key: "page", label: "Protection", current: true },
    ]);
    // Daily work keeps its own section crumb beside the organisation's pill.
    expect(
      buildBreadcrumbTrail({
        pathname: "/history",
        entry: { id: "history", path: "/history", label: "History" },
        groupLabel: "Daily",
        groupId: "daily",
        pageTitle: "History",
        scope: { kind: "organisation", label: "Organisation: Contoso", opensGroup: false },
      }).map((crumb) => crumb.key),
    ).toEqual(["scope", "group", "entry:history"]);
  });

  it("is the entry itself on the list of all tenants: one crumb, the current page", () => {
    const entry = { id: "tenants", path: "/tenants", label: "All tenants" };
    expect(
      buildBreadcrumbTrail({
        pathname: "/tenants",
        entry,
        groupLabel: "Tenants",
        groupId: "tenants",
        pageTitle: "All tenants",
        scope: { kind: "all", label: "All tenants" },
      }),
    ).toEqual([{ key: "scope", label: "All tenants", scope: "all", current: true }]);
    // Below the list it links back to it, and the page title is the current page.
    expect(
      buildBreadcrumbTrail({
        pathname: "/tenants/contoso",
        entry,
        groupLabel: "Tenants",
        groupId: "tenants",
        pageTitle: "Contoso",
        scope: { kind: "all", label: "All tenants" },
      }),
    ).toEqual([
      { key: "scope", label: "All tenants", scope: "all", to: "/tenants" },
      { key: "page", label: "Contoso", current: true },
    ]);
  });

  it("never says the scope twice: no crumb repeats the label of the scope", () => {
    const trails = [
      buildBreadcrumbTrail({
        pathname: "/settings",
        entry: { id: "settings", path: "/settings", label: "Settings" },
        groupLabel: "Installation",
        groupId: "installation",
        pageTitle: "Settings",
        scope: { kind: "installation", label: "Installation" },
      }),
      buildBreadcrumbTrail({
        pathname: "/tenants",
        entry: { id: "tenants", path: "/tenants", label: "All tenants" },
        groupLabel: "Tenants",
        groupId: "tenants",
        pageTitle: "All tenants",
        scope: { kind: "all", label: "All tenants" },
      }),
    ];
    for (const trail of trails) {
      const labels = trail.map((crumb) => crumb.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("reads <scope> > <section> > <entry> > <section of the page> on a tenant's page", () => {
    const entry = { id: "tenant-settings", path: "/tenants/t1", label: "Tenant settings" };
    expect(
      buildBreadcrumbTrail({
        pathname: "/tenants/t1/protection",
        entry,
        groupLabel: "Tenants",
        groupId: "tenants",
        pageTitle: "Protection",
        scope: tenantScope,
      }),
    ).toEqual([
      { key: "scope", label: "Tenant: Contoso", scope: "tenant" },
      { key: "group", label: "Tenants", group: "tenants" },
      { key: "entry:tenant-settings", label: "Tenant settings", to: "/tenants/t1" },
      { key: "page", label: "Protection", current: true },
    ]);
  });

  it("is not added to a page outside the menu", () => {
    expect(
      buildBreadcrumbTrail({
        pathname: "/account",
        entry: null,
        groupLabel: null,
        pageTitle: "Sign-in security",
        scope: tenantScope,
      }),
    ).toEqual([{ key: "page", label: "Sign-in security", current: true }]);
  });
});

describe("scopeKindOf", () => {
  const base = {
    groupId: "daily",
    entryId: "history",
    tenantKind: "customer",
    organisationMode: false,
  } as const;

  it("puts every page of the installation section on the installation", () => {
    for (const entryId of ["settings", "team", "audit", "license", "resources"]) {
      expect(scopeKindOf({ ...base, groupId: "installation", entryId })).toBe("installation");
    }
    // Whoever the active tenant is, and without one.
    expect(scopeKindOf({ ...base, groupId: "installation", tenantKind: null })).toBe(
      "installation",
    );
  });

  it("puts the list of all tenants, and the pages below it, on all tenants", () => {
    expect(scopeKindOf({ ...base, groupId: "tenants", entryId: "tenants" })).toBe("all");
    // The page of a tenant belongs to the entry that opens it, and that one is the tenant's.
    expect(scopeKindOf({ ...base, groupId: "tenants", entryId: "tenant-settings" })).toBe("tenant");
  });

  it("puts daily work and the tenant's pages on the active tenant, by kind", () => {
    expect(scopeKindOf(base)).toBe("tenant");
    expect(scopeKindOf({ ...base, tenantKind: "internal" })).toBe("internal");
    expect(scopeKindOf({ ...base, groupId: "tenants", entryId: "tenant-settings" })).toBe("tenant");
    expect(scopeKindOf({ ...base, groupId: "archive", entryId: "archive" })).toBe("tenant");
  });

  it("calls the one organisation of an installation without tenant management an organisation", () => {
    expect(scopeKindOf({ ...base, organisationMode: true })).toBe("organisation");
    // Even though it is marked as the own organisation (it always is there).
    expect(scopeKindOf({ ...base, organisationMode: true, tenantKind: "internal" })).toBe(
      "organisation",
    );
  });

  it("names no scope outside the menu, or while no tenant is active on a tenant page", () => {
    expect(scopeKindOf({ ...base, groupId: null, entryId: "account" })).toBeNull();
    expect(scopeKindOf({ ...base, tenantKind: null })).toBeNull();
  });

  describe("while the session works on All tenants", () => {
    const all = { ...base, allTenants: true } as const;

    it("puts every page of the daily work on all tenants, whatever tenant stays active underneath", () => {
      expect(scopeKindOf(all)).toBe("all");
      expect(scopeKindOf({ ...all, entryId: "dashboard" })).toBe("all");
      expect(scopeKindOf({ ...all, tenantKind: "internal" })).toBe("all");
      expect(scopeKindOf({ ...all, groupId: "mail", entryId: "restore" })).toBe("all");
    });

    it("leaves the installation's pages on the installation", () => {
      expect(scopeKindOf({ ...all, groupId: "installation", entryId: "settings" })).toBe(
        "installation",
      );
    });

    it("lets a tenant's own page name its tenant", () => {
      expect(scopeKindOf({ ...all, groupId: "tenants", entryId: "tenant-settings" })).toBe(
        "tenant",
      );
    });
  });

  describe("for somebody who may not manage tenants", () => {
    it("never puts a page on all tenants because it resolved to that entry (the page of a tenant that is not theirs)", () => {
      const notYours = {
        ...base,
        groupId: "tenants",
        entryId: "tenants",
        mayManageTenants: false,
      } as const;
      expect(scopeKindOf(notYours)).toBe("tenant");
      expect(scopeKindOf({ ...notYours, tenantKind: "internal" })).toBe("internal");
      expect(scopeKindOf({ ...notYours, organisationMode: true })).toBe("organisation");
      // A provider admin, or a caller that does not say, still gets the list's own level.
      expect(scopeKindOf({ ...notYours, mayManageTenants: true })).toBe("all");
      expect(scopeKindOf({ ...base, groupId: "tenants", entryId: "tenants" })).toBe("all");
    });
  });
});

describe("scopeOpensGroup", () => {
  it("lets the installation and the one organisation stand for their own section only", () => {
    expect(scopeOpensGroup("installation", "installation")).toBe(true);
    expect(scopeOpensGroup("organisation", "tenants")).toBe(true);
    // Everything else keeps the section crumb: tenants name their section "Tenants".
    expect(scopeOpensGroup("organisation", "daily")).toBe(false);
    expect(scopeOpensGroup("tenant", "tenants")).toBe(false);
    expect(scopeOpensGroup("internal", "tenants")).toBe(false);
    expect(scopeOpensGroup("all", "tenants")).toBe(false);
    expect(scopeOpensGroup("installation", null)).toBe(false);
  });
});
