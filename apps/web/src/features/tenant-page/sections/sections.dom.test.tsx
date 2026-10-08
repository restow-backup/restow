// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Mounted,
  click,
  enableActEnvironment,
  flush,
  json,
  routedFetch,
  sessionAs,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { openSection, tenantOf } from "../testing";
import { ArchiveSection } from "./archive-section";
import { ConnectionsSection } from "./connections-section";
import { MasterDataSection } from "./master-data-section";
import { NotificationsSection } from "./notifications-section";
import { StorageSection } from "./wrappers";

/**
 * The sections of the tenant page that bring their own content (the others
 * wrap pages of their features, which have tests of their own): what they
 * fetch, what they show to whom, and that saving the recipients sends them.
 */

enableActEnvironment();

const MUELLER = tenantOf("mueller", { name: "Müller GmbH" });

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
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const text = () => document.body.textContent ?? "";
const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`);

function detail(over: Record<string, unknown> = {}) {
  return {
    id: "mueller",
    name: "Müller GmbH",
    slug: "mueller",
    kind: "customer",
    status: "active",
    customerNumber: "K-1001",
    organizationId: null,
    mailboxCap: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    memberCount: 2,
    pendingInvitations: 0,
    keyVersion: 1,
    customer: {
      customerNumber: "K-1001",
      vatId: null,
      addressLine1: "Hauptstr. 1",
      addressLine2: null,
      postalCode: "51465",
      city: "Bergisch Gladbach",
      countryCode: "DE",
      language: "de",
      timeZone: "Europe/Berlin",
    },
    contacts: [],
    notificationRecipients: [
      { id: "n-1", email: "ops@example.test", name: "Ops", categories: ["jobFailures"] },
    ],
    ...over,
  };
}

describe("Archive", () => {
  it("shows how long the tenant's archive is kept and points to the daily Archive page", async () => {
    const { mock } = routedFetch({
      "GET /archive/retention": () => json({ mode: "end_of_year", years: 10, source: "default" }),
    });
    vi.stubGlobal("fetch", mock);
    mounted = await openSection(ArchiveSection, "/tenants/mueller/archive", {
      session: sessionAs({ activeTenant: MUELLER, tenants: [MUELLER] }),
    });
    await flush(5);
    expect(slot("archive-retention-period")?.textContent).toBe("10 years");
    expect(slot("archive-capture")?.querySelector("a")?.getAttribute("href")).toBe("/archive");
  });

  it("says plainly when archived mail is kept without end", async () => {
    const { mock } = routedFetch({
      "GET /archive/retention": () =>
        json({ mode: "from_capture", years: null, source: "default" }),
    });
    vi.stubGlobal("fetch", mock);
    mounted = await openSection(ArchiveSection, "/tenants/mueller/archive", {
      session: sessionAs({ activeTenant: MUELLER, tenants: [MUELLER] }),
    });
    await flush(5);
    expect(slot("archive-retention-period")?.textContent).toMatch(/without end|unlimited/i);
  });
});

describe("Storage", () => {
  it("has one heading called Storage locations, not one for the page and a second for the list", async () => {
    // Nothing answers: the page is in its loading state, which already has both headings and the list.
    vi.stubGlobal("fetch", () => new Promise(() => undefined));
    mounted = await openSection(StorageSection, "/tenants/mueller/storage", {
      session: sessionAs({ activeTenant: MUELLER, tenants: [MUELLER] }),
    });
    await flush(3);
    const headings = [...document.querySelectorAll("h1, h2, h3")].filter(
      (heading) => heading.textContent?.trim() === "Storage locations",
    );
    expect(headings).toHaveLength(1);
    // The list is still a region of that name, with what it holds explained.
    const list = slot("storage-targets");
    expect(list?.getAttribute("aria-label")).toBe("Storage locations");
    expect(list?.textContent).toContain("The primary receives every backup first");
  });
});

describe("Connections", () => {
  it("marks Google Workspace as not available yet and leads Gmail users to IMAP", async () => {
    mounted = await openSection(ConnectionsSection, "/tenants/mueller/connections?tab=google", {
      session: sessionAs({ activeTenant: MUELLER, tenants: [MUELLER] }),
    });
    await flush(3);
    const tablist = document.querySelector('[role="tablist"], nav');
    expect(tablist?.textContent).toContain("Google Workspace");
    expect(tablist?.textContent).toContain("Soon");
    expect(text()).toContain("IMAP");
    const toImap = [...document.querySelectorAll("a")].find((link) =>
      link.getAttribute("href")?.includes("tab=imap"),
    );
    expect(toImap).toBeDefined();
  });
});

describe("Master data", () => {
  const storage = {
    items: [],
    installationDefault: { kind: "local", inUse: true },
    tenantHasData: false,
    canManageLocal: true,
  };

  it("lets a provider administrator change it and opens the installation for the values it owns", async () => {
    const { mock } = routedFetch({
      "GET /tenants/mueller": () => json(detail()),
      "GET /storage/targets": () => json(storage),
    });
    vi.stubGlobal("fetch", mock);
    mounted = await openSection(MasterDataSection, "/tenants/mueller/master-data", {
      session: sessionAs({
        activeTenant: MUELLER,
        tenants: [MUELLER],
        features: ["tenants.additional"],
        providerRole: "owner",
      }),
    });
    await flush(5);
    expect(text()).toContain("Müller GmbH");
    expect(text()).toContain("K-1001");
    expect(text()).toContain("restow.example.test");
    expect(slot("master-data-hint")).toBeNull();
    const links = [...document.querySelectorAll('[data-slot="set-in-installation"] a')];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/installation/server",
      "/installation/default-storage",
    ]);
  });

  it("shows a tenant administrator the data read-only, says whom to ask and offers no link into the installation", async () => {
    const { mock } = routedFetch({
      "GET /tenants/mueller": () => json(detail()),
      "GET /storage/targets": () => json(storage),
    });
    vi.stubGlobal("fetch", mock);
    mounted = await openSection(MasterDataSection, "/tenants/mueller/master-data", {
      session: sessionAs({
        isProviderAdmin: false,
        providerRole: null,
        role: "tenant_admin",
        activeTenant: MUELLER,
        tenants: [MUELLER],
        features: ["tenants.additional"],
      }),
    });
    await flush(5);
    expect(slot("master-data-hint")?.textContent).toContain("Whoever runs this installation");
    expect(text()).toContain("K-1001");
    expect([...document.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Edit",
    );
    expect(document.querySelectorAll('[data-slot="set-in-installation"] a')).toHaveLength(0);
  });

  it("tells a provider role below Administrator why the data cannot be changed", async () => {
    const { mock } = routedFetch({
      "GET /tenants/mueller": () => json(detail()),
      "GET /storage/targets": () => json(storage),
    });
    vi.stubGlobal("fetch", mock);
    mounted = await openSection(MasterDataSection, "/tenants/mueller/master-data", {
      session: sessionAs({
        providerRole: "technician",
        activeTenant: MUELLER,
        tenants: [MUELLER],
        features: ["tenants.additional"],
      }),
    });
    await flush(5);
    expect(slot("master-data-hint")?.textContent).toContain("Administrator role");
  });
});

describe("Notifications", () => {
  it("sends the changed recipients, which is what changes who is mailed", async () => {
    const saved: unknown[] = [];
    const { mock } = routedFetch({
      "GET /tenants/mueller": () => json(detail()),
      "GET /reports/catalog": () =>
        json({ events: [], sections: [], periods: [1, 7], scheduledAvailable: true }),
      "GET /reports/rules": () => json([]),
      "PUT /tenants/mueller/notification-recipients": (request) => {
        saved.push(request.body);
        return json([
          {
            id: "n-1",
            email: "ops@example.test",
            name: "Ops",
            categories: ["jobFailures", "readinessRed"],
          },
        ]);
      },
    });
    vi.stubGlobal("fetch", mock);
    mounted = await openSection(NotificationsSection, "/tenants/mueller/notifications", {
      session: sessionAs({
        activeTenant: MUELLER,
        tenants: [MUELLER],
        features: ["tenants.additional"],
      }),
    });
    await flush(5);
    expect(document.querySelector<HTMLInputElement>("#wizard-recipient-0-email")?.value).toBe(
      "ops@example.test",
    );

    const save = () =>
      [...(slot("notification-recipients")?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === "Save recipients",
      );
    expect(save()?.disabled).toBe(true);

    await click(document.querySelector("#wizard-recipient-0-readinessRed"));
    expect(save()?.disabled).toBe(false);
    await click(save());
    await flush(5);

    expect(saved).toEqual([
      [{ email: "ops@example.test", name: "Ops", categories: ["jobFailures", "readinessRed"] }],
    ]);
  });
});
