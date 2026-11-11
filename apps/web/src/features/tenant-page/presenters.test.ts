import { Info } from "lucide-react";
import { describe, expect, it } from "vitest";

import type { TenantSectionSpec } from "@/lib/extensions";
import type { NavLock } from "@/lib/navigation";
import { TENANT_SECTION_IDS } from "@/lib/tenant-paths";

import { TENANT_SECTION_META, visibleSectionMeta } from "./meta";
import {
  isCoreSectionId,
  isSectionClosed,
  parseConnectionsSearch,
  tenantSectionStates,
} from "./presenters";
import { tenantSections } from "./sections";

const lock = (locked: boolean): NavLock => ({
  isLocked: () => locked,
  to: "/installation/license",
  hintKey: "x:hint",
});

function spec(id: string, order: number, withLock?: NavLock): TenantSectionSpec {
  return { id, labelKey: `x:${id}`, icon: Info, order, component: () => null, lock: withLock };
}

describe("the sections of the tenant page", () => {
  it("are the thirteen the core offers, in the order of the sub-navigation, the audit log's place left open", () => {
    expect(TENANT_SECTION_META.map((meta) => meta.id)).toEqual([...TENANT_SECTION_IDS]);
    expect(TENANT_SECTION_META.map((meta) => meta.id)).toEqual([
      "overview",
      "connections",
      "protection",
      "jobs",
      "retention",
      "storage",
      "agents",
      "archive",
      "notifications",
      "branding",
      "integrations",
      "members",
      "master-data",
    ]);
    const orders = TENANT_SECTION_META.map((meta) => meta.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    // Between Members and Master data: where an extension's audit log goes.
    const members = TENANT_SECTION_META.find((meta) => meta.id === "members")?.order ?? 0;
    const master = TENANT_SECTION_META.find((meta) => meta.id === "master-data")?.order ?? 0;
    expect(master - members).toBeGreaterThan(10);
    expect(isCoreSectionId("agents")).toBe(true);
    expect(isCoreSectionId("audit")).toBe(false);
  });

  it("sort by order and mark the sections a lock holds closed, as the menu does", () => {
    const states = tenantSectionStates(
      [spec("b", 20, lock(true)), spec("a", 10), spec("c", 30, lock(false))],
      { features: [], extensions: {} },
    );
    expect(states.map((state) => [state.spec.id, state.locked])).toEqual([
      ["a", false],
      ["b", true],
      ["c", false],
    ]);
  });
});

describe("the sections for provider administrators only (0.5.0)", () => {
  it("leave the tenant's own branding out for the tenant's administrators", () => {
    expect(visibleSectionMeta(true).map((meta) => meta.id)).toContain("branding");
    expect(visibleSectionMeta(false).map((meta) => meta.id)).not.toContain("branding");
    expect(visibleSectionMeta(false)).toHaveLength(TENANT_SECTION_META.length - 1);
    expect(tenantSections(false).map((section) => section.id)).not.toContain("branding");
    expect(tenantSections(true).map((section) => section.id)).toContain("branding");
    expect(tenantSections().find((section) => section.id === "branding")?.providerOnly).toBe(true);
  });
});

describe("the sections and the modules of the installation (0.5.0)", () => {
  it("name the modules they belong to: connections and protection the mail modules, agents the machines, the archive its own", () => {
    const modules = Object.fromEntries(
      TENANT_SECTION_META.filter((meta) => meta.modules).map((meta) => [meta.id, meta.modules]),
    );
    expect(modules).toEqual({
      connections: ["microsoft365", "imap", "archive"],
      protection: ["microsoft365", "imap"],
      agents: ["endpoints"],
      archive: ["archive"],
    });
    // The sections carry them into the page.
    expect(tenantSections().find((section) => section.id === "agents")?.modules).toEqual([
      "endpoints",
    ]);
  });

  it("leave the sections of a module that is off out of what the overview and the palette offer", () => {
    const ids = (modules: Parameters<typeof visibleSectionMeta>[1]) =>
      visibleSectionMeta(true, modules).map((meta) => meta.id);
    // Only Proxmox VE: nothing of mail, the archive or the agents.
    expect(ids(["pve"])).toEqual([
      "overview",
      "jobs",
      "retention",
      "storage",
      "notifications",
      "branding",
      "integrations",
      "members",
      "master-data",
    ]);
    // The archive alone keeps Connections (the mail file imports) and its own section.
    expect(ids(["archive"])).toContain("connections");
    expect(ids(["archive"])).toContain("archive");
    expect(ids(["archive"])).not.toContain("protection");
    expect(ids(["archive"])).not.toContain("agents");
    // Every module on, or none known: every section.
    expect(ids(["microsoft365", "imap", "archive", "endpoints", "pve"])).toHaveLength(
      TENANT_SECTION_META.length,
    );
    expect(ids(null)).toHaveLength(TENANT_SECTION_META.length);
    expect(ids(undefined)).toHaveLength(TENANT_SECTION_META.length);
  });

  it("mark a section hidden for the sub-navigation while its modules are off, and never without modules", () => {
    const specs = [
      { ...spec("agents", 10), modules: ["endpoints"] as const },
      { ...spec("connections", 20), modules: ["microsoft365", "imap"] as const },
      spec("members", 30),
    ];
    const hidden = (modules: readonly ("microsoft365" | "imap" | "endpoints" | "pve")[] | null) =>
      tenantSectionStates(specs, { features: [], extensions: {}, modules }).map((state) => [
        state.spec.id,
        state.hidden,
      ]);
    expect(hidden(["imap", "pve"])).toEqual([
      ["agents", true],
      ["connections", false],
      ["members", false],
    ]);
    expect(hidden(["pve"])).toEqual([
      ["agents", true],
      ["connections", true],
      ["members", false],
    ]);
    expect(hidden(null)).toEqual([
      ["agents", false],
      ["connections", false],
      ["members", false],
    ]);
  });
});

describe("the tabs of Connections", () => {
  it("open Microsoft 365 unless the address names another one", () => {
    expect(parseConnectionsSearch({})).toEqual({ tab: "microsoft365" });
    expect(parseConnectionsSearch({ tab: "imap" })).toEqual({ tab: "imap" });
    expect(parseConnectionsSearch({ tab: "google" })).toEqual({ tab: "google" });
    expect(parseConnectionsSearch({ tab: "imports" })).toEqual({ tab: "imports" });
    expect(parseConnectionsSearch({ tab: "nope" })).toEqual({ tab: "microsoft365" });
    expect(parseConnectionsSearch({ tab: ["imap"] })).toEqual({ tab: "microsoft365" });
  });
});

describe("which sections a viewer who may not change settings sees closed", () => {
  it("closes everything but the sections that only read, for a provider role that may only look", () => {
    for (const id of TENANT_SECTION_META.map((meta) => meta.id)) {
      expect(isSectionClosed(id, "role"), id).toBe(id !== "overview");
    }
    expect(isSectionClosed("audit", "role")).toBe(false);
  });

  it("closes only the settings this release adds in the public demo", () => {
    const closed = TENANT_SECTION_META.map((meta) => meta.id).filter((id) =>
      isSectionClosed(id, "demo"),
    );
    expect(closed).toEqual(["agents", "archive", "notifications", "branding", "master-data"]);
  });

  it("closes nothing for a viewer who may change settings", () => {
    for (const id of TENANT_SECTION_META.map((meta) => meta.id)) {
      expect(isSectionClosed(id, null)).toBe(false);
    }
  });
});
