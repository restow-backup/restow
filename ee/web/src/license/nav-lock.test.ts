import { Building2, HardDrive } from "lucide-react";
import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { type NavItem, type NavLockContext, groupNavItems } from "@/lib/navigation";

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

  it("leads to Settings, About, naming the edition, with a hint in both languages", () => {
    const lock = editionLock("service_provider");
    expect(lock.to).toBe("/settings");
    expect(lock.search).toEqual({ section: "about", requires: "service_provider" });
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
    expect(ids).toEqual(["audit", "team"]);
    for (const item of eeWebExtension.navItems ?? []) {
      expect(item.lock?.isLocked(context("business")) ?? false).toBe(false);
    }
    const license = eeWebExtension.navItems?.find((item) => item.id === "license");
    expect(license).toMatchObject({
      path: "/settings",
      search: { section: "about" },
      labelKey: "license:nav",
      roles: ["provider_admin"],
      group: "admin",
    });
    expect(license?.lock).toBeUndefined();
  });
});
