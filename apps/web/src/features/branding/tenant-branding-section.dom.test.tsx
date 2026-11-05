// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TENANT } from "@/features/backup-jobs/testing";
import {
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  type Mounted,
  mount,
  routedFetch,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import type { BrandingDto, ProviderBrandingView, TenantBrandingView } from "./api";
import { TenantBrandingSection } from "./tenant-branding-section";

/**
 * The tenant page's Branding (Service Provider): closed with the edition below it; by default
 * the tenant uses the provider's branding, and switching that off opens the same form for the
 * tenant's own; switching it back on drops the override.
 */

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const EMPTY: BrandingDto = {
  senderName: null,
  fromAddress: null,
  replyTo: null,
  accentColor: null,
  onAccent: null,
  footerText: null,
  logo: null,
  updatedAt: null,
};

const PROVIDER: ProviderBrandingView = {
  available: { provider: true, tenant: true, customerReport: true },
  productName: "Restow",
  provider: { ...EMPTY, senderName: "Muster IT" },
  mail: { transport: "smtp", fromLocked: false, defaultFrom: "a@p.example", allowedSenders: [] },
  publicUrl: "https://backup.example",
  publicUrlHttps: true,
};

const base = `/tenants/${TENANT.id}/branding`;

async function open(view: TenantBrandingView, routes: Parameters<typeof routedFetch>[0] = {}) {
  const { mock, requests } = routedFetch({
    [`GET ${base}`]: () => json(view),
    "GET /settings/branding": () => json(PROVIDER),
    "GET /settings/branding/preview": () => json({ subject: "S", html: "<p>x</p>", text: "x" }),
    ...routes,
  });
  vi.stubGlobal("fetch", mock);
  mounted = mount(<TenantBrandingSection tenant={TENANT} readOnly={false} sub={null} />);
  await flush(8);
  return { requests };
}

const inheritSwitch = () =>
  document.querySelector<HTMLButtonElement>("#tenant-branding-inherit") ?? null;

describe("TenantBrandingSection", () => {
  it("shows the Service Provider lock where the edition has no tenant branding", async () => {
    await open({ available: false, inherits: true, override: null, effective: EMPTY });
    const locked = document.querySelector("[data-slot=tenant-branding-locked]");
    expect(locked?.querySelector("[data-slot=feature-locked]")?.getAttribute("data-feature")).toBe(
      "branding.tenant",
    );
    expect(inheritSwitch()).toBeNull();
  });

  it("uses the provider's branding by default and opens the form when that is switched off", async () => {
    await open({
      available: true,
      inherits: true,
      override: null,
      effective: { ...EMPTY, senderName: "Muster IT" },
    });
    expect(inheritSwitch()?.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector("[data-slot=tenant-branding-inherits]")?.textContent).toContain(
      "Muster IT",
    );
    expect(document.querySelector("[data-slot=branding-editor]")).toBeNull();
    await click(inheritSwitch());
    await flush(6);
    expect(inheritSwitch()?.getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector("[data-slot=branding-editor]")).not.toBeNull();
  });

  it("drops the tenant's own branding when the provider's is switched back on", async () => {
    const { requests } = await open(
      {
        available: true,
        inherits: false,
        override: { ...EMPTY, senderName: "Contoso IT", updatedAt: "2026-11-05T10:00:00.000Z" },
        effective: { ...EMPTY, senderName: "Contoso IT" },
      },
      {
        [`PUT ${base}`]: () =>
          json({ available: true, inherits: true, override: null, effective: PROVIDER.provider }),
      },
    );
    expect(document.querySelector<HTMLInputElement>("#branding-sender-name")?.value).toBe(
      "Contoso IT",
    );
    await click(inheritSwitch());
    await flush(6);
    expect(requests.find((request) => request.method === "PUT")).toMatchObject({
      path: base,
      body: { inherit: true },
    });
  });
});
