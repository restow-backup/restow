import { describe, expect, it } from "vitest";

import { scopeKindOf } from "@/components/layout/breadcrumb-trail";
import { navItems as dashboardNavItems } from "@/features/dashboard";
import { featureNavItems } from "@/features/registry";
import { navItems as tenantNavItems } from "@/features/tenants";
import { i18n } from "@/i18n";
import {
  NAV_GROUPS,
  type NavLockContext,
  groupNavItems,
  navGroupLabelKey,
  navGroupOf,
} from "@/lib/navigation";
import { canAccess } from "@/lib/session";

/**
 * The menu of 0.2.0 (maintainer decisions 2026-10-01 and 2026-10-02, plan
 * step 2, phase 1c) as the sidebar builds it from the real registry, per
 * edition and role: Daily, Mail & SaaS (the archive among them), Servers &
 * endpoints, Tenants (Organisation where the installation has one
 * organisation), Installation.
 * Upcoming entries show "(soon <release>)", entries an edition lock holds
 * closed "(locked)" (decision D1: they stay visible, greyed out).
 *
 * The roles of the menu are the role in the active tenant: a provider admin
 * (whatever the team role: owner, administrator, technician or read only; the
 * pages gate what each may change, the menu has no entries per team role), a
 * tenant admin and an end user. Technician and read only are not roles of the
 * menu, so they see what every provider admin sees.
 */

const items = [...dashboardNavItems, ...featureNavItems];

function context(edition: string, features: string[] = []): NavLockContext {
  return { features: features as NavLockContext["features"], extensions: { edition } };
}

const COMMUNITY = context("community");
const BUSINESS = context("business", ["reports.timed"]);
const SERVICE_PROVIDER = context("service_provider", [
  "tenants.additional",
  "apiKeys.provider",
  "stats.allTenants",
  "dashboard.allTenants",
  "reports.timed",
  "providerTeam.tenantScope",
]);

function menu(role: string | null, ctx: NavLockContext): Record<string, string[]> {
  return Object.fromEntries(
    groupNavItems(items, role, canAccess, ctx).map((group) => [
      group.id,
      group.items.map(
        (item) =>
          `${item.id}${item.locked ? " (locked)" : ""}${item.soon ? ` (soon ${item.soon})` : ""}`,
      ),
    ]),
  );
}

// Warnings sit next to History (0.3.0), for those who may read them.
const DAILY = ["dashboard", "history", "warnings", "verify", "alerts"];
// The archive is part of Mail & SaaS (maintainer decision 2026-10-02): no section of its own.
const MAIL = ["mail-jobs", "restore", "archive", "exports"];
const ENDPOINTS = ["endpoint-jobs", "inventory", "virtualization", "file-shares", "file-restore"];

