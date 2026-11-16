// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  click,
  enableActEnvironment,
  flush,
  json,
  type Mounted,
  newQueryClient,
  routedFetch,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/api";
import { resetWebExtensionsForTesting } from "@/lib/extensions";
import type { ModuleId } from "@/lib/modules";
import type { ModulesView } from "./sections/modules-api";
import { openInstallation, providerSession, SETTINGS, TENANT_FEATURES } from "./testing";

/**
 * Installation > Modules in a DOM (0.5.0): a switch per module of the installation; switching
 * one sends the modules that stay on and refreshes the profile the menu reads; one module always
 * stays on; a module that is off and still holds data says what, with counts, and leads to its
 * page; a role below administrator looks and changes nothing. And the page's own sub-navigation
 * leaves out the section of a module that is off, which still opens by its address.
 */

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    passkey: { listUserPasskeys: async () => ({ data: [], error: null }) },
    signIn: { passkey: async () => ({ error: null }) },
  },
  browserSupportsPasskeys: () => false,
  needsSecondFactor: () => false,
}));

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  resetWebExtensionsForTesting();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const ALL_ON: ModulesView = {
  modules: [
    { id: "microsoft365", enabled: true, data: [{ kind: "connections", count: 3 }] },
    { id: "imap", enabled: true, data: [] },
    { id: "archive", enabled: true, data: [] },
    { id: "endpoints", enabled: true, data: [{ kind: "machines", count: 12 }] },
    { id: "pve", enabled: true, data: [] },
  ],
};

/** Proxmox VE and the archive are off; Proxmox VE still holds guests and jobs, the archive nothing. */
const SOME_OFF: ModulesView = {
  modules: [
    { id: "microsoft365", enabled: true, data: [{ kind: "connections", count: 3 }] },
    {
      id: "imap",
      enabled: false,
      data: [
        { kind: "connections", count: 1 },
        { kind: "objects", count: 14 },
      ],
    },
    { id: "archive", enabled: false, data: [] },
    { id: "endpoints", enabled: true, data: [{ kind: "machines", count: 12 }] },
    {
      id: "pve",
      enabled: false,
      data: [
        { kind: "nodes", count: 2 },
        { kind: "guests", count: 31 },
        { kind: "jobs", count: 4 },
      ],
    },
  ],
};

function withEnabled(view: ModulesView, enabled: readonly ModuleId[]): ModulesView {
  return {
    modules: view.modules.map((module) => ({ ...module, enabled: enabled.includes(module.id) })),
  };
}

function text(scope: ParentNode | null | undefined = document.body): string {
  return (scope?.textContent ?? "").replace(/\s+/g, " ").trim();
}

const row = (id: ModuleId) => document.querySelector<HTMLElement>(`[data-module="${id}"]`);
const toggle = (id: ModuleId) => row(id)?.querySelector<HTMLButtonElement>('[role="switch"]');
const hiddenLine = (id: ModuleId) =>
  row(id)?.querySelector<HTMLElement>('[data-slot="module-hidden"]');
const subNavEntry = (section: string) =>
  document.querySelector<HTMLAnchorElement>(`nav a[href="/installation/${section}"]`);

