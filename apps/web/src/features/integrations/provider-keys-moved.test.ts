// @vitest-environment happy-dom
import { Info } from "lucide-react";
import { createElement } from "react";
import type * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PROVIDER_API_SECTION_ID, providerKeysDestination } from "./paths";
import { parseIntegrationsSearch } from "./presenters";

import {
  type Mounted,
  enableActEnvironment,
  flush,
  json,
  mount,
  routedFetch,
  sessionAs,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { registerWebExtension, resetWebExtensionsForTesting } from "@/lib/extensions";

import { ApiKeysPanel } from "./api-keys/api-keys-panel";

/**
 * The provider keys moved from the Integrations page to Installation, Provider
 * API. The page keeps the keys of the tenant and points the provider admin to
 * the new place where the installation has one; the old place's address
 * (`?tab=provider-keys`) leads there.
 */

enableActEnvironment();

// The pointer is a router link; the page renders here without a router.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) =>
      createElement("a", { href: to, ...props }, children),
  };
});

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

const TENANT = {
  id: "t1",
  name: "Contoso",
  slug: "contoso",
  role: "tenant_admin",
  status: "active",
};

function section() {
  return {
    id: PROVIDER_API_SECTION_ID,
    labelKey: "installation:sections.providerApi",
    icon: Info,
    order: 60,
    component: () => null,
  };
}

async function show(role: "provider_admin" | "tenant_admin") {
  const { mock, requests } = routedFetch({ "GET /api-keys": () => json([]) });
  vi.stubGlobal("fetch", mock);
  mounted = mount(createElement(ApiKeysPanel), {
    session: sessionAs({
      role,
      isProviderAdmin: role === "provider_admin",
      tenants: [TENANT as never],
      activeTenant: TENANT as never,
    }),
  });
  await flush(5);
  return requests;
}

describe("the Integrations page without provider keys", () => {
  it("shows the keys of the tenant and asks the provider API for nothing", async () => {
    registerWebExtension({ name: "test", installationSections: [section()] });
    const requests = await show("provider_admin");
    expect(requests.map((request) => request.path)).toEqual(["/api-keys"]);
    expect(document.body.textContent).not.toContain("Create provider key");
  });

  it("points a provider admin to Installation, Provider API where the installation has it", async () => {
    registerWebExtension({ name: "test", installationSections: [section()] });
    await show("provider_admin");
    const note = document.body.querySelector('[data-slot="provider-keys-moved"]');
    expect(note?.textContent).toContain("Provider keys moved");
    expect(note?.querySelector("a")).not.toBeNull();
  });

  it("points nowhere where the installation has no such section", async () => {
    await show("provider_admin");
    expect(document.body.querySelector('[data-slot="provider-keys-moved"]')).toBeNull();
  });

  it("tells a tenant administrator nothing of provider keys", async () => {
    registerWebExtension({ name: "test", installationSections: [section()] });
    await show("tenant_admin");
    expect(document.body.querySelector('[data-slot="provider-keys-moved"]')).toBeNull();
  });
});

describe("the old address of the provider keys", () => {
  it("keeps the marker, and only that tab, in the search of the page", () => {
    expect(parseIntegrationsSearch({ tab: "provider-keys" })).toEqual({ tab: "provider-keys" });
    expect(parseIntegrationsSearch({ tab: "webhooks" })).toEqual({ tab: "webhooks" });
    expect(parseIntegrationsSearch({ tab: "other" })).toEqual({});
  });

  it("leads to the provider API section, or nowhere (the tenant's own keys) without a section for it", () => {
    expect(providerKeysDestination({ tab: "provider-keys" }, ["server", "provider-api"])).toBe(
      "/installation/provider-api",
    );
    expect(providerKeysDestination({ tab: "provider-keys" }, ["server"])).toBeNull();
    expect(providerKeysDestination({ tab: "webhooks" }, ["provider-api"])).toBeNull();
    expect(providerKeysDestination({}, ["provider-api"])).toBeNull();
  });
});
