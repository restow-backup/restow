import { describe, expect, it } from "vitest";

import { navItems as dashboardNavItems } from "@/features/dashboard";
import { featureNavItems } from "@/features/registry";
import { i18n } from "@/i18n";
import { type NavLockContext, groupNavItems } from "@/lib/navigation";
import { canAccess } from "@/lib/session";

/**
 * The final menu of 0.1.0 (maintainer decision 2026-10-01, plan step 2) as
 * the sidebar builds it from the real registry, per edition and role:
 * Daily, Mail & SaaS, Servers & endpoints, Tenants, Admin. Upcoming entries
 * show "(soon <release>)", entries an edition lock holds closed "(locked)"
 * (decision D1 is open: they stay visible, greyed out).
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

const DAILY = ["dashboard", "history", "verify", "alerts"];
const MAIL = ["mail-jobs (soon 0.2.0)", "restore", "archive", "exports"];
const ENDPOINTS = ["endpoint-jobs (soon 0.2.0)", "inventory", "file-restore"];

describe("the menu per edition", () => {
  it("Community, provider admin: Setup, and the licensed entries greyed out", () => {
    expect(menu("provider_admin", COMMUNITY)).toEqual({
      daily: DAILY,
      mail: MAIL,
      endpoints: ENDPOINTS,
      tenants: ["tenants (locked)", "tenant-setup"],
      admin: [
        "repositories",
        "audit (locked)",
        "integrations",
        "license",
        "team (locked)",
        "settings",
        "resources (soon 0.2.1)",
      ],
    });
  });

  it("Business, provider admin: audit log and team open, tenants still locked", () => {
    expect(menu("provider_admin", BUSINESS)).toEqual({
      daily: DAILY,
      mail: MAIL,
      endpoints: ENDPOINTS,
      tenants: ["tenants (locked)", "tenant-setup"],
      admin: [
        "repositories",
        "audit",
        "integrations",
        "license",
        "team",
        "settings",
        "resources (soon 0.2.1)",
      ],
    });
  });

  it("Service Provider, provider admin: All tenants instead of Setup, never a tenant itself", () => {
    expect(menu("provider_admin", SERVICE_PROVIDER)).toEqual({
      daily: DAILY,
      mail: MAIL,
      endpoints: ENDPOINTS,
      tenants: ["tenants"],
      admin: [
        "repositories",
        "audit",
        "integrations",
        "license",
        "team",
        "settings",
        "resources (soon 0.2.1)",
      ],
    });
  });

  it("tenant admin: their own tenant's work and members, no installation entries", () => {
    expect(menu("tenant_admin", SERVICE_PROVIDER)).toEqual({
      daily: DAILY,
      mail: MAIL,
      endpoints: ENDPOINTS,
      admin: ["repositories", "audit", "integrations", "tenant-members"],
    });
    expect(menu("tenant_admin", COMMUNITY).tenants).toEqual(["tenant-setup"]);
  });

  it("end user: the overview, restore and exports only", () => {
    expect(menu("tenant_user", COMMUNITY)).toEqual({
      daily: ["dashboard"],
      mail: ["restore", "exports"],
    });
  });

  it("puts each upcoming entry at the address its feature will have", () => {
    const soon = items.filter((item) => item.soon);
    expect(soon.map((item) => [item.id, item.path, item.search ?? null, item.soon])).toEqual([
      ["mail-jobs", "/jobs", { type: "mail" }, "0.2.0"],
      ["endpoint-jobs", "/jobs", { type: "endpoint" }, "0.2.0"],
      ["resources", "/resources", null, "0.2.1"],
    ]);
  });

  it("gives every meaning its own icon (icon table): only entries that mean the same share one", () => {
    const byIcon = new Map<unknown, string[]>();
    for (const item of items) {
      byIcon.set(item.icon, [...(byIcon.get(item.icon) ?? []), item.id]);
    }
    const shared = [...byIcon.values()].filter((ids) => ids.length > 1);
    // Jobs in both sections; a tenant (list and setup); people (Members, Team).
    expect(shared).toEqual([
      ["mail-jobs", "endpoint-jobs"],
      ["tenants", "tenant-setup"],
      ["tenant-members", "team"],
    ]);
  });

  it("labels the sections and the renamed entries in both languages", async () => {
    await i18n.changeLanguage("de");
    expect(
      ["daily", "mail", "endpoints", "tenants", "admin"].map((id) => i18n.t(`nav.groups.${id}`)),
    ).toEqual(["Täglich", "Mail & SaaS", "Server & Endpunkte", "Mandanten", "Verwaltung"]);
    expect(
      [
        "backup:nav.history",
        "verify:nav",
        "reports:nav",
        "restore:nav.explorer",
        "tenants:nav.tenants",
        "nav.items.setup",
        "storage:nav",
        "license:nav",
        "nav.items.resources",
      ].map((key) => i18n.t(key)),
    ).toEqual([
      "Verlauf",
      "Wiederherstellbarkeit",
      "Alarme",
      "Restore-Explorer",
      "Alle Mandanten",
      "Einrichtung",
      "Repositories",
      "Lizenz",
      "Auslastung",
    ]);
    await i18n.changeLanguage("en");
    expect(
      ["daily", "mail", "endpoints", "tenants", "admin"].map((id) => i18n.t(`nav.groups.${id}`)),
    ).toEqual(["Daily", "Mail & SaaS", "Servers & endpoints", "Tenants", "Admin"]);
    expect(
      [
        "backup:nav.history",
        "reports:nav",
        "tenants:nav.tenants",
        "storage:nav",
        "license:nav",
      ].map((key) => i18n.t(key)),
    ).toEqual(["History", "Alerts", "All tenants", "Repositories", "License"]);
  });
});