describe("Installation > Modules", () => {
  it("lists every module with its switch, and nothing about hidden data while all are on", async () => {
    const routes = routedFetch({
      "GET /settings": () => json(SETTINGS),
      "GET /settings/modules": () => json(ALL_ON),
    });
    vi.stubGlobal("fetch", routes.mock);
    mounted = await openInstallation("/installation/modules", {
      session: providerSession("owner"),
    });
    await flush(8);

    // The section has its place in the page's sub-navigation.
    expect(subNavEntry("modules")?.textContent).toContain("Modules");
    for (const id of ["microsoft365", "imap", "archive", "endpoints", "pve"] as const) {
      expect(toggle(id)?.getAttribute("aria-checked")).toBe("true");
      expect(toggle(id)?.disabled).toBe(false);
    }
    expect(text(row("microsoft365"))).toContain("Microsoft 365");
    expect(text(row("endpoints"))).toContain(
      "Servers and workstations with the backup agent, and file shares.",
    );
    expect(text(row("pve"))).toContain("VMs and containers of your Proxmox VE nodes.");
    expect(document.querySelectorAll('[data-slot="module-hidden"]')).toHaveLength(0);
    // What switching off means is said before anybody does it.
    expect(text()).toContain("Nothing is deleted and no job stops");
    expect(document.querySelector('[data-slot="access-note"]')).toBeNull();
  });

  it("says what a module that is off still holds, with counts, and leads to its page", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /settings": () => json(SETTINGS),
        "GET /settings/modules": () => json(SOME_OFF),
      }).mock,
    );
    mounted = await openInstallation("/installation/modules", {
      session: providerSession("owner", { modules: ["microsoft365", "endpoints"] }),
    });
    await flush(8);

    expect(toggle("pve")?.getAttribute("aria-checked")).toBe("false");
    const pve = hiddenLine("pve");
    expect(pve?.getAttribute("data-has-data")).toBe("true");
    expect(text(pve)).toContain(
      "Hidden, but it still holds data across your organisation: 2 nodes, 31 VMs and containers, 4 jobs.",
    );
    expect(text(pve)).toContain(
      "Nothing was deleted, its jobs keep running, and its pages still open by their address.",
    );
    // The module stays reachable by its address.
    expect(pve?.querySelector("a")?.getAttribute("href")).toBe("/virtualization");

    // Singular and plural, each in its own words.
    expect(text(hiddenLine("imap"))).toContain("1 connection, 14 protected objects.");

    // A module that is off and holds nothing says so, and needs no way in.
    const archive = hiddenLine("archive");
    expect(archive?.getAttribute("data-has-data")).toBe("false");
    expect(text(archive)).toBe("Hidden. It holds no data.");
    expect(archive?.querySelector("a")).toBeNull();

    // A module that is on says nothing of the kind, whatever it holds.
    expect(hiddenLine("microsoft365")).toBeNull();
    expect(hiddenLine("endpoints")).toBeNull();
  });

  it("speaks of all tenants where the installation manages tenants", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /settings": () => json(SETTINGS),
        "GET /settings/modules": () => json(SOME_OFF),
      }).mock,
    );
    mounted = await openInstallation("/installation/modules", {
      session: providerSession("owner", { features: [...TENANT_FEATURES] }),
    });
    await flush(8);
    expect(text(hiddenLine("pve"))).toContain(
      "Hidden, but it still holds data across all tenants: 2 nodes, 31 VMs and containers, 4 jobs.",
    );
  });

  it("switches a module off: sends the modules that stay on and refreshes the profile the menu reads", async () => {
    const routes = routedFetch({
      "GET /settings": () => json(SETTINGS),
      "GET /settings/modules": () => json(ALL_ON),
      "PUT /settings/modules": (request) =>
        json(withEnabled(SOME_OFF, (request.body as { enabled: ModuleId[] }).enabled)),
    });
    vi.stubGlobal("fetch", routes.mock);
    const queryClient = newQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    mounted = await openInstallation("/installation/modules", {
      session: providerSession("administrator"),
      queryClient,
    });
    await flush(8);

    await click(toggle("pve"));
    await flush(8);

    const sent = routes.requests.filter((request) => request.method === "PUT");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ enabled: ["microsoft365", "imap", "archive", "endpoints"] });
    // The page shows the server's answer: off, and what it still holds.
    expect(toggle("pve")?.getAttribute("aria-checked")).toBe("false");
    expect(text(hiddenLine("pve"))).toContain("31 VMs and containers");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.me });

    // And on again.
    await click(toggle("pve"));
    await flush(8);
    expect(routes.requests.filter((request) => request.method === "PUT").at(-1)?.body).toEqual({
      enabled: ["microsoft365", "imap", "archive", "endpoints", "pve"],
    });
    expect(toggle("pve")?.getAttribute("aria-checked")).toBe("true");
    expect(hiddenLine("pve")).toBeNull();
  });

  it("keeps the last module on: its switch is closed and says why", async () => {
    const routes = routedFetch({
      "GET /settings": () => json(SETTINGS),
      "GET /settings/modules": () => json(withEnabled(ALL_ON, ["archive"])),
    });
    vi.stubGlobal("fetch", routes.mock);
    mounted = await openInstallation("/installation/modules", {
      session: providerSession("owner", { modules: ["archive"] }),
    });
    await flush(8);

    expect(toggle("archive")?.getAttribute("aria-checked")).toBe("true");
    expect(toggle("archive")?.disabled).toBe(true);
    expect(text(row("archive"))).toContain("One module always stays on.");
    // The others can be switched on as always.
    expect(toggle("pve")?.disabled).toBe(false);
    await click(toggle("archive"));
    await flush(4);
    expect(routes.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it.each(["technician", "read_only"] as const)(
    "shows the modules to a %s read-only, with the role that is needed",
    async (role) => {
      const routes = routedFetch({
        "GET /settings": () => json(SETTINGS),
        "GET /settings/modules": () => json(SOME_OFF),
      });
      vi.stubGlobal("fetch", routes.mock);
      mounted = await openInstallation("/installation/modules", {
        session: providerSession(role),
      });
      await flush(8);

      const note = document.querySelector('[data-slot="access-note"]');
      expect(note?.getAttribute("data-reason")).toBe("role");
      expect(text(note)).toContain("needs the Administrator role in the provider team or higher");
      for (const id of ["microsoft365", "imap", "archive", "endpoints", "pve"] as const) {
        expect(toggle(id)?.disabled).toBe(true);
      }
      // What is hidden and what it holds is still there to read.
      expect(text(hiddenLine("pve"))).toContain("31 VMs and containers");
      await click(toggle("microsoft365"));
      await flush(4);
      expect(routes.requests.some((request) => request.method === "PUT")).toBe(false);
    },
  );

  it("is read-only in the public demo", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /settings": () => json(SETTINGS),
        "GET /settings/modules": () => json(ALL_ON),
      }).mock,
    );
    mounted = await openInstallation("/installation/modules", {
      session: providerSession("owner"),
      demo: true,
    });
    await flush(8);
    expect(document.querySelector('[data-slot="access-note"]')?.getAttribute("data-reason")).toBe(
      "demo",
    );
    expect(toggle("pve")?.disabled).toBe(true);
  });
});

