// @vitest-environment happy-dom
import { Info } from "lucide-react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type Mounted,
  click,
  enableActEnvironment,
  flush,
  sessionAs,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { resetWebExtensionsForTesting } from "@/lib/extensions";
import type { TenantSectionSpec } from "@/lib/extensions";

import { openTenantPage, tenantOf } from "./testing";

/**
 * The tenant page in a DOM: who opens which tenant's page, that opening it
 * makes the tenant the active one, the sub-navigation with the locked section
 * of an extension, the controls closed for a provider role that may only look,
 * and the wording of an installation with one organisation.
 */

// The sections behind the page are other features with their own tests: fakes here.
vi.mock("./sections", async () => {
  const [{ Info: Icon }] = await Promise.all([import("lucide-react")]);
  const fake = (
    id: string,
    order: number,
    extra: Partial<TenantSectionSpec> = {},
  ): TenantSectionSpec => ({
    id,
    labelKey: `tenantpage:sections.${id === "master-data" ? "masterData" : id}`,
    descriptionKey: `tenantpage:descriptions.${id === "master-data" ? "masterData" : id}`,
    icon: Icon,
    order,
    component: ({ tenant, readOnly, sub }) => (
      <div
        data-slot="fake-section"
        data-id={id}
        data-read-only={String(readOnly)}
        data-sub={sub ?? ""}
      >
        <button type="button">act in {tenant.name}</button>
      </div>
    ),
    ...extra,
  });
  return {
    tenantSections: () => [
      fake("overview", 10),
      fake("connections", 20),
      fake("agents", 70),
      fake("members", 110),
      fake("audit", 120, {
        labelKey: "audit:nav",
        lock: {
          isLocked: () => true,
          to: "/installation/license",
          search: { requires: "business" },
          hintKey: "license:locked.business",
        },
      }),
      fake("master-data", 130),
    ],
    CORE_TENANT_SECTIONS: [],
  };
});

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  resetWebExtensionsForTesting();
  document.body.innerHTML = "";
});

const MUELLER = tenantOf("mueller", { name: "Müller GmbH" });
const NORDLICHT = tenantOf("nordlicht", { name: "Nordlicht AG" });

function sessionOf(overrides: Parameters<typeof sessionAs>[0] = {}) {
  return sessionAs({
    // An installation that manages tenants, unless a test says otherwise.
    features: ["tenants.additional"],
    tenants: [MUELLER, NORDLICHT],
    activeTenant: MUELLER,
    ...overrides,
  });
}

async function open(path: string, overrides: Parameters<typeof sessionAs>[0] = {}, demo = false) {
  mounted = await openTenantPage(path, { session: sessionOf(overrides), demo });
  await flush();
  return mounted;
}

const section = () => document.querySelector<HTMLElement>('[data-slot="fake-section"]');
const closedPage = () => document.querySelector<HTMLElement>('[data-slot="tenant-page-closed"]');

