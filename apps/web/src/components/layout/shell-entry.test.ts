import { HardDrive, ScrollText, Settings } from "lucide-react";
import { describe, expect, it } from "vitest";

import type { NavItem } from "@/lib/navigation";

import { resolveShellEntry } from "./shell-entry";

/**
 * Which menu entry a page belongs to. Two entries may open one page for
 * different roles (the audit log): the page belongs to the entry the role is
 * offered, which decides the level the header names.
 */

const items: NavItem[] = [
  {
    id: "audit",
    path: "/audit",
    labelKey: "audit:nav",
    icon: ScrollText,
    roles: ["provider_admin"],
    group: "installation",
  },
  {
    id: "tenant-audit",
    path: "/audit",
    labelKey: "audit:nav",
    icon: ScrollText,
    roles: ["tenant_admin"],
    group: "tenants",
  },
  {
    id: "settings",
    path: "/installation",
    labelKey: "installation:nav",
    icon: Settings,
    roles: ["provider_admin"],
    group: "installation",
  },
  {
    id: "license",
    path: "/installation/license",
    labelKey: "license:nav",
    icon: Settings,
    roles: ["provider_admin"],
    group: "installation",
  },
];

describe("resolveShellEntry with a role", () => {
  it("puts the audit log in Installation for a provider admin and in the tenant's section for a tenant admin", () => {
    expect(resolveShellEntry(items, "/audit", {}, undefined, "provider_admin")).toMatchObject({
      item: { id: "audit" },
      group: "installation",
    });
    expect(resolveShellEntry(items, "/audit", {}, undefined, "tenant_admin")).toMatchObject({
      item: { id: "tenant-audit" },
      group: "tenants",
    });
  });

  it("still resolves a page the role has no entry for, so the denied page keeps its place", () => {
    expect(resolveShellEntry(items, "/installation", {}, undefined, "tenant_user")).toMatchObject({
      item: { id: "settings" },
    });
  });

  it("without a role takes the first entry for the address, as before", () => {
    expect(resolveShellEntry(items, "/audit")).toMatchObject({ item: { id: "audit" } });
  });
});

describe("the installation page's entries", () => {
  it("highlights Settings on every section and the license entry on its own", () => {
    for (const section of [
      "server",
      "mail",
      "microsoft-app",
      "default-storage",
      "updates",
      "about",
    ]) {
      expect(
        resolveShellEntry(items, `/installation/${section}`, {}, undefined, "provider_admin"),
        section,
      ).toMatchObject({ item: { id: "settings" }, group: "installation" });
    }
    expect(
      resolveShellEntry(items, "/installation/license", {}, undefined, "provider_admin"),
    ).toMatchObject({ item: { id: "license" }, group: "installation" });
  });
});

describe("resolveShellEntry for the tenants", () => {
  const entries: NavItem[] = [
    {
      id: "tenant-settings",
      path: "/tenants/t1/overview",
      matches: ["/tenants/t1"],
      labelKey: "nav.items.tenantSettings",
      icon: Settings,
      roles: ["provider_admin", "tenant_admin"],
      group: "tenants",
    },
    {
      id: "tenants",
      path: "/tenants",
      labelKey: "tenants:nav.tenants",
      icon: Settings,
      roles: ["provider_admin"],
      group: "tenants",
    },
  ];

  it("puts the page of a tenant that is not the active one on the settings entry, never on the list", () => {
    // A tenant admin opens the address of another tenant: their level is their own tenant's settings.
    expect(
      resolveShellEntry(entries, "/tenants/other/overview", {}, undefined, "tenant_admin"),
    ).toMatchObject({ item: { id: "tenant-settings" }, group: "tenants" });
    // The active tenant's pages, and the other tenants' for a provider admin, belong to it as well.
    expect(
      resolveShellEntry(entries, "/tenants/t1/storage", {}, undefined, "provider_admin"),
    ).toMatchObject({ item: { id: "tenant-settings" } });
    expect(
      resolveShellEntry(entries, "/tenants/t2/storage", {}, undefined, "provider_admin"),
    ).toMatchObject({ item: { id: "tenant-settings" } });
  });

  it("puts the list itself on Manage tenants, even where the settings entry also leads to /tenants", () => {
    // Under All tenants there is no tenant to open: the settings entry leads to the list (lib/use-nav-items.ts).
    const underAllTenants = entries.map((entry) =>
      entry.id === "tenant-settings" ? { ...entry, path: "/tenants", matches: [] } : entry,
    );
    expect(
      resolveShellEntry(underAllTenants, "/tenants", {}, undefined, "provider_admin"),
    ).toMatchObject({ item: { id: "tenants" } });
    expect(
      resolveShellEntry(
        [...underAllTenants].reverse(),
        "/tenants",
        {},
        undefined,
        "provider_admin",
      ),
    ).toMatchObject({ item: { id: "tenants" } });
  });
});

describe("the tenant page's entries", () => {
  const tenantItems: NavItem[] = [
    {
      id: "organisation-settings",
      path: "/tenants/t1/overview",
      matches: ["/tenants/t1"],
      labelKey: "nav.items.organisationSettings",
      icon: Settings,
      roles: ["provider_admin", "tenant_admin"],
      group: "tenants",
    },
    {
      id: "repositories",
      path: "/tenants/t1/storage",
      labelKey: "storage:nav",
      icon: HardDrive,
      roles: ["provider_admin", "tenant_admin"],
      group: "tenants",
    },
  ];

  it("highlights Repositories on its section and the settings on every other section", () => {
    expect(
      resolveShellEntry(tenantItems, "/tenants/t1/storage", {}, undefined, "tenant_admin"),
    ).toMatchObject({ item: { id: "repositories" }, group: "tenants" });
    for (const section of ["overview", "connections", "members"]) {
      expect(
        resolveShellEntry(tenantItems, `/tenants/t1/${section}`, {}, undefined, "tenant_admin"),
        section,
      ).toMatchObject({ item: { id: "organisation-settings" } });
    }
  });

  it("leaves another tenant's repositories to the settings entry", () => {
    expect(
      resolveShellEntry(tenantItems, "/tenants/t2/storage", {}, undefined, "provider_admin"),
    ).toMatchObject({ item: { id: "organisation-settings" } });
  });
});
