import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InstallationPanel } from "@/features/tenants/components/installation-panel";
import { i18n } from "@/i18n";
import {
  ExtensionSlot,
  extensionInstallationSections,
  registerWebExtension,
  resetWebExtensionsForTesting,
  slotComponent,
} from "@/lib/extensions";

import { eeWebExtension } from "../index";
import { licenseKeys } from "./api";
import { AboutLicense } from "./components/about-license";
import { EditionBadge } from "./components/edition-badge";
import { TeamScopeLocked } from "./components/team-scope-locked";
import { TenantsCreationLocked } from "./components/tenants-creation-locked";
import "./i18n";
import type { LicenseState } from "./types";

/**
 * What the license module adds to core pages: the license section of the
 * installation page (a section the extension registers), the edition badge of
 * the sidebar footer (a slot) and the reason no further tenant can be created.
 */

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn().mockRejectedValue(new Error("no request expected")),
}));

let sessionState: {
  status: string;
  isProviderAdmin: boolean;
  extensions: Record<string, unknown> | null;
};

vi.mock("@/lib/session", () => ({
  useSession: () => sessionState,
}));

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

function community(patch: Partial<LicenseState> = {}): LicenseState {
  return {
    edition: "community",
    source: "environment",
    environmentEdition: "community",
    installationId: INSTALLATION_ID,
    key: null,
    verification: { status: "ready", source: "embedded", fingerprint: "SHA256:abc" },
    ...patch,
  };
}

const business = community({
  edition: "business",
  source: "key",
  key: {
    keyId: "ABCD-EFGH-IJKL-MNOP",
    licensee: "Example IT GmbH",
    issuedAt: "2026-09-01T10:00:00.000Z",
    installedAt: "2026-09-02T10:00:00.000Z",
    installationId: INSTALLATION_ID,
  },
});

function render(node: React.ReactNode, state?: LicenseState | "error"): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  if (state === "error") {
    const query = client.getQueryCache().build(client, { queryKey: licenseKeys.state });
    query.setState({ status: "error", error: new Error("down"), fetchStatus: "idle" });
  } else if (state) {
    client.setQueryData(licenseKeys.state, state);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
}

/** Render `node` as the page of a memory router, for components that link. */
async function renderRouted(node: React.ReactNode): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

const RIGHTS = /AGPL|fair|free of charge|never limited|restore stays|source-available/i;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  sessionState = {
    status: "authenticated",
    isProviderAdmin: true,
    extensions: { edition: "community" },
  };
});

afterEach(() => {
  resetWebExtensionsForTesting();
});

describe("AboutLicense (the license section of the installation page)", () => {
  it("shows Community without a key, the installation and the form to install one", () => {
    const html = render(<AboutLicense requires={null} />, community());
    expect(html).toContain("License");
    expect(html).toContain(">Community<");
    expect(html).toContain("None installed");
    expect(html).toContain(INSTALLATION_ID);
    expect(html).toContain('aria-label="Copy installation ID"');
    expect(html).toContain("SHA256:abc");
    expect(html).toContain("Install a key");
    expect(html).not.toContain("Remove key");
    expect(html).not.toContain("license-terms");
    expect(html).not.toMatch(RIGHTS);
  });

  it("shows the installed key with licensee, key ID and the license terms", () => {
    sessionState.extensions = { edition: "business" };
    const html = render(<AboutLicense requires={null} />, business);
    expect(html).toContain(">Business<");
    expect(html).toContain("Key installed");
    expect(html).toContain("Example IT GmbH");
    expect(html).toContain("ABCD-EFGH-IJKL-MNOP");
    expect(html).toContain('href="https://restowbackup.com/en/license-terms/"');
    expect(html).toContain("View the license terms");
    expect(html).toContain("Remove key");
    expect(html).toContain("Install a different key");
    expect(html).not.toMatch(RIGHTS);
  });

  it("links the German license terms in the German interface", async () => {
    await i18n.changeLanguage("de");
    const html = render(<AboutLicense requires={null} />, business);
    expect(html).toContain('href="https://restowbackup.com/de/lizenzbedingungen/"');
    expect(html).toContain("Lizenzbedingungen ansehen");
  });

  it("names the edition a locked feature belongs to, unless it is already in effect", () => {
    expect(render(<AboutLicense requires="service_provider" />, community())).toContain(
      "That feature is part of Service Provider. Enter a license key below to unlock it.",
    );
    expect(render(<AboutLicense requires="reports.timed" />, community())).toContain(
      "That feature is part of Business.",
    );
    sessionState.extensions = { edition: "business" };
    expect(render(<AboutLicense requires="business" />, business)).not.toContain(
      "That feature is part of",
    );
    expect(render(<AboutLicense requires="something-else" />, community())).not.toContain(
      "That feature is part of",
    );
  });

  it("says when the license state cannot be read", () => {
    expect(render(<AboutLicense requires={null} />, "error")).toContain(
      "License status unavailable",
    );
  });
});

