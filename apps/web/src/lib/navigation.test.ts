import { Archive, Building2, HardDrive, LayoutDashboard, ListChecks } from "lucide-react";
import { describe, expect, it } from "vitest";

import {
  NAV_GROUPS,
  type NavItem,
  type NavLock,
  type NavLockContext,
  findActiveNavItem,
  groupNavItems,
  inferNavGroup,
  isNavItemActive,
  isNavItemLocked,
  isNavItemOffered,
  isNavItemPage,
  matchedNavPath,
  navGroupLabelKey,
  pathAfterTenantSwitch,
  visibleNavItems,
} from "./navigation.js";

/** No extension registered: nothing locked, nothing known. */
const NO_LOCKS: NavLockContext = { features: [], extensions: {} };

const allow = (role: string | null, allowed: readonly string[] | undefined) =>
  !allowed || allowed.length === 0 || (role !== null && allowed.includes(role));

const items: NavItem[] = [
  { id: "tenants", path: "/tenants", labelKey: "x", icon: Building2, roles: ["provider_admin"] },
  { id: "archive-search", path: "/archive", labelKey: "x", icon: Archive },
  { id: "backup", path: "/backup", labelKey: "x", icon: HardDrive, order: 5 },
  { id: "restore", path: "/restore", labelKey: "x", icon: HardDrive, order: 1 },
  {
    id: "dashboard",
    path: "/",
    labelKey: "x",
    icon: LayoutDashboard,
    group: "daily",
    exact: true,
  },
];

describe("inferNavGroup", () => {
  it("maps ids to sections by keyword", () => {
    expect(inferNavGroup("restore")).toBe("mail");
    expect(inferNavGroup("mail-exports")).toBe("mail");
    // The archive is part of Mail & SaaS.
    expect(inferNavGroup("archive-search")).toBe("mail");
    expect(inferNavGroup("journal")).toBe("mail");
    expect(inferNavGroup("endpoint-agents")).toBe("endpoints");
    expect(inferNavGroup("inventory")).toBe("endpoints");
    expect(inferNavGroup("tenants")).toBe("tenants");
    expect(inferNavGroup("audit-log")).toBe("installation");
    expect(inferNavGroup("license")).toBe("installation");
    expect(inferNavGroup("dashboard")).toBe("daily");
    expect(inferNavGroup("history")).toBe("daily");
  });

  it("puts the tenant's own pages with the tenants and the operator's with the installation", () => {
    // Tenant level: the settings (in either wording), repositories, integrations, members.
    for (const id of [
      "tenant-settings",
      "organisation-settings",
      "repositories",
      "integrations",
      "tenant-members",
    ]) {
      expect(inferNavGroup(id), id).toBe("tenants");
    }
    // Installation level, the settings of the installation itself included.
    for (const id of ["settings", "team", "audit", "license", "resources", "notifications"]) {
      expect(inferNavGroup(id), id).toBe("installation");
    }
  });

  it("falls back to other for unknown ids", () => {
    expect(inferNavGroup("something-else")).toBe("other");
  });
});

describe("the sections", () => {
  it("run Daily, Mail & SaaS, Servers & endpoints, Tenants, Installation, then the rest", () => {
    expect([...NAV_GROUPS]).toEqual([
      "daily",
      "mail",
      "endpoints",
      "tenants",
      "installation",
      "other",
    ]);
  });

  it("label the tenants section Organisation without tenant management, by the feature alone", () => {
    expect(navGroupLabelKey("tenants", { features: [] })).toBe("nav.groups.organisation");
    expect(navGroupLabelKey("tenants", { features: null })).toBe("nav.groups.organisation");
    expect(navGroupLabelKey("tenants", { features: ["tenants.additional"] })).toBe(
      "nav.groups.tenants",
    );
    for (const group of NAV_GROUPS.filter((id) => id !== "tenants")) {
      expect(navGroupLabelKey(group, { features: [] })).toBe(`nav.groups.${group}`);
    }
  });
});

describe("groupNavItems", () => {
  it("orders groups by section and items by order, hiding what the role may not see", () => {
    const groups = groupNavItems(items, "tenant_user", allow, NO_LOCKS);
    expect(groups.map((group) => group.id)).toEqual(["daily", "mail", "other"]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(["restore", "archive-search"]);
  });

  it("shows the tenants section to the provider admin", () => {
    const groups = groupNavItems(items, "provider_admin", allow, NO_LOCKS);
    expect(groups.map((group) => group.id)).toEqual(["daily", "mail", "tenants", "other"]);
  });

  it("keeps insertion order for items without explicit order", () => {
    const groups = groupNavItems(
      [
        { id: "backup-b", path: "/b", labelKey: "x", icon: HardDrive },
        { id: "backup-a", path: "/a", labelKey: "x", icon: HardDrive },
      ],
      null,
      allow,
      NO_LOCKS,
    );
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["backup-b", "backup-a"]);
  });
});

