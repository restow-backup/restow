import { Info } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";

import {
  type InstallationSectionSpec,
  registerWebExtension,
  resetWebExtensionsForTesting,
} from "@/lib/extensions";
import type { NavLock, NavLockContext } from "@/lib/navigation";

import { installationAccess } from "./access";
import {
  DEFAULT_SECTION_ID,
  INSTALLATION_PATH,
  installationSectionPath,
  installationSectionTo,
  installationTo,
} from "./paths";
import { hasSection, parseInstallationSearch, sectionStates, wordingScope } from "./presenters";
import { CORE_INSTALLATION_SECTIONS, installationSections } from "./sections";

afterEach(() => {
  resetWebExtensionsForTesting();
});

const context = (edition: string | null): NavLockContext =>
  edition === null
    ? { features: null, extensions: null }
    : { features: [], extensions: { edition } };

function extra(id: string, order: number, lock?: NavLock): InstallationSectionSpec {
  return { id, labelKey: `x:${id}`, icon: Info, order, component: () => null, lock };
}

const BUSINESS_ONLY: NavLock = {
  isLocked: (ctx) => ctx.extensions?.edition !== "business",
  to: "/installation/license",
  search: { requires: "business" },
  hintKey: "x:hint",
};

describe("the paths of the installation page", () => {
  it("lives at /installation with one address per section", () => {
    expect(INSTALLATION_PATH).toBe("/installation");
    expect(installationTo()).toBe("/installation");
    expect(installationSectionPath("mail")).toBe("/installation/mail");
    expect(installationSectionTo("microsoft-app")).toBe("/installation/microsoft-app");
    expect(DEFAULT_SECTION_ID).toBe("server");
  });
});

describe("the sections of the core", () => {
  it("are Server, Notification mail, Microsoft multi-tenant app, Default storage, Updates, About, in that order", () => {
    expect(CORE_INSTALLATION_SECTIONS.map((section) => section.id)).toEqual([
      "server",
      "mail",
      "microsoft-app",
      "default-storage",
      "updates",
      "about",
    ]);
    const orders = CORE_INSTALLATION_SECTIONS.map((section) => section.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("have a label and a description in the installation namespace, and an icon", () => {
    for (const section of CORE_INSTALLATION_SECTIONS) {
      expect(section.labelKey, section.id).toMatch(/^installation:sections\./);
      expect(section.descriptionKey, section.id).toMatch(/^installation:descriptions\./);
      expect(section.icon, section.id).toBeDefined();
    }
  });

  it("know nothing of a license, an edition or a lock: only an extension locks a section", () => {
    for (const section of CORE_INSTALLATION_SECTIONS) {
      expect(section.lock, section.id).toBeUndefined();
    }
  });
});

describe("installationSections", () => {
  it("is the core's own where no extension is registered, with Edition (the Community build)", () => {
    expect(installationSections().map((section) => section.id)).toEqual([
      ...CORE_INSTALLATION_SECTIONS.map((section) => section.id).filter((id) => id !== "about"),
      "edition",
      "about",
    ]);
  });

  it("places an extension's sections by their order between the core's", () => {
    registerWebExtension({
      name: "test",
      installationSections: [extra("journal", 40), extra("license", 80)],
    });
    expect(installationSections().map((section) => section.id)).toEqual([
      "server",
      "mail",
      "microsoft-app",
      "journal",
      "default-storage",
      "updates",
      "license",
      "about",
    ]);
  });

  it("never lets an extension replace a section of the core or another extension's", () => {
    registerWebExtension({
      name: "one",
      installationSections: [extra("journal", 40)],
    });
    registerWebExtension({
      name: "two",
      installationSections: [extra("server", 5), extra("journal", 41)],
    });
    const sections = installationSections();
    expect(sections.filter((section) => section.id === "server")).toHaveLength(1);
    expect(sections.find((section) => section.id === "server")?.order).toBe(10);
    expect(sections.find((section) => section.id === "journal")?.order).toBe(40);
  });

  it("reports whether a section exists", () => {
    registerWebExtension({ name: "test", installationSections: [extra("journal", 40)] });
    expect(hasSection(installationSections(), "journal")).toBe(true);
    expect(hasSection(installationSections(), "provider-api")).toBe(false);
  });
});

describe("sectionStates", () => {
  it("marks a section locked while its lock holds, in order, like a menu entry", () => {
    const specs = [extra("journal", 40, BUSINESS_ONLY), extra("a", 5)];
    expect(sectionStates(specs, context("community")).map((s) => [s.spec.id, s.locked])).toEqual([
      ["a", false],
      ["journal", true],
    ]);
    expect(sectionStates(specs, context("business")).map((s) => s.locked)).toEqual([false, false]);
  });

  it("keeps a locked section locked while the profile has not loaded", () => {
    const [state] = sectionStates([extra("journal", 40, BUSINESS_ONLY)], context(null));
    expect(state?.locked).toBe(true);
  });
});

describe("parseInstallationSearch", () => {
  it("keeps a plain lowercase token as the requires marker", () => {
    expect(parseInstallationSearch({ requires: "business" })).toEqual({ requires: "business" });
    expect(parseInstallationSearch({ requires: "reports.timed" })).toEqual({
      requires: "reports.timed",
    });
  });

  it("drops anything else, and every other parameter", () => {
    expect(parseInstallationSearch({ requires: "<script>" })).toEqual({});
    expect(parseInstallationSearch({ requires: "x".repeat(80) })).toEqual({});
    expect(parseInstallationSearch({ requires: 5 })).toEqual({});
    expect(parseInstallationSearch({ section: "mail" })).toEqual({});
    expect(parseInstallationSearch(null)).toEqual({});
  });
});

describe("wordingScope", () => {
  it("says tenants where the installation manages them and the organisation where it has one", () => {
    expect(wordingScope(true)).toBe("tenants");
    expect(wordingScope(false)).toBe("organisation");
  });
});

describe("installationAccess", () => {
  it("opens changing for the owner and testing for administrators and up", () => {
    expect(installationAccess({ demo: false, mayChange: true, mayOperate: true })).toEqual({
      change: null,
      operate: null,
    });
    expect(installationAccess({ demo: false, mayChange: false, mayOperate: true })).toEqual({
      change: "role",
      operate: null,
    });
    expect(installationAccess({ demo: false, mayChange: false, mayOperate: false })).toEqual({
      change: "role",
      operate: "role",
    });
  });

  it("closes everything in the public demo, whatever the role, and says it is the demo", () => {
    expect(installationAccess({ demo: true, mayChange: true, mayOperate: true })).toEqual({
      change: "demo",
      operate: "demo",
    });
  });
});
