import { describe, expect, it } from "vitest";

import {
  formatMoney,
  formatQuantity,
  parsePrice,
  priceText,
  tenantPriceView,
  tenantsWithOwnPrices,
  topTenants,
} from "./presenters.js";
import { ACME, BERG, estimateFixture, estimateTenant, noPriceEstimate } from "./testing.js";

describe("tenantPriceView", () => {
  it("turns the server's amounts into a total and a line per price", () => {
    expect(tenantPriceView(estimateFixture(), ACME)).toEqual({
      kind: "ready",
      total: 36.8,
      mailboxes: { quantity: 12, price: 2.5, amount: 30 },
      storage: { quantity: 340, price: 0.02, amount: 6.8, unit: "GB", billed: null },
      custom: false,
    });
  });

  it("names the stored GB and the billed quantity when the installation bills in blocks", () => {
    const estimate = estimateFixture({
      storageUnit: "GB",
      storageBilling: "block_100gb",
      tenants: [
        estimateTenant({
          storedBytes: 340e9,
          billedBytes: 400e9,
          amount: { mailboxes: 30, storage: 8, total: 38 },
        }),
      ],
    });
    expect(tenantPriceView(estimate, ACME)).toMatchObject({
      storage: { billed: { storedGb: 340, quantity: 400 }, amount: 8 },
    });
    // Nothing stored is billed as nothing.
    const none = estimateFixture({
      storageUnit: "TB",
      storageBilling: "block_1tb",
      tenants: [
        estimateTenant({
          storedBytes: 0,
          billedBytes: 0,
          storagePrice: 15,
          amount: { mailboxes: 30, storage: 0, total: 30 },
        }),
      ],
    });
    expect(tenantPriceView(none, ACME)).toMatchObject({
      storage: { billed: { storedGb: 0, quantity: 0 }, amount: 0 },
    });
  });

  it("shows the stored amount in terabytes for a TB price", () => {
    const estimate = estimateFixture({
      storageUnit: "TB",
      tenants: [
        estimateTenant({
          mailboxPrice: null,
          mailboxes: 3,
          storedBytes: 1.5e12,
          storagePrice: 20,
          amount: { mailboxes: null, storage: 30, total: 30 },
        }),
      ],
    });
    expect(tenantPriceView(estimate, ACME)).toMatchObject({
      kind: "ready",
      total: 30,
      mailboxes: null,
      storage: { quantity: 1.5, unit: "TB", amount: 30 },
    });
  });

  it("marks a tenant whose own price applies", () => {
    const estimate = estimateFixture({
      tenants: [estimateTenant({ overridden: { mailbox: false, storage: true } })],
    });
    expect(tenantPriceView(estimate, ACME)).toMatchObject({ kind: "ready", custom: true });
  });

  it("tells a price without figures from no price at all", () => {
    const unavailable = estimateFixture({
      tenants: [
        estimateTenant({
          mailboxes: null,
          storedBytes: null,
          amount: { mailboxes: null, storage: null, total: null },
        }),
      ],
      total: null,
      missing: 1,
    });
    expect(tenantPriceView(unavailable, ACME)).toEqual({ kind: "unavailable", custom: false });
    expect(tenantPriceView(noPriceEstimate(), ACME)).toEqual({ kind: "none" });
    expect(tenantPriceView(estimateFixture(), BERG)).toEqual({ kind: "none" });
  });

  it("keeps a price of 0 a price", () => {
    const estimate = estimateFixture({
      tenants: [
        estimateTenant({
          mailboxPrice: 0,
          storagePrice: null,
          amount: { mailboxes: 0, storage: null, total: 0 },
        }),
      ],
    });
    expect(tenantPriceView(estimate, ACME)).toMatchObject({ kind: "ready", total: 0 });
  });
});

describe("topTenants", () => {
  const tenant = (n: number, total: number | null, kind: "customer" | "internal" = "customer") =>
    estimateTenant({
      tenantId: `t${n}`,
      name: `Tenant ${n}`,
      kind,
      amount: { mailboxes: total, storage: null, total },
    });

  it("lists the five highest customers and counts the rest", () => {
    const estimate = estimateFixture({
      tenants: [1, 2, 3, 4, 5, 6, 7].map((n) => tenant(n, n * 10)),
    });
    const { top, more } = topTenants(estimate, 5);
    expect(top.map((entry) => entry.name)).toEqual([
      "Tenant 7",
      "Tenant 6",
      "Tenant 5",
      "Tenant 4",
      "Tenant 3",
    ]);
    expect(more).toBe(2);
  });

  it("leaves out the own organisation and tenants without an amount", () => {
    const estimate = estimateFixture({
      tenants: [tenant(1, 5), tenant(2, null), tenant(3, 99, "internal")],
    });
    expect(topTenants(estimate, 5)).toMatchObject({ top: [{ name: "Tenant 1" }], more: 0 });
  });
});

describe("tenantsWithOwnPrices", () => {
  it("returns the tenants with a price of their own, either one", () => {
    const estimate = estimateFixture({
      tenants: [
        estimateTenant({ tenantId: ACME, name: "Acme" }),
        estimateTenant({
          tenantId: BERG,
          name: "Berg",
          overridden: { mailbox: true, storage: false },
        }),
      ],
    });
    expect(tenantsWithOwnPrices(estimate).map((tenant) => tenant.name)).toEqual(["Berg"]);
  });
});

describe("formatMoney", () => {
  it("shows a fraction of a cent for small prices", () => {
    expect(formatMoney(36.8, "EUR", "de")).toBe("36,80\u00a0€");
    expect(formatMoney(0.025, "EUR", "en")).toBe("€0.025");
  });
});

describe("formatQuantity", () => {
  it("rounds a stored amount to whole units from a hundred up", () => {
    expect(formatQuantity(340, "en")).toBe("340");
    expect(formatQuantity(1.5, "en")).toBe("1.5");
    expect(formatQuantity(1234.56, "en")).toBe("1,235");
  });
});

describe("parsePrice and priceText", () => {
  it("reads a typed price, a comma as the decimal sign, empty as none, anything else as invalid", () => {
    expect(parsePrice("2,50")).toBe(2.5);
    expect(parsePrice(" 0.0125 ")).toBe(0.0125);
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("abc")).toBeUndefined();
    expect(parsePrice("1.00001")).toBeUndefined();
    expect(parsePrice("1000001")).toBeUndefined();
  });

  it("writes a price the way it is typed again", () => {
    expect(priceText(2.5, "en")).toBe("2.5");
    expect(priceText(null, "en")).toBe("");
  });
});