describe("nav locks", () => {
  /** A lock as an extension supplies it: open once the profile's `level` field reaches `level`. */
  const lockFor = (level: number): NavLock => ({
    isLocked: (context) => {
      const granted = context.extensions?.level;
      return typeof granted !== "number" || granted < level;
    },
    to: "/settings",
    search: { section: "about", requires: `level-${level}` },
    hintKey: `x:locked.${level}`,
  });
  const locked: NavItem[] = [
    { id: "dashboard", path: "/", labelKey: "x", icon: LayoutDashboard, exact: true },
    {
      id: "tenants",
      path: "/tenants",
      labelKey: "x",
      icon: Building2,
      roles: ["provider_admin"],
      lock: lockFor(2),
    },
    {
      id: "backup-report",
      path: "/report",
      labelKey: "x",
      icon: HardDrive,
      lock: lockFor(1),
    },
  ];
  const context = (level: number | null): NavLockContext =>
    level === null ? { features: null, extensions: null } : { features: [], extensions: { level } };
  const ids = (level: number | null) =>
    groupNavItems(locked, "provider_admin", allow, context(level)).flatMap((group) =>
      group.items.map((item) => item.id),
    );
  const lockedIds = (level: number | null) =>
    groupNavItems(locked, "provider_admin", allow, context(level)).flatMap((group) =>
      group.items.filter((item) => item.locked).map((item) => item.id),
    );

  it("never drops a locked item: the role decides what shows, the lock only locks", () => {
    // Group order (NAV_GROUPS): daily (dashboard), tenants (tenants),
    // other (backup-report).
    expect(ids(0)).toEqual(["dashboard", "tenants", "backup-report"]);
    expect(ids(1)).toEqual(["dashboard", "tenants", "backup-report"]);
    expect(ids(2)).toEqual(["dashboard", "tenants", "backup-report"]);
  });

  it("marks exactly the items whose lock reports locked", () => {
    expect(lockedIds(0)).toEqual(["tenants", "backup-report"]);
    expect(lockedIds(1)).toEqual(["tenants"]);
    expect(lockedIds(2)).toEqual([]);
  });

  it("hands the lock the session's context, null fields while the profile loads", () => {
    expect(lockedIds(null)).toEqual(["tenants", "backup-report"]);
    const seen: NavLockContext[] = [];
    const spy: NavItem = {
      id: "spy",
      path: "/spy",
      labelKey: "x",
      icon: HardDrive,
      lock: { isLocked: (ctx) => seen.push(ctx) > 0, to: "/", hintKey: "x" },
    };
    const ctx = { features: ["reports.timed" as const], extensions: { marker: "x" } };
    groupNavItems([spy], null, allow, ctx);
    expect(seen).toEqual([ctx]);
  });

  it("never locks an item without a lock, whatever the context", () => {
    expect(isNavItemLocked({}, context(null))).toBe(false);
    expect(isNavItemLocked({ lock: lockFor(1) }, context(1))).toBe(false);
    expect(isNavItemLocked({ lock: lockFor(1) }, context(0))).toBe(true);
  });

  it("still applies the role regardless of locks (role hides, lock only locks)", () => {
    const groups = groupNavItems(locked, "tenant_admin", allow, context(2));
    expect(groups.flatMap((group) => group.items.map((item) => item.id))).not.toContain("tenants");
  });

  it("visibleNavItems keeps every item, in original order, flagged locked", () => {
    const items = visibleNavItems(locked, "provider_admin", allow, context(0));
    expect(items.map((item) => item.id)).toEqual(["dashboard", "tenants", "backup-report"]);
    expect(items.map((item) => item.locked)).toEqual([false, true, true]);
  });
});

describe("isNavItemActive", () => {
  it("matches the root only exactly", () => {
    expect(isNavItemActive({ path: "/", exact: true }, "/")).toBe(true);
    expect(isNavItemActive({ path: "/" }, "/restore")).toBe(false);
  });

  it("matches nested paths for section items", () => {
    expect(isNavItemActive({ path: "/backup" }, "/backup")).toBe(true);
    expect(isNavItemActive({ path: "/backup" }, "/backup/sources/1")).toBe(true);
    expect(isNavItemActive({ path: "/backup" }, "/backups")).toBe(false);
    expect(isNavItemActive({ path: "/backup/" }, "/backup")).toBe(true);
  });
});

describe("findActiveNavItem", () => {
  const restore: NavItem[] = [
    { id: "restore", path: "/restore", labelKey: "x", icon: HardDrive },
    { id: "restore-jobs", path: "/restore/jobs", labelKey: "x", icon: ListChecks },
    { id: "dashboard", path: "/", labelKey: "x", icon: LayoutDashboard, exact: true },
  ];

  it("picks the most specific entry", () => {
    expect(findActiveNavItem(restore, "/restore/jobs/42")?.id).toBe("restore-jobs");
    expect(findActiveNavItem(restore, "/restore")?.id).toBe("restore");
    expect(findActiveNavItem(restore, "/restore/snapshots")?.id).toBe("restore");
    expect(findActiveNavItem(restore, "/")?.id).toBe("dashboard");
  });

  it("returns null outside every entry", () => {
    expect(findActiveNavItem(restore, "/account")).toBeNull();
  });

  it("tells a list page from a page below it", () => {
    expect(isNavItemPage({ path: "/jobs" }, "/jobs/")).toBe(true);
    expect(isNavItemPage({ path: "/jobs" }, "/jobs/7")).toBe(false);
  });
});

