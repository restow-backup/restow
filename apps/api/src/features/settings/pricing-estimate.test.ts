import { describe, expect, it } from "vitest";
import { billedBytes, pricingSchema } from "./pricing.js";
import { estimateAmount, estimateTenant, pricingEstimateQuerySchema } from "./pricing-estimate.js";
import {
  effectivePrice,
  resolveTenantOverrides,
  tenantPricingSchema,
  toTenantPricingDto,
} from "./tenant-pricing.js";

describe("estimateAmount", () => {
  it("multiplies the mailboxes and the stored bytes in the unit of the price", () => {
    const figures = { mailboxes: 12, storedBytes: 1.5e12 };
    expect(
      estimateAmount({ figures, mailboxPrice: 2.5, storagePrice: 0.02, storageUnit: "GB" }),
    ).toEqual({ mailboxes: 30, storage: 30, total: 60 });
    expect(
      estimateAmount({ figures, mailboxPrice: 2.5, storagePrice: 20, storageUnit: "TB" }),
    ).toEqual({ mailboxes: 30, storage: 30, total: 60 });
  });

  it("leaves a line out whose price is not set, and everything out when there is no price", () => {
    const figures = { mailboxes: 4, storedBytes: 2e9 };
    expect(
      estimateAmount({ figures, mailboxPrice: null, storagePrice: 1, storageUnit: "GB" }),
    ).toEqual({ mailboxes: null, storage: 2, total: 2 });
    expect(
      estimateAmount({ figures, mailboxPrice: 3, storagePrice: null, storageUnit: "GB" }),
    ).toEqual({ mailboxes: 12, storage: null, total: 12 });
    expect(
      estimateAmount({ figures, mailboxPrice: null, storagePrice: null, storageUnit: "GB" }),
    ).toEqual({ mailboxes: null, storage: null, total: null });
  });

  it("has no amount without figures, and takes a price of 0 as a price", () => {
    expect(
      estimateAmount({ figures: null, mailboxPrice: 3, storagePrice: 1, storageUnit: "GB" }),
    ).toEqual({ mailboxes: null, storage: null, total: null });
    expect(
      estimateAmount({
        figures: { mailboxes: 9, storedBytes: 5e9 },
        mailboxPrice: 0,
        storagePrice: null,
        storageUnit: "GB",
      }),
    ).toEqual({ mailboxes: 0, storage: null, total: 0 });
  });
});

describe("storage billing in blocks", () => {
  const GB = 1e9;

  it("rounds the stored bytes up to full 100 GB or TB, and leaves 0 at 0", () => {
    expect(billedBytes(0, "block_100gb")).toBe(0);
    expect(billedBytes(0, "block_1tb")).toBe(0);
    expect(billedBytes(1, "block_100gb")).toBe(100 * GB);
    expect(billedBytes(100 * GB, "block_100gb")).toBe(100 * GB);
    expect(billedBytes(100.000000001 * GB, "block_100gb")).toBe(200 * GB);
    expect(billedBytes(1240 * GB, "block_1tb")).toBe(2000 * GB);
    expect(billedBytes(1000 * GB, "block_1tb")).toBe(1000 * GB);
    expect(billedBytes(1240 * GB, "exact")).toBe(1240 * GB);
  });

  it("prices the billed amount in the unit of the price, whatever the block", () => {
    const figures = { mailboxes: 0, storedBytes: 1240 * GB };
    expect(
      estimateAmount({
        figures,
        mailboxPrice: null,
        storagePrice: 15,
        storageUnit: "TB",
        storageBilling: "block_1tb",
      }),
    ).toEqual({ mailboxes: null, storage: 30, total: 30 });
    expect(
      estimateAmount({
        figures,
        mailboxPrice: null,
        storagePrice: 0.01,
        storageUnit: "GB",
        storageBilling: "block_100gb",
      }).storage,
    ).toBeCloseTo(13, 10);
    expect(
      estimateAmount({
        figures: { mailboxes: 0, storedBytes: 0 },
        mailboxPrice: null,
        storagePrice: 15,
        storageUnit: "TB",
        storageBilling: "block_1tb",
      }),
    ).toEqual({ mailboxes: null, storage: 0, total: 0 });
  });

  it("carries the billed bytes next to the stored ones, for a tenant's own price as well", () => {
    const entry = estimateTenant({
      row: { id: "t1", name: "Alpha", kind: "customer" },
      overrides: { mailboxPrice: null, storagePrice: 20 },
      pricing: {
        mailboxPrice: null,
        storagePrice: 15,
        storageUnit: "TB",
        storageBilling: "block_1tb",
      },
      figures: { mailboxes: 0, storedBytes: 1240 * GB },
    });
    expect(entry).toMatchObject({ storedBytes: 1240 * GB, billedBytes: 2000 * GB });
    expect(entry.amount.storage).toBe(40);
  });

  it("accepts the three ways and nothing else", () => {
    for (const storageBilling of ["exact", "block_100gb", "block_1tb"]) {
      expect(pricingSchema.safeParse({ storageBilling }).success).toBe(true);
    }
    expect(pricingSchema.safeParse({ storageBilling: "block_1gb" }).success).toBe(false);
  });
});

