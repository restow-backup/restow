import { Building2, HardDrive } from "lucide-react";
import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { type NavItem, type NavLockContext, groupNavItems } from "@/lib/navigation";
import { canAccess } from "@/lib/session";

import { eeWebExtension } from "../index";
import "./i18n";
import { editionLock } from "./nav-lock";

const allow = () => true;

function context(edition: unknown): NavLockContext {
  return edition === null
    ? { features: null, extensions: null }
    : { features: [], extensions: { edition } };
}

describe("editionLock", () => {
  it("locks below the minimum edition and opens at or above it", () => {
    const business = editionLock("business");
    expect(business.isLocked(context("community"))).toBe(true);
    expect(business.isLocked(context("business"))).toBe(false);
    expect(business.isLocked(context("service_provider"))).toBe(false);

    const provider = editionLock("service_provider");
    expect(provider.isLocked(context("business"))).toBe(true);
    expect(provider.isLocked(context("service_provider"))).toBe(false);
  });

  it("stays locked while the edition is unknown, so nothing appears that might vanish", () => {
    expect(editionLock("business").isLocked(context(null))).toBe(true);
    expect(editionLock("business").isLocked(context("enterprise"))).toBe(true);
    expect(editionLock("business").isLocked({ features: [], extensions: {} })).toBe(true);
  });

  it("leads to Installation, License, naming the edition, with a hint in both languages", () => {
    const lock = editionLock("service_provider");
    expect(lock.to).toBe("/installation/license");
    expect(lock.search).toEqual({ requires: "service_provider" });
    expect(lock.hintKey).toBe("license:locked.service_provider");
    expect(i18n.getFixedT("en")(lock.hintKey)).toBe("Available in Service Provider");
    expect(i18n.getFixedT("de")(lock.hintKey)).toBe("Verfügbar in Service Provider");
  });

  it("works through the core's generic grouping", () => {
    const items: NavItem[] = [
      { id: "backup", path: "/backup", labelKey: "x", icon: HardDrive },
      {
        id: "tenants",
        path: "/tenants",
        labelKey: "x",
        icon: Building2,
        lock: editionLock("service_provider"),
      },
    ];
    const locked = (edition: unknown) =>
      groupNavItems(items, "provider_admin", allow, context(edition))
        .flatMap((group) => group.items)
        .filter((item) => item.locked)
        .map((item) => item.id);
    expect(locked("business")).toEqual(["tenants"]);
    expect(locked("service_provider")).toEqual([]);
  });
});

describe("the ee extension's locks", () => {
  it("locks the core tenants entry for Service Provider", () => {
    const lock = eeWebExtension.navLocks?.tenants;
    expect(lock?.isLocked(context("business"))).toBe(true);
    expect(lock?.isLocked(context("service_provider"))).toBe(false);
  });

  it("locks its own Business entries, and never License, where every edition enters its key", () => {
    const ids = (eeWebExtension.navItems ?? [])
      .filter((item) => item.lock?.isLocked(context("community")))
      .map((item) => item.id);
    expect(ids).toEqual(["audit"]);
    for (const item of eeWebExtension.navItems ?? []) {
      expect(item.lock?.isLocked(context("business")) ?? false).toBe(false);
    }
    const license = eeWebExtension.navItems?.find((item) => item.id === "license");
    expect(license).toMatchObject({
      path: "/installation/license",
      labelKey: "license:nav",
      roles: ["provider_admin"],
      group: "installation",
    });
    expect(license?.lock).toBeUndefined();
  });

  it("places the ee entries in Installation, where the operator's level lives", () => {
    const placed = (eeWebExtension.navItems ?? []).map((item) => [item.id, item.group]);
    // Members (the provider team) is the core's since 0.3.0, in every edition.
    expect(placed).toEqual([
      ["audit", "installation"],
      ["license", "installation"],
    ]);
  });

  it("keeps the audit log menu entry for provider admins only; a tenant administrator's log is a section of their tenant's page", () => {
    const audit = (eeWebExtension.navItems ?? []).filter((item) => item.path === "/audit");
    expect(audit.map((item) => [item.id, item.roles])).toEqual([["audit", ["provider_admin"]]]);
    expect((eeWebExtension.tenantSections ?? []).map((section) => section.id)).toEqual(["audit"]);
  });

  it("leaves the edition entries locked for Community and open from Business, in the menu", () => {
    const items: NavItem[] = [
      ...(eeWebExtension.navItems ?? []),
      // A core entry the extension locks by id: all tenants (Service Provider).
      {
        id: "tenants",
        path: "/tenants",
        labelKey: "x",
        icon: Building2,
        group: "tenants",
        lock: eeWebExtension.navLocks?.tenants,
      },
    ];
    const lockedIn = (edition: string, role = "provider_admin") =>
      Object.fromEntries(
        groupNavItems(items, role, canAccess, {
          features: edition === "service_provider" ? ["tenants.additional"] : [],
          extensions: { edition },
        }).map((group) => [
          group.id,
          group.items.map((item) => `${item.id}${item.locked ? " (locked)" : ""}`),
        ]),
      );
    expect(lockedIn("community")).toEqual({
      tenants: ["tenants (locked)"],
      installation: ["audit (locked)", "license"],
    });
    expect(lockedIn("business")).toEqual({
      tenants: ["tenants (locked)"],
      installation: ["audit", "license"],
    });
    expect(lockedIn("service_provider")).toEqual({
      tenants: ["tenants"],
      installation: ["audit", "license"],
    });
  });

  it("puts nothing of the audit log into a tenant administrator's menu: it is a section of their tenant's page", () => {
    const items: NavItem[] = [
      ...(eeWebExtension.navItems ?? []),
      { id: "members", path: "/members", labelKey: "x", icon: Building2, group: "tenants" },
    ];
    for (const edition of ["community", "business"]) {
      const groups = groupNavItems(items, "tenant_admin", canAccess, {
        features: [],
        extensions: { edition },
      });
      expect(groups.flatMap((group) => group.items.map((item) => item.id))).toEqual(["members"]);
    }
  });
});