describe("the installation page and a module that is off", () => {
  const routes = () =>
    routedFetch({
      "GET /settings": () => json(SETTINGS),
      "GET /settings/modules": () => json(SOME_OFF),
      "GET /settings/pve": () =>
        json({ settings: { verifyAfterBackup: true }, defaults: { verifyAfterBackup: true } }),
    });

  it("leaves the module's section out of the sub-navigation, and keeps the others", async () => {
    vi.stubGlobal("fetch", routes().mock);
    mounted = await openInstallation("/installation/modules", {
      session: providerSession("owner", { modules: ["microsoft365", "endpoints"] }),
    });
    await flush(8);

    // Proxmox VE is off: its settings section is not offered.
    expect(subNavEntry("proxmox")).toBeNull();
    // The sections of modules that are on, and the ones that belong to none, are.
    expect(subNavEntry("agent-policy")).not.toBeNull();
    expect(subNavEntry("microsoft-app")).not.toBeNull();
    expect(subNavEntry("server")).not.toBeNull();
    expect(subNavEntry("modules")).not.toBeNull();
  });

  it("still opens that section by its address, lists it while it is open and says the module is hidden", async () => {
    vi.stubGlobal("fetch", routes().mock);
    mounted = await openInstallation("/installation/proxmox", {
      session: providerSession("owner", { modules: ["microsoft365", "endpoints"] }),
    });
    await flush(8);

    expect(
      document.querySelector('[data-slot="installation-section"]')?.getAttribute("data-section"),
    ).toBe("proxmox");
    expect(document.querySelector('[data-slot="pve-settings"]')).not.toBeNull();
    expect(subNavEntry("proxmox")).not.toBeNull();
    const hint = document.querySelector<HTMLElement>('[data-slot="module-hidden-hint"]');
    expect(text(hint)).toContain("This module is hidden in the navigation: Proxmox VE.");
    expect(hint?.querySelector("a")?.getAttribute("href")).toBe("/installation/modules");
  });

  it("shows every section, and no hint, while every module is on", async () => {
    vi.stubGlobal("fetch", routes().mock);
    mounted = await openInstallation("/installation/proxmox", {
      session: providerSession("owner"),
    });
    await flush(8);
    expect(subNavEntry("proxmox")).not.toBeNull();
    expect(document.querySelector('[data-slot="module-hidden-hint"]')).toBeNull();
  });
});