describe("pathAfterTenantSwitch", () => {
  const entries = [{ path: "/jobs" }, { path: "/sources" }, { path: "/", exact: true }] as const;

  it("stays on list pages and on pages outside the menu", () => {
    expect(pathAfterTenantSwitch("/jobs", entries)).toBeNull();
    expect(pathAfterTenantSwitch("/", entries)).toBeNull();
    expect(pathAfterTenantSwitch("/account", entries)).toBeNull();
  });

  it("leaves a detail page of the previous tenant for its list", () => {
    expect(pathAfterTenantSwitch("/jobs/123", entries)).toBe("/jobs");
    expect(pathAfterTenantSwitch("/sources/abc/permissions", entries)).toBe("/sources");
  });
});

describe("entries with search params, extra paths and availability", () => {
  const entries: NavItem[] = [
    { id: "settings", path: "/settings", labelKey: "x", icon: HardDrive },
    {
      id: "license",
      path: "/settings",
      search: { section: "about" },
      labelKey: "x",
      icon: HardDrive,
    },
    { id: "history", path: "/history", labelKey: "x", icon: ListChecks },
    {
      id: "mail-jobs",
      path: "/jobs",
      search: { type: "mail" },
      labelKey: "x",
      icon: ListChecks,
    },
    {
      id: "endpoint-jobs",
      path: "/jobs",
      search: { type: "endpoint" },
      labelKey: "x",
      icon: ListChecks,
    },
    {
      id: "setup",
      path: "/protected-objects",
      matches: ["/schedules", "/imports", "/sources/import"],
      labelKey: "x",
      icon: Building2,
    },
    // A feature of a later release: capacity planning (the jobs left this list with 0.2.0).
    {
      id: "resources",
      path: "/resources",
      labelKey: "x",
      icon: HardDrive,
      group: "installation",
      soon: "0.5.0",
    },
  ];

  it("picks the entry whose search params the location carries, the more specific one first", () => {
    expect(findActiveNavItem(entries, "/settings", { section: "about" })?.id).toBe("license");
    expect(findActiveNavItem(entries, "/settings", { section: "mail" })?.id).toBe("settings");
    expect(findActiveNavItem(entries, "/settings")?.id).toBe("settings");
    expect(findActiveNavItem(entries, "/jobs", { type: "mail" })?.id).toBe("mail-jobs");
    expect(findActiveNavItem(entries, "/jobs", { type: "endpoint" })?.id).toBe("endpoint-jobs");
    expect(findActiveNavItem(entries, "/jobs")).toBeNull();
  });

  it("covers the extra paths of an entry and the pages below them", () => {
    expect(findActiveNavItem(entries, "/schedules")?.id).toBe("setup");
    expect(findActiveNavItem(entries, "/imports/42")?.id).toBe("setup");
    expect(findActiveNavItem(entries, "/protected-objects")?.id).toBe("setup");
    expect(matchedNavPath(entries[5] as NavItem, "/imports/42")).toBe("/imports");
    expect(matchedNavPath(entries[5] as NavItem, "/sources/import")).toBe("/sources/import");
    expect(findActiveNavItem(entries, "/sources")).toBeNull();
  });

  it("leaves a page below an extra path for that path after a tenant switch", () => {
    expect(pathAfterTenantSwitch("/imports/42", entries)).toBe("/imports");
    expect(pathAfterTenantSwitch("/schedules", entries)).toBeNull();
  });

  it("hides an entry the installation does not offer, and keeps one it does", () => {
    const offered: NavItem[] = [
      {
        id: "setup",
        path: "/protected-objects",
        labelKey: "x",
        icon: Building2,
        group: "tenants",
        visible: (context) => !(context.features ?? []).includes("tenants.additional"),
      },
      { id: "tenants", path: "/tenants", labelKey: "x", icon: Building2, group: "tenants" },
    ];
    const one = groupNavItems(offered, null, allow, NO_LOCKS);
    expect(one.flatMap((group) => group.items.map((item) => item.id))).toEqual([
      "setup",
      "tenants",
    ]);
    const many = groupNavItems(offered, null, allow, {
      features: ["tenants.additional"],
      extensions: {},
    });
    expect(many.flatMap((group) => group.items.map((item) => item.id))).toEqual(["tenants"]);
    expect(isNavItemOffered(offered[0] as NavItem, NO_LOCKS)).toBe(true);
    expect(
      visibleNavItems(offered, null, allow, { features: ["tenants.additional"], extensions: {} })
        .length,
    ).toBe(1);
  });

  it("keeps an upcoming entry in its group, marked soon and never locked", () => {
    const groups = groupNavItems(entries, null, allow, NO_LOCKS);
    const soon = groups.flatMap((group) => group.items).filter((item) => item.soon);
    expect(soon.map((item) => [item.id, item.soon, item.locked])).toEqual([
      ["resources", "0.5.0", false],
    ]);
  });
});