describe("opening a tenant's page", () => {
  it("names the section as the title and lists every section in the sub-navigation, the current one marked", async () => {
    await open("/tenants/mueller/connections");
    expect(document.querySelector("h1")?.textContent).toBe("Connections");
    const nav = document.querySelector('nav[aria-label="Sections of this tenant"]');
    const links = [...(nav?.querySelectorAll("a") ?? [])];
    expect(
      links.map((link) => [
        link.querySelector("span.flex-1")?.textContent,
        link.getAttribute("href"),
      ]),
    ).toEqual([
      ["Overview", "/tenants/mueller/overview"],
      ["Connections", "/tenants/mueller/connections"],
      ["Agents", "/tenants/mueller/agents"],
      ["Users", "/tenants/mueller/members"],
      ["Audit log", "/installation/license?requires=business"],
      ["Master data", "/tenants/mueller/master-data"],
    ]);
    expect(links.filter((link) => link.getAttribute("aria-current") === "page")).toEqual([
      links[1],
    ]);
    expect(section()?.dataset.id).toBe("connections");
  });

  it("makes the tenant of the address the active one, and shows its section only then", async () => {
    const setActiveTenant = vi.fn();
    // The active tenant differs from the address: the page switches, and waits.
    await open("/tenants/nordlicht/agents", { setActiveTenant });
    expect(setActiveTenant).toHaveBeenCalledWith("nordlicht");
    expect(section()).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("shows the section of a tenant that already is the active one, without switching", async () => {
    const setActiveTenant = vi.fn();
    await open("/tenants/mueller/agents", { setActiveTenant });
    expect(setActiveTenant).not.toHaveBeenCalled();
    expect(section()?.textContent).toContain("act in Müller GmbH");
    expect(section()?.dataset.readOnly).toBe("false");
  });

  it("describes the section for the tenant, and for the one organisation without the word tenant", async () => {
    await open("/tenants/mueller/overview");
    expect(document.querySelector('[data-slot="page-header"]')?.textContent).toContain(
      "Müller GmbH at a glance",
    );
    await mounted?.unmount();
    mounted = null;
    await open("/tenants/mueller/overview", { features: [] });
    // No "tenants.additional" feature: the installation has one organisation.
    expect(document.body.textContent).not.toMatch(/\btenants?\b/i);
    expect(
      document.querySelector('nav[aria-label="Sections of your organisation"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-slot="page-header"]')?.textContent).toContain(
      "Your organisation at a glance",
    );
  });
});

describe("who is let in", () => {
  it("shows a tenant administrator another tenant's id as a clear 'not your tenant' state, not a crash", async () => {
    await open("/tenants/stranger/overview", {
      isProviderAdmin: false,
      providerRole: null,
      role: "tenant_admin",
    });
    expect(closedPage()?.dataset.state).toBe("notYours");
    expect(closedPage()?.textContent).toContain("This is not your tenant");
    // The way back to what is theirs.
    expect(closedPage()?.querySelector('a[href="/tenants/mueller/overview"]')).not.toBeNull();
    expect(section()).toBeNull();
  });

  it("says 'organisation' instead of 'tenant' in the one-organisation editions", async () => {
    await open("/tenants/stranger/overview", {
      isProviderAdmin: false,
      providerRole: null,
      role: "tenant_admin",
      features: [],
    });
    expect(closedPage()?.textContent).toContain("This is not your organisation");
    expect(closedPage()?.textContent).not.toMatch(/\btenants?\b/i);
  });

  it("tells a provider admin when the tenant does not exist", async () => {
    await open("/tenants/stranger/overview");
    expect(closedPage()?.dataset.state).toBe("unknown");
  });

  it("gives an end user no tenant page, also for their own tenant", async () => {
    await open("/tenants/mueller/overview", {
      isProviderAdmin: false,
      providerRole: null,
      role: "tenant_user",
      tenants: [tenantOf("mueller", { name: "Müller GmbH", role: "tenant_user" })],
      activeTenant: tenantOf("mueller", { name: "Müller GmbH", role: "tenant_user" }),
    });
    expect(closedPage()?.dataset.state).toBe("notAdmin");
    expect(closedPage()?.textContent).toContain("Only administrators open this page");
    expect(section()).toBeNull();
  });
});

describe("an extension's section", () => {
  it("stays in the list with a lock, and opened by its address says why and leads to the page that unlocks it", async () => {
    await open("/tenants/mueller/audit");
    const lockedLink = document.querySelector('nav a[data-locked="true"]');
    expect(lockedLink?.getAttribute("href")).toBe("/installation/license?requires=business");
    const card = document.querySelector('[data-slot="locked-section"]');
    expect(card?.textContent).toContain("is not unlocked");
    expect(card?.querySelector('a[href="/installation/license?requires=business"]')).not.toBeNull();
    expect(section()).toBeNull();
  });
});

describe("a provider role that may look but not change", () => {
  it("sees the controls of a section closed, with the role as the reason, instead of a 403", async () => {
    await open("/tenants/mueller/agents", { providerRole: "technician" });
    const note = document.querySelector('[data-slot="access-note"]');
    expect(note?.getAttribute("data-reason")).toBe("role");
    expect(note?.textContent).toContain("Administrator role or higher");
    expect(section()?.dataset.readOnly).toBe("true");
    expect(section()?.closest("fieldset")?.disabled).toBe(true);
    // The sub-navigation is made of links: looking around stays possible.
    expect(document.querySelector('nav a[href="/tenants/mueller/members"]')).not.toBeNull();
  });

  it("keeps the overview open: it reads, and its own actions are gated one by one", async () => {
    await open("/tenants/mueller/overview", { providerRole: "read_only" });
    expect(document.querySelector('[data-slot="access-note"]')).toBeNull();
    expect(section()?.closest("fieldset")?.disabled).toBe(false);
  });

  it("is not told anything when the role may change settings", async () => {
    await open("/tenants/mueller/agents", { providerRole: "administrator" });
    expect(document.querySelector('[data-slot="access-note"]')).toBeNull();
    expect(section()?.dataset.readOnly).toBe("false");
  });

  it("is closed in the public demo for the settings this release adds, before a click", async () => {
    await open("/tenants/mueller/agents", {}, true);
    expect(document.querySelector('[data-slot="access-note"]')?.getAttribute("data-reason")).toBe(
      "demo",
    );
    expect(section()?.closest("fieldset")?.disabled).toBe(true);
    await mounted?.unmount();
    mounted = null;
    // A page whose actions the demo guard already explains stays as it was.
    await open("/tenants/mueller/connections", {}, true);
    expect(document.querySelector('[data-slot="access-note"]')).toBeNull();
  });
});

describe("the select of the sections on a phone", () => {
  it("holds the same sections as the column", async () => {
    await open("/tenants/mueller/members");
    const select = document.querySelector<HTMLElement>("#tenant-section-select");
    expect(select).not.toBeNull();
    await click(select);
    await flush();
    const options = [...document.querySelectorAll('[role="option"]')].map((option) =>
      option.textContent?.trim(),
    );
    // The locked section adds its reason for screen readers after its name.
    expect(options.map((option) => option?.split(",")[0])).toEqual([
      "Overview",
      "Connections",
      "Agents",
      "Users",
      "Audit log",
      "Master data",
    ]);
  });
});
