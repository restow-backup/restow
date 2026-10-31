// @vitest-environment happy-dom
import type * as React from "react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buttonByText,
  click,
  flush,
  json,
  type Mounted,
  mount,
  problem,
  routedFetch,
  sessionAs,
  type,
  waitFor,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "@/features/installation/i18n";
import "./i18n";
import { AllTenantsPriceCard } from "./all-tenants-price-card";
import type { PricingEstimate } from "./api";
import { PriceCard } from "./price-card";
import { PricingSection } from "./pricing-section";
import {
  ACME,
  BERG,
  estimateFixture,
  estimateTenant,
  noPriceEstimate,
  OWN,
  tenantPricingFixture,
} from "./testing";

/**
 * The provider's prices: the owner sets them in the installation section (0.4.7) and, where
 * tenants may have prices of their own (0.4.8), per tenant in a dialog from the price card. The
 * cards show what the server's estimate says. Nobody but the provider sees any of it, and without
 * a price the cards are not there (but "not available yet" stays on the card).
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock("@/components/ui/sonner", () => ({
  toast: Object.assign(vi.fn(), toast),
  Toaster: () => null,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      children,
      className,
    }: {
      to: string;
      children: React.ReactNode;
      className?: string;
    }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

const PRICING = { currency: "EUR", storagePrice: 0.02, storageUnit: "GB", mailboxPrice: 2.5 };

let mounted: Mounted | undefined;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Routes the estimate (and what else is given) and records the full URLs asked for. */
function api(estimate: PricingEstimate | Response, extra: Parameters<typeof routedFetch>[0] = {}) {
  const urls: string[] = [];
  const { mock, requests } = routedFetch({
    "GET /settings/pricing/estimate": () =>
      estimate instanceof Response ? estimate : json(estimate),
    ...extra,
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    return mock(input, init);
  });
  return { urls, requests };
}

/** Unmounts the mounted card (a function, so a later mount is not narrowed away). */
async function unmountCard(): Promise<void> {
  await mounted?.unmount();
  mounted = undefined;
}

const card = () => mounted?.container.querySelector('[data-slot="tenant-price-card"]') ?? null;

async function showCard(session = sessionAs({})) {
  mounted = mount(<PriceCard tenantId={ACME} tenantName="Acme" />, { session });
  await flush(5);
  return card();
}

