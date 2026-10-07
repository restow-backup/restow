// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Mounted,
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  json,
  problem,
  routedFetch,
  sessionAs,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { registerWebExtension, resetWebExtensionsForTesting } from "@/lib/extensions";
import type { NavLock } from "@/lib/navigation";

import {
  DEFAULT_STORAGE,
  SETTINGS,
  TENANT_FEATURES,
  extensionSection,
  openInstallation,
  providerSession,
} from "./testing";

/**
 * The installation page in a DOM: who opens it, its sub-navigation, the
 * sections and what each says in an installation with tenants and in one
 * organisation, the read-only state of a provider role that may only look,
 * and the sections an extension adds, locked or open.
 */

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

const MS_APP = {
  source: "none",
  clientId: null,
  homeTenantId: null,
  authorityHost: null,
  credential: { kind: null, set: false, expiresAt: null, certificate: null },
  problem: null,
  updatedAt: null,
  updatedBy: null,
  redirectUris: {
    adminConsent: "https://restow.example.com/api/v1/sources/m365/consent/callback",
    signIn: "https://restow.example.com/api/auth/callback/microsoft",
  },
  permissions: [],
  sso: { configured: false },
  environmentPartial: false,
  lastTest: null,
};

const PASSKEY_CHECK = {
  passkeyReady: SETTINGS.passkeyReady,
  probe: {
    status: "ok",
    url: "https://restow.example.com",
    detail: null,
    checkedAt: "2026-10-02T10:00:00.000Z",
  },
  environment: SETTINGS.environment,
};

function routes(overrides: Record<string, () => Response> = {}) {
  return routedFetch({
    "GET /settings": () => json(SETTINGS),
    "GET /settings/passkey-ready": () => json(PASSKEY_CHECK),
    "GET /settings/microsoft-app": () => json(MS_APP),
    "GET /settings/default-storage": () => json(DEFAULT_STORAGE),
    ...overrides,
  });
}

