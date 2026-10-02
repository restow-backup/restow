import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { integrationKeys } from "@/features/integrations/api";
import { PROVIDER_API_SECTION_ID } from "@/features/integrations/paths";
import { i18n } from "@/i18n";
import { registerWebExtension, resetWebExtensionsForTesting } from "@/lib/extensions";

import { eeWebExtension } from "../index";
import { providerApiInstallationSections } from "./index";
import { ProviderApiSection } from "./provider-api-section";

/**
 * Installation, Provider API (Service Provider): the provider keys moved here
 * from the Integrations page. The owner creates and revokes them; every other
 * provider role sees them read-only; below Service Provider the section is
 * locked and the keys are not asked for.
 */

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn().mockRejectedValue(new Error("no request expected")),
}));

let sessionState: {
  status: string;
  isProviderAdmin: boolean;
  providerRole: string | null;
  providerAllTenants: boolean;
  activeTenant: null;
  role: string;
  features: string[];
  extensions: Record<string, unknown>;
};

vi.mock("@/lib/session", () => ({
  useSession: () => sessionState,
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  resetWebExtensionsForTesting();
});

function session(providerRole: string | null, edition = "service_provider") {
  sessionState = {
    status: "authenticated",
    isProviderAdmin: true,
    providerRole,
    providerAllTenants: true,
    activeTenant: null,
    role: "provider_admin",
    features: ["apiKeys.provider"],
    extensions: { edition },
  };
}

const KEY = {
  id: "k-1",
  name: "PSA sync",
  prefix: "rsk_provider_ab12",
  scopes: ["status:read"],
  status: "active",
  createdAt: "2026-09-01T10:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  kind: "provider",
};

function render(node: React.ReactNode): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(integrationKeys.providerKeys, { available: true, items: [KEY] });
  client.setQueryData(["setup", "state"], undefined);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("ProviderApiSection", () => {
  it("lists the provider keys with their creation to the owner, without a hint", () => {
    session("owner");
    const html = render(<ProviderApiSection />);
    expect(html).toContain("Provider keys");
    expect(html).toContain("PSA sync");
    expect(html).toContain("Create provider key");
    expect(html).toContain("across all tenants");
    expect(html).not.toContain('data-slot="access-note"');
    expect(html).not.toContain("<fieldset disabled");
  });

  it.each(["administrator", "technician", "read_only"])(
    "shows the keys to %s read-only, with the Owner role named",
    (role) => {
      session(role);
      const html = render(<ProviderApiSection />);
      expect(html).toContain("PSA sync");
      expect(html).toContain('data-slot="access-note"');
      expect(html).toContain("needs the Owner role in the provider team");
      expect(html).toContain("<fieldset disabled");
    },
  );
});

describe("the section the Service Provider module adds", () => {
  it("is called provider-api, is part of the installation page and sits after Default storage", () => {
    expect(PROVIDER_API_SECTION_ID).toBe("provider-api");
    expect(providerApiInstallationSections.map((section) => [section.id, section.order])).toEqual([
      ["provider-api", 60],
    ]);
  });

  it("is locked below Service Provider and leads to the license section", () => {
    registerWebExtension(eeWebExtension);
    const lock = providerApiInstallationSections[0]?.lock;
    const context = (edition: string) => ({ features: [], extensions: { edition } });
    expect(lock?.isLocked(context("community"))).toBe(true);
    expect(lock?.isLocked(context("business"))).toBe(true);
    expect(lock?.isLocked(context("service_provider"))).toBe(false);
    expect(lock?.to).toBe("/installation/license");
    expect(lock?.search).toEqual({ requires: "service_provider" });
    expect(lock?.hintKey).toBe("license:locked.service_provider");
  });
});