describe("estimateTenant", () => {
  const row = { id: "t1", name: "Alpha", kind: "customer" as const };
  const pricing = { mailboxPrice: 2, storagePrice: 0.1, storageUnit: "GB" as const };

  it("takes the installation's prices for a tenant without prices of its own", () => {
    const entry = estimateTenant({
      row,
      overrides: { mailboxPrice: null, storagePrice: null },
      pricing,
      figures: { mailboxes: 10, storedBytes: 100e9 },
    });
    expect(entry).toMatchObject({
      tenantId: "t1",
      mailboxPrice: 2,
      storagePrice: 0.1,
      overridden: { mailbox: false, storage: false },
      amount: { mailboxes: 20, storage: 10, total: 30 },
    });
  });

  it("takes the tenant's own price where it has one, a free one (0) included", () => {
    const entry = estimateTenant({
      row,
      overrides: { mailboxPrice: 1.5, storagePrice: 0 },
      pricing,
      figures: { mailboxes: 10, storedBytes: 100e9 },
    });
    expect(entry).toMatchObject({
      mailboxPrice: 1.5,
      storagePrice: 0,
      overridden: { mailbox: true, storage: true },
      amount: { mailboxes: 15, storage: 0, total: 15 },
    });
  });

  it("keeps the figures null when they are not available", () => {
    const entry = estimateTenant({
      row,
      overrides: { mailboxPrice: null, storagePrice: null },
      pricing,
      figures: null,
    });
    expect(entry).toMatchObject({
      mailboxes: null,
      storedBytes: null,
      amount: { mailboxes: null, storage: null, total: null },
    });
  });
});

describe("tenant prices", () => {
  it("reads only prices from what is stored", () => {
    expect(resolveTenantOverrides({})).toEqual({ mailboxPrice: null, storagePrice: null });
    expect(resolveTenantOverrides({ mailboxPrice: 0, storagePrice: 3 })).toEqual({
      mailboxPrice: 0,
      storagePrice: 3,
    });
    expect(
      resolveTenantOverrides({
        mailboxPrice: -1,
        storagePrice: "5" as unknown as number,
      }),
    ).toEqual({ mailboxPrice: null, storagePrice: null });
    expect(effectivePrice(0, 5)).toBe(0);
    expect(effectivePrice(null, 5)).toBe(5);
  });

  it("accepts a price, null and nothing, with the limits of the installation's price", () => {
    expect(tenantPricingSchema.safeParse({ mailboxPrice: 1.25, storagePrice: null }).success).toBe(
      true,
    );
    expect(tenantPricingSchema.safeParse({}).success).toBe(true);
    expect(tenantPricingSchema.safeParse({ mailboxPrice: -1 }).success).toBe(false);
    expect(tenantPricingSchema.safeParse({ storagePrice: 0.12345 }).success).toBe(false);
    expect(tenantPricingSchema.safeParse({ currency: "CHF" }).success).toBe(false);
  });

  it("reports no overrides while the gate is closed, whatever is stored", () => {
    const global = {
      currency: "EUR",
      storagePrice: 0.1,
      storageUnit: "GB" as const,
      storageBilling: "exact" as const,
      mailboxPrice: 2,
    };
    const stored = { mailboxPrice: 1 };
    expect(toTenantPricingDto("t1", global, stored, true)).toMatchObject({
      overridesEnabled: true,
      overrides: { mailboxPrice: 1, storagePrice: null },
      effective: { mailboxPrice: 1, storagePrice: 0.1 },
    });
    expect(toTenantPricingDto("t1", global, stored, false)).toMatchObject({
      overridesEnabled: false,
      overrides: { mailboxPrice: null, storagePrice: null },
      effective: { mailboxPrice: 2, storagePrice: 0.1 },
    });
  });

  it("takes only a uuid as the tenant of the estimate", () => {
    expect(pricingEstimateQuerySchema.safeParse({}).success).toBe(true);
    expect(pricingEstimateQuerySchema.safeParse({ tenant: "nope" }).success).toBe(false);
    expect(
      pricingEstimateQuerySchema.safeParse({ tenant: "6f1c2a52-6a3e-4f4a-9e0b-2f6f0f9f2f10" })
        .success,
    ).toBe(true);
  });
});