function text(scope: ParentNode | null | undefined = document.body): string {
  return (scope?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function slot(name: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-slot="${name}"]`);
}

async function open(path: string, options: Parameters<typeof openInstallation>[1] = {}) {
  mounted = await openInstallation(path, options);
  await flush(8);
  return mounted.container;
}

function subnav(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('nav[aria-label="Installation sections"]');
}

function subnavEntries(): string[] {
  return [...(subnav()?.querySelectorAll("a") ?? [])].map((entry) => text(entry));
}

describe("who opens the installation page", () => {
  it("shows a provider admin the sections in a sub-navigation, the open one marked", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/mail");
    expect(subnavEntries()).toEqual([
      "Server",
      "Notification mail",
      "Microsoft multi-tenant app",
      "Default storage",
      "Network shares",
      "Updates",
      "Edition",
      "About",
    ]);
    const current = subnav()?.querySelector('a[aria-current="page"]');
    expect(text(current)).toBe("Notification mail");
    // The title names the section; the level pill and the breadcrumbs are the shell's.
    expect(document.body.querySelector("h1")?.textContent).toBe("Notification mail");
  });

  it("keeps a tenant administrator out, with a sentence instead of the sections", async () => {
    const { mock, requests } = routes();
    vi.stubGlobal("fetch", mock);
    await open("/installation/server", {
      session: sessionAs({ role: "tenant_admin", isProviderAdmin: false, providerRole: null }),
    });
    expect(text()).toContain("The installation settings are for provider administrators");
    expect(subnav()).toBeNull();
    expect(requests).toEqual([]);
  });

  it("says why a provider role limited to some tenants has nothing here", async () => {
    const { mock, requests } = routes();
    vi.stubGlobal("fetch", mock);
    await open("/installation/server", {
      session: providerSession("administrator", { providerAllTenants: false }),
    });
    expect(text()).toContain("covers selected tenants only");
    expect(subnav()).toBeNull();
    expect(requests).toEqual([]);
  });

  it("opens the first section for an address no section answers to", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/does-not-exist");
    expect(document.body.querySelector("h1")?.textContent).toBe("Server");
  });

  it("offers a select above the content for a narrow screen, with the same sections", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/server");
    const select = document.body.querySelector<HTMLElement>("#installation-section-select");
    expect(select?.getAttribute("role")).toBe("combobox");
    expect(text(select)).toContain("Server");
    expect(
      document.body.querySelector('label[for="installation-section-select"]')?.textContent,
    ).toBe("Section");
  });
});

describe("wording: all tenants, or the organisation", () => {
  it("speaks of all tenants where the installation manages tenants", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/server", {
      session: providerSession("owner", { features: [...TENANT_FEATURES] }),
    });
    expect(text()).toContain("Applies to all tenants.");
    expect(text()).not.toContain("your organisation");
  });

  it("speaks of the organisation, never of tenants, in Community and Business", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/server", { session: providerSession("owner", { features: [] }) });
    expect(text()).toContain("Applies to your organisation.");
    // The section's own name, "Microsoft multi-tenant app", aside: no word of tenants in the page.
    expect(text(slot("page-header"))).not.toMatch(/tenant/i);
    expect(text(slot("installation-section"))).not.toMatch(/tenant/i);
  });

  it("says in German 'alle Mandanten' or 'Ihre Organisation'", async () => {
    await i18n.changeLanguage("de");
    try {
      vi.stubGlobal("fetch", routes().mock);
      await open("/installation/server", {
        session: providerSession("owner", { features: [...TENANT_FEATURES] }),
      });
      expect(text()).toContain("Gilt für alle Mandanten.");
      await mounted?.unmount();
      mounted = null;
      await open("/installation/server", { session: providerSession("owner", { features: [] }) });
      expect(text()).toContain("Gilt für Ihre Organisation.");
      expect(text()).not.toMatch(/Mandant/);
    } finally {
      // Unmount first: a language change under a mounted page would update it outside act.
      await mounted?.unmount();
      mounted = null;
      await i18n.changeLanguage("en");
    }
  });
});

describe("Server", () => {
  it("shows the operating mode, the passkey readiness, what the server runs with and the operator notice", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/server");
    expect(text()).toContain("Operating mode");
    expect(text()).toContain("Public URL");
    expect(text()).toContain("Passkey readiness");
    expect(text()).toContain("Address in the server environment");
    expect(text()).toContain("https://restow.example.com");
    expect(slot("notice-state")?.textContent).toMatch(/^Accepted on .+ \(version 2026-10-01\)\.$/);
  });

  it("shows the operator notice read-only, behind a fold, with its checkbox locked", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/server");
    expect(document.body.querySelector("#installation-notice-accept")).toBeNull();
    await click(buttonByText(document.body, "Show the notice"));
    await flush();
    const box = document.body.querySelector<HTMLElement>("#installation-notice-accept");
    expect(box?.getAttribute("aria-checked")).toBe("true");
    expect(box?.hasAttribute("disabled")).toBe(true);
    expect(text()).toContain("Hide the notice");
  });

  it("says when a newer version of the notice waits, and when none was accepted", async () => {
    const outdated = {
      ...SETTINGS,
      disclaimer: { acceptedVersion: "2026-01-01", acceptedAt: null, currentVersion: "2026-10-01" },
    };
    vi.stubGlobal("fetch", routes({ "GET /settings": () => json(outdated) }).mock);
    await open("/installation/server");
    expect(slot("notice-state")?.textContent).toContain(
      "A newer version of the notice (2026-10-01)",
    );
    await mounted?.unmount();
    mounted = null;
    const none = { ...SETTINGS, disclaimer: { ...outdated.disclaimer, acceptedVersion: null } };
    vi.stubGlobal("fetch", routes({ "GET /settings": () => json(none) }).mock);
    await open("/installation/server");
    expect(slot("notice-state")?.textContent).toBe("The notice has not been accepted yet.");
  });

  it("has no danger zone", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/server");
    expect(text()).not.toMatch(/danger zone/i);
  });
});

describe("Notification mail", () => {
  it("states plainly that no transport is set up, as a normal state with nothing to remove", async () => {
    const none = { ...SETTINGS, mail: { transport: null } };
    vi.stubGlobal("fetch", routes({ "GET /settings": () => json(none) }).mock);
    await open("/installation/mail");
    expect(text()).toContain("No mail transport is set up");
    expect(text()).toContain("Mail is optional.");
    // Not an alarm: the setup wizard lets an operator skip this step.
    expect(document.body.querySelector('[data-variant="warning"]')).toBeNull();
    expect(buttonByText(document.body, "Remove mail configuration")).toBeNull();
  });

  it("holds the removal of the mail configuration, behind the old confirmation", async () => {
    const { mock, requests } = routes({
      "DELETE /settings/mail": () => json({ ...SETTINGS, mail: { transport: null } }),
    });
    vi.stubGlobal("fetch", mock);
    await open("/installation/mail");
    expect(text()).not.toMatch(/danger zone/i);
    await click(buttonByText(document.body, "Remove mail configuration"));
    await flush();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Remove the mail configuration?");
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    await click(buttonByText(dialog as HTMLElement, "Remove"));
    await flush(6);
    expect(requests.filter((request) => request.method === "DELETE")).toEqual([
      { method: "DELETE", path: "/settings/mail", body: undefined },
    ]);
  });
});

describe("Microsoft multi-tenant app", () => {
  it("says in one sentence when it is needed, for tenants and for the organisation", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/microsoft-app", {
      session: providerSession("owner", { features: [...TENANT_FEATURES] }),
    });
    expect(text()).toContain(
      "Optional. This app is only needed when tenants are connected by a consent link instead of their own app.",
    );
    await mounted?.unmount();
    mounted = null;
    await open("/installation/microsoft-app", {
      session: providerSession("owner", { features: [] }),
    });
    expect(text()).toContain(
      "Optional. This app is only needed when your organisation is connected by a consent link instead of its own app.",
    );
  });

  it("does not build the per-tenant app or the table of tenants using this app", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/microsoft-app");
    expect(text()).not.toContain("Tenants that use this app");
    expect(text()).not.toContain("own app per tenant");
  });
});

describe("Default storage", () => {
  it("states where the default is and who uses it, and says it comes from the environment", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/default-storage", {
      session: providerSession("owner", { features: [...TENANT_FEATURES] }),
    });
    expect(text()).toContain("Directory on the server");
    expect(text()).toContain("/data/chunks");
    expect(text()).toContain("3 of 5 tenants");
    expect(text()).toContain("No copy configured");
    expect(text(slot("default-storage-source"))).toBe("The server environment (.env)");
    expect(slot("default-storage-override")).toBeNull();
    expect(text()).toContain("Not tested yet.");
  });

  it("names the organisation, not tenants, in Community", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/default-storage", {
      session: providerSession("owner", { features: [] }),
    });
    expect(text()).toContain("Your organisation. It has no storage location of its own.");
    expect(text(slot("page-header"))).not.toMatch(/tenant/i);
    expect(text(slot("installation-section"))).not.toMatch(/tenant/i);
  });

  it("tests the default on request and shows the outcome", async () => {
    const tested = {
      probe: {
        ok: true,
        checkedAt: "2026-10-02T10:00:00.000Z",
        durationMs: 12,
        steps: [
          { step: "write", ok: true, durationMs: 3, errorCode: null, error: null },
          { step: "read", ok: true, durationMs: 2, errorCode: null, error: null },
        ],
        failedStep: null,
        errorCode: null,
        error: null,
        warnings: [],
      },
      objectLock: {
        status: "unsupported",
        mode: null,
        defaultRetentionDays: null,
        defaultRetentionYears: null,
        reason: "filesystem",
        detail: null,
        checkedAt: "2026-10-02T10:00:00.000Z",
      },
      view: {
        ...DEFAULT_STORAGE,
        lastTest: {
          ok: true,
          testedAt: "2026-10-02T10:00:00.000Z",
          testedBy: "owner@example.test",
          failedStep: null,
          errorCode: null,
        },
      },
    };
    const { mock, requests } = routes({
      "POST /settings/default-storage/test": () => json(tested),
    });
    vi.stubGlobal("fetch", mock);
    await open("/installation/default-storage");
    await click(buttonByText(document.body, "Test default storage"));
    await flush(6);
    expect(requests.filter((request) => request.method === "POST")).toEqual([
      { method: "POST", path: "/settings/default-storage/test", body: undefined },
    ]);
    expect(text()).toContain("Test again");
    expect(text()).not.toContain("Not tested yet.");
    // A passed test is a state, not proof of a restore: never the green of a restore check.
    expect(document.body.innerHTML).not.toMatch(/text-success|bg-success|text-green|bg-green/);
  });

  it("shows the last recorded test when the page opens", async () => {
    const failed = {
      ...DEFAULT_STORAGE,
      lastTest: {
        ok: false,
        testedAt: "2026-10-01T10:00:00.000Z",
        testedBy: "owner@example.test",
        failedStep: "write",
        errorCode: "access_denied",
      },
    };
    vi.stubGlobal("fetch", routes({ "GET /settings/default-storage": () => json(failed) }).mock);
    await open("/installation/default-storage");
    expect(slot("last-test")?.textContent).toContain("The last test failed");
    expect(slot("last-test")?.textContent).toContain("owner@example.test");
    expect(slot("last-test")?.textContent).toContain("Write");
  });

  const SAVED_LOCAL = {
    ...DEFAULT_STORAGE,
    source: "database",
    location: "/srv/restow",
    saved: {
      kind: "local",
      local: { basePath: "/srv/restow" },
      s3: null,
      updatedAt: "2026-10-02T09:00:00.000Z",
      updatedBy: "owner@example.test",
    },
  };

  it("says when the default saved here takes precedence over the environment", async () => {
    vi.stubGlobal(
      "fetch",
      routes({ "GET /settings/default-storage": () => json(SAVED_LOCAL) }).mock,
    );
    await open("/installation/default-storage");
    expect(text(slot("default-storage-source"))).toContain(
      "Saved on this page by owner@example.test",
    );
    expect(text(slot("default-storage-override"))).toContain("/data/chunks");
    expect(buttonByText(document.body, "Use the server environment again")).not.toBeNull();
  });

  it("saves a local path, sends no name or role, and shows the test the server ran", async () => {
    const probe = {
      ok: true,
      checkedAt: "2026-10-02T10:00:00.000Z",
      durationMs: 9,
      steps: [{ step: "write", ok: true, durationMs: 3, errorCode: null, error: null }],
      failedStep: null,
      errorCode: null,
      error: null,
      warnings: [],
    };
    const { mock, requests } = routes({
      "PUT /settings/default-storage": () => json({ probe, objectLock: null, view: SAVED_LOCAL }),
    });
    vi.stubGlobal("fetch", mock);
    await open("/installation/default-storage");
    await type(document.body.querySelector("#target-base-path"), "/srv/restow");
    await click(buttonByText(document.body, "Test and save"));
    await flush(8);
    expect(requests.filter((request) => request.method === "PUT")).toEqual([
      {
        method: "PUT",
        path: "/settings/default-storage",
        body: { kind: "local", config: { basePath: "/srv/restow" } },
      },
    ]);
    expect(slot("default-storage-probe")).not.toBeNull();
    expect(text(slot("default-storage-source"))).toContain("Saved on this page");
  });

  it("names the tenants that keep data on the default, before and after a refused change", async () => {
    const blockers = [{ tenantId: "t-1", tenantName: "Contoso", reasons: ["data"] }];
    const { mock } = routes({
      "GET /settings/default-storage": () => json({ ...DEFAULT_STORAGE, blockers }),
      "PUT /settings/default-storage": () =>
        problem("urn:restow:problem:settings-default-storage-in-use", 409, { blockers }),
    });
    vi.stubGlobal("fetch", mock);
    await open("/installation/default-storage", {
      session: providerSession("owner", { features: [...TENANT_FEATURES] }),
    });
    expect(text(slot("default-storage-blockers"))).toContain("Contoso: has backups here");
    await type(document.body.querySelector("#target-base-path"), "/srv/elsewhere");
    await click(buttonByText(document.body, "Test and save"));
    await flush(8);
    expect(document.body.querySelectorAll('[data-slot="default-storage-blockers"]')).toHaveLength(
      2,
    );
  });

  it("closes the change to everyone but the owner, and says so", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/default-storage", { session: providerSession("administrator") });
    const configure = slot("default-storage-configure");
    expect(text(configure?.querySelector('[data-slot="access-note"]'))).toContain(
      "needs the Owner role",
    );
    expect(
      buttonByText(document.body, "Test and save")?.closest("fieldset[disabled]"),
    ).not.toBeNull();
  });

  it("says what is wrong, and offers no test, when the environment describes no usable storage", async () => {
    const broken = { ...DEFAULT_STORAGE, configured: false, kind: null, location: null };
    vi.stubGlobal("fetch", routes({ "GET /settings/default-storage": () => json(broken) }).mock);
    await open("/installation/default-storage");
    expect(text()).toContain("The storage settings are invalid");
    expect(buttonByText(document.body, "Test default storage")).toBeNull();
  });
});

describe("a provider role that may look but not change", () => {
  const mayNotChange = ["administrator", "technician", "read_only"] as const;

  it.each(mayNotChange)(
    "shows the forms to %s read-only, with a hint instead of a 403",
    async (role) => {
      const { mock, requests } = routes();
      vi.stubGlobal("fetch", mock);
      await open("/installation/mail", { session: providerSession(role) });
      expect(slot("access-note")?.getAttribute("data-reason")).toBe("role");
      expect(slot("access-note")?.textContent).toContain(
        "needs the Owner role in the provider team",
      );
      const form = document.body.querySelector("fieldset[disabled] #settings-mail-form");
      expect(form).not.toBeNull();
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    },
  );

  it("gives the owner the form without a hint", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/mail", { session: providerSession("owner") });
    expect(slot("access-note")).toBeNull();
    expect(
      document.body.querySelector("#settings-mail-form")?.closest("fieldset[disabled]"),
    ).toBeNull();
  });

  it("treats an older server that reports no team role as an owner, as the API does", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/mail", { session: providerSession(null) });
    expect(slot("access-note")).toBeNull();
  });

  it("closes the mail test for a technician but not for an administrator", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/mail", { session: providerSession("technician") });
    const testButton = buttonByText(document.body, "Send test message");
    expect(testButton?.closest("fieldset[disabled]")).not.toBeNull();
    await mounted?.unmount();
    mounted = null;
    await open("/installation/mail", { session: providerSession("administrator") });
    expect(
      buttonByText(document.body, "Send test message")?.closest("fieldset[disabled]"),
    ).toBeNull();
  });

  it("says which role runs the storage test, and closes the button below it", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/default-storage", { session: providerSession("technician") });
    expect(slot("access-note")?.textContent).toContain("needs the Administrator role");
    expect(
      buttonByText(document.body, "Test default storage")?.closest("fieldset[disabled]"),
    ).not.toBeNull();
    await mounted?.unmount();
    mounted = null;
    await open("/installation/default-storage", { session: providerSession("administrator") });
    // Only the owner's note on changing the default is left; the test is open.
    expect(
      [...document.body.querySelectorAll('[data-slot="access-note"]')].map((note) => text(note)),
    ).toEqual([expect.stringContaining("needs the Owner role")]);
    expect(
      buttonByText(document.body, "Test default storage")?.closest("fieldset[disabled]"),
    ).toBeNull();
  });

  it("closes every form in the public demo, whatever the role, and says so", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/mail", { session: providerSession("owner"), demo: true });
    expect(slot("access-note")?.getAttribute("data-reason")).toBe("demo");
    expect(slot("access-note")?.textContent).toContain("public demo");
    expect(
      document.body.querySelector("#settings-mail-form")?.closest("fieldset[disabled]"),
    ).not.toBeNull();
  });
});

describe("sections an extension adds", () => {
  const lock = (locked: boolean): NavLock => ({
    isLocked: () => locked,
    to: "/installation/license",
    search: { requires: "business" },
    hintKey: "common:errors.featureUnavailable",
  });

  it("puts them in the sub-navigation by their order and hands them the requires marker", async () => {
    registerWebExtension({ name: "test", installationSections: [extensionSection()] });
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/example?requires=business");
    expect(subnavEntries().indexOf("Provider API")).toBe(
      subnavEntries().indexOf("Default storage") - 1,
    );
    expect(slot("example-section")?.textContent).toBe("example:business");
  });

  it("drops a requires marker that is not a plain token", async () => {
    registerWebExtension({ name: "test", installationSections: [extensionSection()] });
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/example?requires=Not%20a%20Token");
    expect(slot("example-section")?.textContent).toBe("example:none");
  });

  it("cannot replace a section of the core", async () => {
    registerWebExtension({
      name: "test",
      installationSections: [extensionSection({ id: "server", labelKey: "x:impostor" })],
    });
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/server");
    expect(subnavEntries()).not.toContain("x:impostor");
    expect(text()).toContain("Operating mode");
  });

  it("greys a locked section out in the sub-navigation and leads where its lock says", async () => {
    registerWebExtension({
      name: "test",
      installationSections: [extensionSection({ lock: lock(true) })],
    });
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/server");
    const entry = [...(subnav()?.querySelectorAll("a") ?? [])].find((a) =>
      a.textContent?.includes("Provider API"),
    );
    expect(entry?.getAttribute("data-locked")).toBe("true");
    expect(entry?.getAttribute("href")).toBe("/installation/license?requires=business");
    expect(entry?.querySelector("svg.lucide-lock")).not.toBeNull();
    expect(entry?.textContent).toContain("This function is not available on this installation.");
  });

  it("shows a locked section's address the reason and the way to unlock, not its content", async () => {
    registerWebExtension({
      name: "test",
      installationSections: [extensionSection({ lock: lock(true) })],
    });
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/example");
    expect(slot("example-section")).toBeNull();
    const panel = slot("locked-section");
    expect(panel?.textContent).toContain("Provider API is not unlocked yet");
    expect(panel?.querySelector("a")?.getAttribute("href")).toBe(
      "/installation/license?requires=business",
    );
  });

  it("opens the same section once its lock lets go", async () => {
    registerWebExtension({
      name: "test",
      installationSections: [extensionSection({ lock: lock(false) })],
    });
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/example");
    expect(slot("locked-section")).toBeNull();
    expect(slot("example-section")).not.toBeNull();
    const entry = [...(subnav()?.querySelectorAll("a") ?? [])].find((a) =>
      a.textContent?.includes("Provider API"),
    );
    expect(entry?.hasAttribute("data-locked")).toBe(false);
  });
});

describe("About", () => {
  it("names the version, the commit and the core license, and no edition", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open("/installation/about", {
      session: sessionAs({
        version: {
          running: "0.2.0",
          commit: "abc1234",
          latest: null,
          updateAvailable: false,
          releaseUrl: null,
        },
      }),
    });
    expect(text()).toContain("0.2.0");
    expect(text()).toContain("abc1234");
    expect(text()).toContain("Apache-2.0");
    // The About text itself; the sub-navigation lists the Edition section of the Community build.
    const content = document.body.cloneNode(true) as HTMLElement;
    for (const nav of content.querySelectorAll("nav, select")) {
      nav.remove();
    }
    expect(text(content)).not.toMatch(/edition|license key/i);
  });
});