describe("the menu per edition", () => {
  it("Community, provider admin: the one organisation's settings, the members, the licensed entries greyed out", () => {
    expect(menu("provider_admin", COMMUNITY)).toEqual({
      daily: DAILY,
      mail: MAIL,
      endpoints: ENDPOINTS,
      // "Settings" of the one organisation instead of "Tenant settings"; the
      // list of all tenants stays as a greyed-out entry. Repositories have an entry
      // of their own that opens their section of the settings page (maintainer
      // decision 2026-10-10); integrations, members and the rest are sections only.
      tenants: ["organisation-settings", "repositories", "tenants (locked)"],
      // Members (the provider team, id `team`) is in every edition (0.3.0).
      installation: ["settings", "team", "audit (locked)", "license", "resources (soon 0.5.0)"],
    });
  });

  it("Business, provider admin: audit log open, all tenants still locked", () => {
    expect(menu("provider_admin", BUSINESS)).toEqual({
      daily: DAILY,
      mail: MAIL,
      endpoints: ENDPOINTS,
      tenants: ["organisation-settings", "repositories", "tenants (locked)"],
      installation: ["settings", "team", "audit", "license", "resources (soon 0.5.0)"],
    });
  });

  it("Service Provider, provider admin: tenant settings and all tenants, never a tenant itself", () => {
    expect(menu("provider_admin", SERVICE_PROVIDER)).toEqual({
      daily: DAILY,
      mail: MAIL,
      endpoints: ENDPOINTS,
      tenants: ["tenant-settings", "repositories", "tenants"],
      // The statistics of all tenants open the pinned Installation section (0.3.0).
      installation: [
        "stats-all-tenants",
        "settings",
        "team",
        "audit",
        "license",
        "resources (soon 0.5.0)",
      ],
    });
  });

  it("offers the statistics of all tenants only where they exist and the viewer sees every tenant", () => {
    const has = (role: string, ctx: NavLockContext) =>
      Object.values(menu(role, ctx)).flat().includes("stats-all-tenants");
    expect(has("provider_admin", SERVICE_PROVIDER)).toBe(true);
    expect(has("provider_admin", { ...SERVICE_PROVIDER, providerAllTenants: true })).toBe(true);
    // A member of the provider team limited to some tenants: the API refuses them the totals.
    expect(has("provider_admin", { ...SERVICE_PROVIDER, providerAllTenants: false })).toBe(false);
    // Community and Business have one organisation: its statistics are Overview › Statistics.
    expect(has("provider_admin", COMMUNITY)).toBe(false);
    expect(has("provider_admin", BUSINESS)).toBe(false);
    // While the profile loads nothing appears that might vanish.
    expect(has("provider_admin", { features: null, extensions: null })).toBe(false);
    for (const role of ["tenant_admin", "tenant_user"]) {
      expect(has(role, SERVICE_PROVIDER), role).toBe(false);
    }
    const entry = items.find((item) => item.id === "stats-all-tenants");
    expect(entry).toMatchObject({ path: "/statistics/all", group: "installation" });
  });

  it("tenant admin in a Service Provider installation: the settings and the repositories of their tenant, nothing else of the tenant level", () => {
    // The old gap: no entry of their own for the tenant's settings here. Their members, audit
    // log and the rest are sections of that page; the repositories have a shortcut of their own.
    expect(menu("tenant_admin", SERVICE_PROVIDER)).toEqual({
      daily: DAILY,
      mail: MAIL,
      endpoints: ENDPOINTS,
      tenants: ["tenant-settings", "repositories"],
    });
  });

  it("offers the warnings next to History to those who may read them, with the open ones counted", () => {
    const entry = items.find((item) => item.id === "warnings");
    expect(entry).toMatchObject({
      path: "/warnings",
      group: "daily",
      labelKey: "warnings:nav",
      roles: ["provider_admin", "tenant_admin"],
    });
    expect(typeof entry?.useBadge).toBe("function");
    for (const ctx of [COMMUNITY, BUSINESS, SERVICE_PROVIDER]) {
      expect(menu("tenant_admin", ctx).daily).toEqual(DAILY);
      expect(menu("provider_admin", ctx).daily).toEqual(DAILY);
      // An end user reads no warnings (the API refuses them).
      expect(menu("tenant_user", ctx).daily).not.toContain("warnings");
    }
  });

  it("tenant admin in Community and Business: the organisation's settings", () => {
    expect(menu("tenant_admin", COMMUNITY).tenants).toEqual([
      "organisation-settings",
      "repositories",
    ]);
    expect(menu("tenant_admin", BUSINESS).tenants).toEqual([
      "organisation-settings",
      "repositories",
    ]);
  });

  it("shows the Installation section to provider admins only", () => {
    for (const ctx of [COMMUNITY, BUSINESS, SERVICE_PROVIDER]) {
      expect(menu("provider_admin", ctx).installation).toBeDefined();
      expect(menu("tenant_admin", ctx).installation).toBeUndefined();
      expect(menu("tenant_user", ctx).installation).toBeUndefined();
    }
  });

  it("keeps one audit log entry, the provider admins'; a tenant administrator's is a section of their tenant's page", () => {
    const audit = items.filter((item) => item.path === "/audit");
    expect(audit.map((item) => [item.id, item.group, item.roles])).toEqual([
      ["audit", "installation", ["provider_admin"]],
    ]);
    for (const [role, ctx] of [
      ["provider_admin", SERVICE_PROVIDER],
      ["tenant_admin", SERVICE_PROVIDER],
    ] as const) {
      const entries = Object.values(menu(role, ctx))
        .flat()
        .filter((id) => id.startsWith("audit") || id.startsWith("tenant-audit"));
      expect(entries, role).toHaveLength(role === "provider_admin" ? 1 : 0);
    }
  });

  it("names the Installation level in the header on every entry of that section, and the tenant level on the tenant settings", () => {
    const level = (id: string, tenantKind: "customer" | "internal" | null = "customer") => {
      const entry = items.find((item) => item.id === id);
      return scopeKindOf({
        groupId: entry ? navGroupOf(entry) : null,
        entryId: id,
        tenantKind,
        organisationMode: false,
      });
    };
    for (const id of ["stats-all-tenants", "settings", "team", "audit", "license", "resources"]) {
      expect(level(id), id).toBe("installation");
    }
    expect(level("tenant-settings")).toBe("tenant");
    expect(level("tenant-settings", "internal")).toBe("internal");
  });

  it("opens the installation page at its first section, and the license at its own", () => {
    const settings = items.find((item) => item.id === "settings");
    expect(settings).toMatchObject({ path: "/installation", group: "installation" });
    const license = items.find((item) => item.id === "license");
    expect(license).toMatchObject({ path: "/installation/license", group: "installation" });
  });

  it("end user: the overview, restore and exports only, in every edition", () => {
    for (const ctx of [COMMUNITY, BUSINESS, SERVICE_PROVIDER]) {
      expect(menu("tenant_user", ctx)).toEqual({
        daily: ["dashboard"],
        mail: ["restore", "exports"],
      });
    }
  });

  it("offers exactly one of tenant settings and organisation settings, never both", () => {
    for (const [ctx, expected] of [
      [COMMUNITY, "organisation-settings"],
      [BUSINESS, "organisation-settings"],
      [SERVICE_PROVIDER, "tenant-settings"],
    ] as const) {
      for (const role of ["provider_admin", "tenant_admin"]) {
        const ids = (menu(role, ctx).tenants ?? []).filter(
          (id) => id === "tenant-settings" || id === "organisation-settings",
        );
        expect(ids, `${role} in ${expected}`).toEqual([expected]);
      }
    }
  });

  it("has no menu entry for the pages that are sections of the tenant page, the repositories aside", () => {
    const ids = items.map((item) => item.id);
    for (const gone of [
      "integrations",
      "tenant-members",
      "tenant-audit",
      "protection",
      "sources",
      "schedules",
      "retention",
      "imports",
    ]) {
      expect(ids, gone).not.toContain(gone);
    }
    for (const ctx of [COMMUNITY, BUSINESS, SERVICE_PROVIDER]) {
      const installation = menu("provider_admin", ctx).installation ?? [];
      for (const id of ["repositories", "integrations", "tenant-members"]) {
        expect(installation.join(" ")).not.toContain(id);
      }
    }
  });

  it("lets the settings entries open the tenant page of the active tenant, on every section of it", () => {
    for (const id of ["tenant-settings", "organisation-settings"]) {
      const entry = items.find((item) => item.id === id);
      expect(entry, id).toMatchObject({
        path: "/tenants/$activeTenant/overview",
        group: "tenants",
        roles: ["provider_admin", "tenant_admin"],
      });
      expect(entry?.matches).toEqual(["/tenants/$activeTenant"]);
    }
  });

  it("opens the repositories section of the active tenant's page from its own entry, for those who administer the tenant", () => {
    const entry = items.find((item) => item.id === "repositories");
    expect(entry).toMatchObject({
      path: "/tenants/$activeTenant/storage",
      group: "tenants",
      labelKey: "storage:nav",
      roles: ["provider_admin", "tenant_admin"],
    });
    for (const ctx of [COMMUNITY, BUSINESS, SERVICE_PROVIDER]) {
      expect(Object.values(menu("tenant_user", ctx)).flat()).not.toContain("repositories");
    }
  });

  it("keeps the archive in Mail & SaaS, between the restore explorer and the exports", () => {
    expect(menu("tenant_admin", COMMUNITY).mail).toEqual([
      "mail-jobs",
      "restore",
      "archive",
      "exports",
    ]);
    // Tenant admins and provider admins only; an end user has no archive entry.
    expect(menu("tenant_user", COMMUNITY).mail).toEqual(["restore", "exports"]);
    const archive = items.find((item) => item.id === "archive");
    expect(archive?.group).toBe("mail");
    expect(navGroupOf({ id: "archive", group: archive?.group })).toBe("mail");
  });

  it("puts each upcoming entry at the address its feature will have", () => {
    const soon = items.filter((item) => item.soon);
    // The job definitions shipped with 0.2.0: Jobs carry no "Soon" badge any more.
    expect(soon.map((item) => [item.id, item.path, item.search ?? null, item.soon])).toEqual([
      ["resources", "/resources", null, "0.5.0"],
    ]);
  });

  it("opens the jobs of each kind from the entry of its section, in the order the plan has them", () => {
    const jobs = items.filter((item) => item.id === "mail-jobs" || item.id === "endpoint-jobs");
    expect(
      jobs.map((item) => [
        item.id,
        item.path,
        item.search,
        item.group,
        item.order,
        item.roles,
        item.soon,
      ]),
    ).toEqual([
      [
        "mail-jobs",
        "/jobs",
        { type: "mail" },
        "mail",
        10,
        ["provider_admin", "tenant_admin"],
        undefined,
      ],
      [
        "endpoint-jobs",
        "/jobs",
        { type: "endpoint" },
        "endpoints",
        10,
        ["provider_admin", "tenant_admin"],
        undefined,
      ],
    ]);
  });

  it("gives every meaning its own icon (icon table): only entries that mean the same share one", () => {
    const byIcon = new Map<unknown, string[]>();
    for (const item of items) {
      byIcon.set(item.icon, [...(byIcon.get(item.icon) ?? []), item.id]);
    }
    const shared = [...byIcon.values()].filter((ids) => ids.length > 1);
    // Jobs in both sections; settings (installation, and the tenant's or the organisation's).
    expect(shared).toEqual([
      ["mail-jobs", "endpoint-jobs"],
      ["tenant-settings", "organisation-settings"],
    ]);
  });

  it("labels the sections and the entries in both languages", async () => {
    const groups = ["daily", "mail", "endpoints", "tenants", "installation"];
    await i18n.changeLanguage("de");
    expect(groups.map((id) => i18n.t(`nav.groups.${id}`))).toEqual([
      "Täglich",
      "Mail & SaaS",
      "Server & Clients",
      "Mandanten",
      "Installation",
    ]);
    expect(i18n.t("nav.groups.organisation")).toBe("Organisation");
    expect(
      [
        "backup:nav.history",
        "verify:nav",
        "reports:nav",
        "restore:nav.explorer",
        "tenants:nav.tenants",
        "nav.items.tenantSettings",
        "nav.items.organisationSettings",
        "installation:nav",
        "team:nav",
        "storage:nav",
        "license:nav",
        "nav.items.resources",
        "stats:navAllTenants",
      ].map((key) => i18n.t(key)),
    ).toEqual([
      "Verlauf",
      "Wiederherstellbarkeit",
      "Alarme",
      "Restore-Explorer",
      "Mandanten verwalten",
      "Mandanten-Einstellungen",
      "Ihre Organisation",
      "Server & Betrieb",
      "Mitglieder",
      "Repositories",
      "Lizenz",
      "Kapazitätsplanung",
      "Statistik aller Mandanten",
    ]);
    await i18n.changeLanguage("en");
    expect(groups.map((id) => i18n.t(`nav.groups.${id}`))).toEqual([
      "Daily",
      "Mail & SaaS",
      "Servers & clients",
      "Tenants",
      "Installation",
    ]);
    expect(i18n.t("nav.groups.organisation")).toBe("Organisation");
    expect(
      [
        "backup:nav.history",
        "reports:nav",
        "tenants:nav.tenants",
        "nav.items.tenantSettings",
        "nav.items.organisationSettings",
        "team:nav",
        "storage:nav",
        "license:nav",
        "nav.items.resources",
        "stats:navAllTenants",
      ].map((key) => i18n.t(key)),
    ).toEqual([
      "History",
      "Alerts",
      "Manage tenants",
      "Tenant settings",
      "Your organisation",
      "Members",
      "Repositories",
      "License",
      "Capacity planning",
      "Statistics of all tenants",
    ]);
  });

  it("locks Manage tenants on the Community build itself, leading to Installation › Edition", () => {
    const lock = tenantNavItems.find((item) => item.id === "tenants")?.lock;
    expect(lock?.to).toBe("/installation/edition");
    expect(lock?.isLocked({ features: [], extensions: null })).toBe(true);
    // While the profile loads it reports locked, so nothing appears that might then vanish.
    expect(lock?.isLocked({ features: null, extensions: null })).toBe(true);
    expect(lock?.isLocked({ features: ["tenants.additional"], extensions: null })).toBe(false);
    expect(i18n.t(lock?.hintKey ?? "")).toContain("Service Provider");
  });

  it("lets the full build's lock replace the core's: it leads to the license instead", () => {
    // The registry here carries the full build (features/ee.ts).
    const placed = featureNavItems.find((item) => item.id === "tenants");
    expect(placed?.lock?.to).toBe("/installation/license");
  });

  it("never gives two settings pages or two member lists the same name", async () => {
    for (const language of ["de", "en"]) {
      await i18n.changeLanguage(language);
      const settingsPages = [i18n.t("nav.items.organisationSettings"), i18n.t("installation:nav")];
      expect(new Set(settingsPages).size, language).toBe(2);
      // The members of the installation and the users of a tenant.
      expect(i18n.t("team:nav"), language).not.toBe(i18n.t("tenantpage:sections.members"));
    }
    await i18n.changeLanguage("en");
  });

  it("names the tenants section Organisation where the installation has one organisation", () => {
    expect(navGroupLabelKey("tenants", COMMUNITY)).toBe("nav.groups.organisation");
    expect(navGroupLabelKey("tenants", BUSINESS)).toBe("nav.groups.organisation");
    expect(navGroupLabelKey("tenants", SERVICE_PROVIDER)).toBe("nav.groups.tenants");
    // Every other section keeps its name in every edition.
    expect(navGroupLabelKey("installation", COMMUNITY)).toBe("nav.groups.installation");
  });

  it("has exactly these sections, in this order: no Archive section, no leftover Admin", () => {
    expect([...NAV_GROUPS]).toEqual([
      "daily",
      "mail",
      "endpoints",
      "tenants",
      "installation",
      "other",
    ]);
    const groupsInUse = new Set(items.map((item) => item.group ?? "other"));
    expect([...groupsInUse].sort()).toEqual(
      ["daily", "endpoints", "installation", "mail", "tenants"].sort(),
    );
  });
});