describe("the price card", () => {
  it("asks for its tenant and shows what it comes to per month, line by line", async () => {
    const { urls } = api(estimateFixture());
    const shown = await showCard();
    expect(urls).toEqual([expect.stringContaining(`/settings/pricing/estimate?tenant=${ACME}`)]);
    expect(shown?.textContent).toContain("€36.80 / month");
    expect(shown?.textContent).toContain("12 mailboxes × €2.50 = €30.00");
    expect(shown?.textContent).toContain("340 GB × €0.02 = €6.80");
    expect(shown?.textContent).not.toContain("Custom price");
  });

  it("shows a TB price in terabytes", async () => {
    api(
      estimateFixture({
        storageUnit: "TB",
        global: { mailboxPrice: null, storagePrice: 20 },
        tenants: [
          estimateTenant({
            mailboxPrice: null,
            storagePrice: 20,
            storedBytes: 1.5e12,
            amount: { mailboxes: null, storage: 30, total: 30 },
          }),
        ],
      }),
    );
    const shown = await showCard();
    expect(shown?.textContent).toContain("€30.00 / month");
    expect(shown?.textContent).toContain("1.5 TB × €20.00 = €30.00");
  });

  it("shows what is stored and what is billed when the installation bills in started TB", async () => {
    api(
      estimateFixture({
        storageUnit: "TB",
        storageBilling: "block_1tb",
        global: { mailboxPrice: null, storagePrice: 15 },
        tenants: [
          estimateTenant({
            mailboxPrice: null,
            storagePrice: 15,
            storedBytes: 1.24e12,
            billedBytes: 2e12,
            amount: { mailboxes: null, storage: 30, total: 30 },
          }),
        ],
      }),
    );
    const shown = await showCard();
    expect(shown?.textContent).toContain("1,240 GB, billed as 2 TB × €15.00 = €30.00");
  });

  it("marks a price of the tenant's own", async () => {
    api(
      estimateFixture({
        tenants: [
          estimateTenant({
            mailboxPrice: 1.5,
            overridden: { mailbox: true, storage: false },
            amount: { mailboxes: 18, storage: 6.8, total: 24.8 },
          }),
        ],
      }),
    );
    const shown = await showCard();
    expect(shown?.textContent).toContain("Custom price");
    expect(shown?.textContent).toContain("12 mailboxes × €1.50 = €18.00");
    expect(shown?.textContent).toContain("€24.80 / month");
  });

  it("says the figures are not available yet instead of disappearing", async () => {
    api(
      estimateFixture({
        tenants: [
          estimateTenant({
            mailboxes: null,
            storedBytes: null,
            amount: { mailboxes: null, storage: null, total: null },
          }),
        ],
        total: null,
        missing: 1,
      }),
    );
    const shown = await showCard();
    expect(shown?.textContent).toContain("Figures not available yet");
    expect(shown?.textContent).not.toContain("/ month");
    expect(shown?.textContent).toContain("Adjust prices");
  });

  it("says in German that the figures are not available yet", async () => {
    await i18n.changeLanguage("de");
    try {
      api(
        estimateFixture({
          tenants: [
            estimateTenant({
              mailboxes: null,
              storedBytes: null,
              amount: { mailboxes: null, storage: null, total: null },
            }),
          ],
        }),
      );
      expect((await showCard())?.textContent).toContain("Zahlen noch nicht verfügbar");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("is not there without a price, nor for a tenant user, nor while it loads", async () => {
    api(noPriceEstimate({ perTenantOverrides: false }));
    expect(await showCard()).toBeNull();
    await unmountCard();
    api(estimateFixture());
    expect(await showCard(sessionAs({ isProviderAdmin: false }))).toBeNull();
  });

  it("shows the error with a retry when the estimate cannot be read", async () => {
    const { requests } = api(problem("urn:restow:problem:internal", 500));
    const shown = await showCard();
    expect(shown?.getAttribute("data-state")).toBe("error");
    expect(shown?.textContent).toContain("The price could not be loaded.");
    await click(buttonByText(shown as HTMLElement, /retry/i));
    await flush(3);
    expect(requests.filter((request) => request.path.endsWith("/estimate")).length).toBe(2);
  });

  it("offers the owner the tenant's prices where tenants may have their own, nobody else", async () => {
    api(estimateFixture());
    expect((await showCard())?.textContent).toContain("Prices for this tenant");
    await unmountCard();
    api(estimateFixture());
    expect(
      (await showCard(sessionAs({ providerRole: "administrator" })))?.textContent,
    ).not.toContain("Prices for this tenant");
    await unmountCard();
    api(estimateFixture({ perTenantOverrides: false }));
    expect((await showCard())?.textContent).not.toContain("Prices for this tenant");
  });

  it("lets the owner set the first price of a tenant that has none", async () => {
    api(noPriceEstimate());
    const shown = await showCard();
    expect(shown?.textContent).toContain("No price is set for this tenant yet.");
    expect(shown?.textContent).toContain("Prices for this tenant");
  });
});

describe("the editor of a tenant's prices", () => {
  async function open(pricing = tenantPricingFixture(), put?: () => Response) {
    const routes: Parameters<typeof routedFetch>[0] = {
      [`GET /tenants/${ACME}/pricing`]: () => json(pricing),
    };
    if (put) {
      routes[`PUT /tenants/${ACME}/pricing`] = put;
    }
    const calls = api(estimateFixture(), routes);
    const shown = await showCard();
    await click(buttonByText(shown as HTMLElement, "Prices for this tenant"));
    await flush(5);
    const dialog = await waitFor(
      () => document.querySelector<HTMLElement>('[data-slot="tenant-price-dialog"]'),
      { what: "the dialog" },
    );
    await flush(3);
    return { ...calls, dialog };
  }

  const inputs = (dialog: HTMLElement) => [...dialog.querySelectorAll("input")];

  it("starts from the tenant's own prices and names the installation's as the hint", async () => {
    const { dialog } = await open(
      tenantPricingFixture({ overrides: { mailboxPrice: 1.5, storagePrice: null } }),
    );
    expect(dialog.textContent).toContain("Prices for Acme");
    const [mailbox, storage] = inputs(dialog);
    expect(mailbox?.value).toBe("1.5");
    expect(storage?.value).toBe("");
    expect(mailbox?.placeholder).toBe("2.5");
    expect(storage?.placeholder).toBe("0.02");
    expect(dialog.textContent).toContain("Price per GB");
    expect(dialog.textContent).toContain("Installation price: €2.50");
    expect(dialog.textContent).toContain("Installation price: €0.02");
  });

  it("saves a price and removes the other with null, then refreshes the cards", async () => {
    const { dialog, requests } = await open(
      tenantPricingFixture({ overrides: { mailboxPrice: 1.5, storagePrice: null } }),
      () => json(tenantPricingFixture({ overrides: { mailboxPrice: 1.5, storagePrice: 0.015 } })),
    );
    expect(buttonByText(dialog, "Save")?.disabled).toBe(true);
    const [, storage] = inputs(dialog);
    await type(storage, "0,015");
    await click(buttonByText(dialog, "Save"));
    await flush(5);
    expect(requests.filter((request) => request.method === "PUT").map((r) => r.body)).toEqual([
      { mailboxPrice: 1.5, storagePrice: 0.015 },
    ]);
    // The estimate was read again, so the card shows the new price at once.
    expect(requests.filter((request) => request.path.endsWith("/estimate")).length).toBe(2);
    expect(toast.success).toHaveBeenCalledWith("Prices for Acme saved.");
    expect(document.querySelector('[data-slot="tenant-price-dialog"]')).toBeNull();
  });

  it("clears an own price with 'use installation price'", async () => {
    const { dialog, requests } = await open(
      tenantPricingFixture({ overrides: { mailboxPrice: 1.5, storagePrice: 0.015 } }),
      () => json(tenantPricingFixture()),
    );
    const buttons = [...dialog.querySelectorAll("button")].filter(
      (button) => button.textContent === "Use installation price",
    );
    expect(buttons).toHaveLength(2);
    // Each button names the price it clears for a screen reader.
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Price per mailbox: use installation price",
      "Price per GB: use installation price",
    ]);
    await click(buttons[0]);
    expect(inputs(dialog)[0]?.value).toBe("");
    await click(buttonByText(dialog, "Save"));
    await flush(5);
    expect(requests.filter((request) => request.method === "PUT").map((r) => r.body)).toEqual([
      { mailboxPrice: null, storagePrice: 0.015 },
    ]);
  });

  it("does not save a price that is none", async () => {
    const { dialog } = await open();
    await type(inputs(dialog)[0], "abc");
    expect(dialog.textContent).toContain("Please enter a price such as 2.50");
    expect(buttonByText(dialog, "Save")?.disabled).toBe(true);
    // The invalid field points at the message as well as at its hint.
    const describedby = inputs(dialog)[0]?.getAttribute("aria-describedby") ?? "";
    const message = describedby
      .split(" ")
      .map((id) => document.getElementById(id))
      .find((element) => element?.getAttribute("role") === "alert");
    expect(message?.textContent).toContain("Please enter a price such as 2.50");
  });

  it("words the description without a currency while the prices load", async () => {
    api(estimateFixture(), {
      [`GET /tenants/${ACME}/pricing`]: () =>
        problem("urn:restow:problem:internal", 500, { detail: "boom" }),
    });
    const shown = await showCard();
    await click(buttonByText(shown as HTMLElement, "Prices for this tenant"));
    await flush(5);
    const dialog = document.querySelector<HTMLElement>('[data-slot="tenant-price-dialog"]');
    expect(dialog?.textContent).toContain(
      "Prices of this tenant that differ from the installation's.",
    );
    expect(dialog?.textContent).not.toContain(", in .");
  });

  it("shows a refusal of the server in the dialog and stays open", async () => {
    const { dialog } = await open(tenantPricingFixture(), () =>
      problem("urn:restow:problem:feature-unavailable", 403, {
        detail: "Prices of their own need Service Provider.",
      }),
    );
    await type(inputs(dialog)[0], "1");
    await click(buttonByText(dialog, "Save"));
    await flush(5);
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
      "Prices of their own need Service Provider.",
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("the sum across the tenants", () => {
  const many = estimateFixture({
    tenants: [1, 2, 3, 4, 5, 6, 7].map((n) =>
      estimateTenant({
        tenantId: `t${n}`,
        name: `Tenant ${n}`,
        amount: { mailboxes: n * 10, storage: null, total: n * 10 },
      }),
    ),
    total: 280,
    missing: 0,
  });

  async function all(estimate: PricingEstimate, open = vi.fn(), session = sessionAs({})) {
    api(estimate);
    mounted = mount(<AllTenantsPriceCard onOpenTenant={open} />, { session });
    await flush(5);
    return mounted.container.querySelector('[data-widget="allTenantsPrice"]');
  }

  it("shows the total, the five highest tenants and how many more there are", async () => {
    const open = vi.fn();
    const shown = await all(many, open);
    expect(shown?.textContent).toContain("€280.00 / month");
    const names = [...(shown?.querySelectorAll("li button") ?? [])].map((b) => b.textContent);
    expect(names).toEqual(["Tenant 7", "Tenant 6", "Tenant 5", "Tenant 4", "Tenant 3"]);
    expect(shown?.textContent).toContain("+2 more");
    await click(shown?.querySelector("li button"));
    expect(open).toHaveBeenCalledWith("t7");
  });

  it("says when the figures of some tenants are missing", async () => {
    const shown = await all({ ...many, missing: 2 });
    expect(shown?.textContent).toContain("The figures of 2 tenants are not available yet.");
  });

  it("leaves the own organisation out of the list", async () => {
    const shown = await all(
      estimateFixture({
        tenants: [
          estimateTenant({ tenantId: OWN, name: "Own GmbH", kind: "internal" }),
          estimateTenant({ tenantId: BERG, name: "Berg" }),
        ],
      }),
    );
    expect(shown?.textContent).toContain("Berg");
    expect(shown?.textContent).not.toContain("Own GmbH");
  });

  it("says so when the prices could not be read, and offers a retry", async () => {
    const { requests } = api(problem("urn:restow:problem:internal", 500));
    mounted = mount(<AllTenantsPriceCard onOpenTenant={vi.fn()} />, { session: sessionAs({}) });
    await flush(5);
    const shown = mounted.container.querySelector('[data-widget="allTenantsPrice"]');
    expect(shown?.getAttribute("data-state")).toBe("error");
    expect(shown?.textContent).toContain("The prices of all tenants could not be loaded.");
    expect(shown?.querySelector("button")).not.toBeNull();
    expect(requests.length).toBeGreaterThan(0);
  });

  it("is not there without a price, nor for a tenant user", async () => {
    expect(await all(noPriceEstimate())).toBeNull();
    await unmountCard();
    expect(await all(many, vi.fn(), sessionAs({ isProviderAdmin: false }))).toBeNull();
  });
});

describe("the price settings", () => {
  it("shows nothing and asks for nothing to anybody who is not a provider admin", async () => {
    const { requests } = api(estimateFixture(), {
      "GET /settings/pricing": () => json(PRICING),
    });
    mounted = mount(<PricingSection />, { session: sessionAs({ isProviderAdmin: false }) });
    await flush(5);
    expect(mounted.container.textContent).toBe("");
    expect(requests).toHaveLength(0);
  });

  it("saves what the owner typed, a comma as the decimal sign, an empty price as none", async () => {
    const { mock, requests } = routedFetch({
      "GET /settings/pricing": () =>
        json({ currency: "EUR", storagePrice: null, storageUnit: "GB", mailboxPrice: null }),
      "GET /settings/pricing/estimate": () => json(noPriceEstimate({ perTenantOverrides: false })),
      "PUT /settings/pricing": (request) => json({ ...PRICING, ...(request.body as object) }),
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
      {
        currency: "EUR",
        storageUnit: "GB",
        storageBilling: "exact",
        storagePrice: null,
        mailboxPrice: 2.5,
      },
    ]);
    // The estimate is derived from the prices: it is read again, not served from the cache.
    expect(requests.filter((request) => request.path.endsWith("/estimate")).length).toBe(2);
  });

  it("lets the owner bill the storage in started blocks", async () => {
    const { mock, requests } = routedFetch({
      "GET /settings/pricing": () => json(PRICING),
      "GET /settings/pricing/estimate": () => json(noPriceEstimate({ perTenantOverrides: false })),
      "PUT /settings/pricing": (request) => json({ ...PRICING, ...(request.body as object) }),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<PricingSection />, { session: sessionAs({}) });
    await flush(5);
    const select = mounted.container.querySelector<HTMLSelectElement>(
      'select[id$="-billing"]',
    ) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "exact amount",
      "started blocks of 100 GB",
      "started TB",
    ]);
    expect(mounted.container.textContent).toContain("Started blocks round the stored amount up");
    await act(async () => {
      select.value = "block_1tb";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(buttonByText(mounted.container, "Save"));
    await flush(5);
    expect(requests.filter((request) => request.method === "PUT").map((r) => r.body)).toEqual([
      expect.objectContaining({ storageBilling: "block_1tb" }),
    ]);
  });

  it("stacks the currency field under its label instead of beside it", async () => {
    api(estimateFixture(), { "GET /settings/pricing": () => json(PRICING) });
    mounted = mount(<PricingSection />, { session: sessionAs({}) });
    await flush(5);
    const select = mounted.container.querySelector<HTMLSelectElement>("select[id$='-currency']");
    expect(select).not.toBeNull();
    // An inline select would sit on the label's line; the label stays above the field.
    expect(select?.classList.contains("block")).toBe(true);
    const label = mounted.container.querySelector("label[for$='-currency']");
    expect(label?.classList.contains("block")).toBe(true);
  });

  it("is read-only below the owner", async () => {
    api(estimateFixture(), { "GET /settings/pricing": () => json(PRICING) });
    mounted = mount(<PricingSection />, {
      session: sessionAs({ providerRole: "technician" }),
    });
    await flush(5);
    expect(mounted.container.querySelector("input")?.disabled).toBe(true);
    expect(mounted.container.textContent).toContain("Only the owner of the installation");
  });

  describe("the tenants with their own prices", () => {
    async function section(estimate: PricingEstimate) {
      api(estimate, { "GET /settings/pricing": () => json(PRICING) });
      mounted = mount(<PricingSection />, { session: sessionAs({}) });
      await flush(5);
      return mounted.container.querySelector('[data-slot="tenants-own-prices"]');
    }

    it("lists them with their prices and links to the tenant, with a hint where to set them", async () => {
      const shown = await section(
        estimateFixture({
          tenants: [
            estimateTenant(),
            estimateTenant({
              tenantId: BERG,
              name: "Berg",
              mailboxPrice: 1.5,
              storagePrice: 0.015,
              overridden: { mailbox: true, storage: true },
            }),
          ],
        }),
      );
      expect(shown?.textContent).toContain("Tenants with their own prices");
      expect(shown?.textContent).toContain("Berg");
      expect(shown?.textContent).toContain("€1.50 per mailbox · €0.015 per GB");
      expect(shown?.textContent).not.toContain("Acme");
      expect(shown?.querySelector("a")?.getAttribute("href")).toContain(BERG);
      expect(shown?.textContent).toContain("price card of its overview");
    });

    it("says when no tenant has one yet", async () => {
      const shown = await section(estimateFixture());
      expect(shown?.textContent).toContain("No tenant has its own prices yet.");
    });

    it("is not there where tenants cannot have prices of their own", async () => {
      expect(await section(estimateFixture({ perTenantOverrides: false }))).toBeNull();
    });
  });
});
