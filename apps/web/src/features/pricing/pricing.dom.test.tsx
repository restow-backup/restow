// @vitest-environment happy-dom
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buttonByText,
  click,
  flush,
  json,
  type Mounted,
  mount,
  routedFetch,
  sessionAs,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "@/features/installation/i18n";
import "@/features/tenant-page/i18n";
import { PriceCard } from "./price-card";
import { PricingSection } from "./pricing-section";

/**
 * The provider's prices (0.4.7): the owner sets them in the installation section, the tenant
 * overview's card multiplies them with the tenant's mailboxes and stored backups. Nobody but the
 * provider sees the card, and without a price it is not there.
 */

const PRICING = { currency: "EUR", storagePrice: 0.02, storageUnit: "GB", mailboxPrice: 2.5 };

let mounted: Mounted | undefined;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

async function card(pricing: unknown, session = sessionAs({})) {
  vi.stubGlobal("fetch", routedFetch({ "GET /settings/pricing": () => json(pricing) }).mock);
  const root = createRootRoute({
    component: () => <PriceCard mailboxes={12} storedBytes={340e9} />,
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  mounted = mount(<RouterProvider router={router} />, { session });
  await flush(5);
  return mounted.container.querySelector('[data-slot="tenant-price-card"]');
}

describe("the price card", () => {
  it("shows what the tenant comes to per month, line by line", async () => {
    const shown = await card(PRICING);
    expect(shown?.textContent).toContain("€36.80 / month");
    expect(shown?.textContent).toContain("12 mailboxes × €2.50 = €30.00");
    expect(shown?.textContent).toContain("340 GB × €0.02 = €6.80");
  });

  it("is not there without a price, nor for a tenant user", async () => {
    expect(await card({ ...PRICING, storagePrice: null, mailboxPrice: null })).toBeNull();
    await mounted?.unmount();
    mounted = undefined;
    expect(await card(PRICING, sessionAs({ isProviderAdmin: false }))).toBeNull();
  });
});

describe("the price settings", () => {
  it("saves what the owner typed, a comma as the decimal sign, an empty price as none", async () => {
    const { mock, requests } = routedFetch({
      "GET /settings/pricing": () =>
        json({ currency: "EUR", storagePrice: null, storageUnit: "GB", mailboxPrice: null }),
      "PUT /settings/pricing": (request) => json({ ...PRICING, ...request.body }),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<PricingSection />, { session: sessionAs({}) });
    await flush(5);
    const inputs = mounted.container.querySelectorAll("input");
    await type(inputs[0], "2,5");
    await type(inputs[1], "abc");
    expect(mounted.container.textContent).toContain("Please enter a price such as 2.50");
    expect(buttonByText(mounted.container, "Save")?.disabled).toBe(true);
    await type(inputs[1], "");
    await click(buttonByText(mounted.container, "Save"));
    await flush(5);
    expect(requests.filter((request) => request.method === "PUT").map((r) => r.body)).toEqual([
      { currency: "EUR", storageUnit: "GB", storagePrice: null, mailboxPrice: 2.5 },
    ]);
  });

  it("is read-only below the owner", async () => {
    vi.stubGlobal("fetch", routedFetch({ "GET /settings/pricing": () => json(PRICING) }).mock);
    mounted = mount(<PricingSection />, {
      session: sessionAs({ providerRole: "technician" }),
    });
    await flush(5);
    expect(mounted.container.querySelector("input")?.disabled).toBe(true);
    expect(mounted.container.textContent).toContain("Only the owner of the installation");
  });
});
