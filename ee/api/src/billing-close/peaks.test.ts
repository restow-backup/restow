import { describe, expect, it } from "vitest";
import { resolvePricing } from "../../../../apps/api/src/features/settings/pricing.js";
import {
  type ClosingTenantRow,
  closeTenant,
  monthEndPrices,
  peaksOf,
  periodTotal,
  pricesInForce,
} from "./peaks.js";

const UNITS = { servers: 0, clients: 0, vms: 0, containers: 0, fileShares: 0 };

const row = (over: Partial<ClosingTenantRow> = {}): ClosingTenantRow => ({
  id: "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f",
  name: "Contoso",
  kind: "customer",
  status: "active",
  customerNumber: "K-1001",
  pricing: {},
  ...over,
});

describe("the peak of a month", () => {
  it("takes the highest daily quantity of each line and the first day it was reached", () => {
    const peaks = peaksOf([
      { day: "2026-10-03", quantities: { mailboxes: 12, storedBytes: 5e9, ...UNITS, servers: 2 } },
      { day: "2026-10-01", quantities: { mailboxes: 10, storedBytes: 9e9, ...UNITS, servers: 1 } },
      { day: "2026-10-02", quantities: { mailboxes: 12, storedBytes: 7e9, ...UNITS, servers: 3 } },
      { day: "2026-10-04", quantities: { mailboxes: 8, storedBytes: 1e9, ...UNITS, servers: 3 } },
    ]);
    expect(peaks.figures).toMatchObject({ mailboxes: 12, storedBytes: 9e9 });
    expect(peaks.figures?.units?.servers).toBe(3);
    // The peak of 12 mailboxes was first reached on the 2nd, not the 3rd.
    expect(peaks.peakDates).toMatchObject({
      mailboxes: "2026-10-02",
      storedBytes: "2026-10-01",
      servers: "2026-10-02",
    });
    expect(peaks.sampledDays).toBe(4);
  });

  it("has no figures without a sample", () => {
    expect(peaksOf([])).toEqual({ figures: null, peakDates: {}, sampledDays: 0 });
  });
});

describe("the close of one tenant", () => {
  const pricing = resolvePricing({
    currency: "EUR",
    mailboxPrice: 2,
    storagePrice: 10,
    storageUnit: "TB",
    storageBilling: "block_1tb",
    serverPrice: 25,
  });

  it("bills the peaks at the prices of the close, in the shape of GET /provider/billing", () => {
    const closed = closeTenant({
      row: row(),
      samples: [
        { day: "2026-10-01", quantities: { mailboxes: 10, storedBytes: 0.4e12, ...UNITS } },
        // Created mid-month: the first server appears on the 20th.
        {
          day: "2026-10-20",
          quantities: { mailboxes: 9, storedBytes: 1.2e12, ...UNITS, servers: 1 },
        },
      ],
      pricing,
      overridesEnabled: false,
    });
    expect(closed.lines).toEqual([
      {
        type: "mailboxes",
        quantity: 10,
        unit: "mailbox",
        unitPrice: 2,
        priceSource: "installation",
        amount: 20,
        peakDate: "2026-10-01",
      },
      // 1.2 TB stored, billed in full blocks of 1 TB: 2 TB.
      {
        type: "storage",
        quantity: 2,
        unit: "TB",
        unitPrice: 10,
        priceSource: "installation",
        amount: 20,
        peakDate: "2026-10-20",
      },
      {
        type: "servers",
        quantity: 1,
        unit: "unit",
        unitPrice: 25,
        priceSource: "installation",
        amount: 25,
        peakDate: "2026-10-20",
      },
    ]);
    expect(closed.total).toBe(65);
    expect(closed.complete).toBe(true);
    expect(closed.sampledDays).toBe(2);
    expect(closed.customerNumber).toBe("K-1001");
  });

  it("takes the tenant's own price only while the installation offers them", () => {
    const own = row({ pricing: { mailboxPrice: 1.5 } });
    const samples = [{ day: "2026-10-05", quantities: { mailboxes: 4, storedBytes: 0, ...UNITS } }];
    const withOwn = closeTenant({ row: own, samples, pricing, overridesEnabled: true });
    expect(withOwn.lines[0]).toMatchObject({ unitPrice: 1.5, priceSource: "tenant", amount: 6 });
    const without = closeTenant({ row: own, samples, pricing, overridesEnabled: false });
    expect(without.lines[0]).toMatchObject({ unitPrice: 2, priceSource: "installation" });
  });

  it("lists a tenant without any price without lines and total", () => {
    const closed = closeTenant({
      row: row({ customerNumber: null }),
      samples: [{ day: "2026-10-05", quantities: { mailboxes: 4, storedBytes: 0, ...UNITS } }],
      pricing: resolvePricing({}),
      overridesEnabled: false,
    });
    expect(closed).toMatchObject({ lines: [], total: null, complete: true, customerNumber: null });
  });

  it("leaves the own organisation and tenants without a total out of the month's total", () => {
    expect(
      periodTotal([
        { kind: "customer", total: 10 },
        { kind: "internal", total: 99 },
        { kind: "customer", total: null },
        { kind: "customer", total: 5.5 },
      ]),
    ).toBe(15.5);
    expect(periodTotal([{ kind: "internal", total: 3 }])).toBeNull();
  });
});

describe("the prices of the month's end", () => {
  const atEnd = resolvePricing({ currency: "EUR", mailboxPrice: 3, serverPrice: 20 });
  const atClose = resolvePricing({ currency: "CHF", mailboxPrice: 9, serverPrice: 99 });

  it("records per line the price in force and its source", () => {
    const prices = pricesInForce({
      pricing: atEnd,
      own: { mailboxPrice: 1.5 },
      overridesEnabled: true,
    });
    expect(prices.lines).toEqual({
      mailboxes: { unitPrice: 1.5, source: "tenant" },
      servers: { unitPrice: 20, source: "installation" },
    });
    expect(prices.installation).toMatchObject({ mailboxPrice: 3, serverPrice: 20, vmPrice: null });
    // The gate closed: the tenant's own price does not apply.
    expect(
      pricesInForce({ pricing: atEnd, own: { mailboxPrice: 1.5 }, overridesEnabled: false }).lines
        .mailboxes,
    ).toEqual({ unitPrice: 3, source: "installation" });
  });

  it("bills the last sample's prices, not those of a late close", () => {
    const early = pricesInForce({
      pricing: resolvePricing({ mailboxPrice: 2 }),
      own: {},
      overridesEnabled: false,
    });
    const last = pricesInForce({
      pricing: atEnd,
      own: { mailboxPrice: 1.5 },
      overridesEnabled: true,
    });
    const samples = [
      {
        day: "2026-09-30",
        quantities: { mailboxes: 4, storedBytes: 0, ...UNITS, servers: 1 },
        prices: last,
      },
      { day: "2026-09-02", quantities: { mailboxes: 6, storedBytes: 0, ...UNITS }, prices: early },
    ];
    expect(monthEndPrices(samples)?.day).toBe("2026-09-30");
    const closed = closeTenant({ row: row(), samples, pricing: atClose, overridesEnabled: false });
    expect(closed.lines).toEqual([
      expect.objectContaining({
        type: "mailboxes",
        quantity: 6,
        unitPrice: 1.5,
        priceSource: "tenant",
        amount: 9,
      }),
      expect.objectContaining({ type: "servers", unitPrice: 20, priceSource: "installation" }),
    ]);
    expect(closed.total).toBe(29);
  });
});