describe("EditionBadge (slot shell.sidebarFooter)", () => {
  it("names the edition in effect, and nothing while it is unknown", () => {
    sessionState.extensions = { edition: "service_provider" };
    expect(render(<EditionBadge />)).toContain(">Service Provider<");
    sessionState.extensions = null;
    expect(render(<EditionBadge />)).toBe("");
  });
});

describe("TenantsCreationLocked (slot tenants.creationLocked)", () => {
  it("names the edition and leads to the license section", async () => {
    sessionState.extensions = { edition: "business" };
    const html = await renderRouted(<TenantsCreationLocked />);
    expect(html).toContain("Another tenant requires the Service Provider edition");
    expect(html).toContain("The Business edition manages exactly one tenant");
    expect(html).toContain('href="/installation/license?requires=service_provider"');
    expect(html).toContain("Open license settings");
    expect(html).not.toMatch(RIGHTS);
  });
});

describe("TeamScopeLocked (slot team.tenantScopeLocked)", () => {
  it("names Service Provider as what limits members to chosen tenants, and leads to the license section", async () => {
    sessionState.extensions = { edition: "business" };
    const html = await renderRouted(<TeamScopeLocked />);
    expect(html).toContain(
      "Limiting members to chosen tenants requires the Service Provider edition",
    );
    expect(html).toContain("In the Business edition every member has every tenant.");
    expect(html).toContain('href="/installation/license?requires=service_provider"');
    expect(html).not.toMatch(RIGHTS);
  });

  it("fills the member dialog's slot once the ee extension is registered", () => {
    expect(render(<ExtensionSlot name="team.tenantScopeLocked" props={{}} fallback="core" />)).toBe(
      "core",
    );
    registerWebExtension(eeWebExtension);
    expect(slotComponent("team.tenantScopeLocked")).toBe(TeamScopeLocked);
  });
});

describe("registration", () => {
  it("fills the core's slots once the ee extension is registered", () => {
    expect(render(<ExtensionSlot name="shell.sidebarFooter" props={{}} />)).toBe("");
    registerWebExtension(eeWebExtension);
    expect(render(<ExtensionSlot name="shell.sidebarFooter" props={{}} />)).toContain(
      ">Community<",
    );
  });

  it("adds the sections of the installation page: journal receiving, provider API and the license", () => {
    expect(extensionInstallationSections()).toEqual([]);
    registerWebExtension(eeWebExtension);
    const sections = extensionInstallationSections();
    expect(sections.map((section) => [section.id, section.order])).toEqual([
      ["journal", 40],
      ["provider-api", 60],
      ["license", 80],
    ]);
    const community = { features: [], extensions: { edition: "community" } };
    const business = { features: [], extensions: { edition: "business" } };
    const provider = { features: [], extensions: { edition: "service_provider" } };
    const lockOf = (id: string) => sections.find((section) => section.id === id)?.lock;
    // Business and Service Provider sections are greyed out below their edition ...
    expect(lockOf("journal")?.isLocked(community)).toBe(true);
    expect(lockOf("journal")?.isLocked(business)).toBe(false);
    expect(lockOf("provider-api")?.isLocked(business)).toBe(true);
    expect(lockOf("provider-api")?.isLocked(provider)).toBe(false);
    // ... and lead to the license section, which no edition locks: it is where the key goes in.
    expect(lockOf("journal")?.to).toBe("/installation/license");
    expect(lockOf("journal")?.search).toEqual({ requires: "business" });
    expect(lockOf("provider-api")?.search).toEqual({ requires: "service_provider" });
    expect(lockOf("license")).toBeUndefined();
    // The license left About: its old address leads here.
    expect(sections.find((section) => section.id === "license")?.legacySettingsSection).toBe(
      "about",
    );
  });

  it("replaces the tenants page's neutral note with the edition's reason", async () => {
    const panel = (
      <InstallationPanel
        tenantCount={1}
        creationAllowed={false}
        usage={{ status: "success", data: { usedMailboxes: 3, mailboxesByTenant: {} } }}
      />
    );
    expect(render(panel)).toContain("This installation manages one tenant.");
    registerWebExtension(eeWebExtension);
    const html = await renderRouted(panel);
    expect(html).toContain("Another tenant requires the Service Provider edition");
    expect(html).not.toContain("This installation manages one tenant.");
  });
});
