import { describe, expect, it } from "vitest";

import type { Pricing } from "./api.js";
import { formatMoney, priceEstimate } from "./presenters.js";

const pricing = (over: Partial<Pricing> = {}): Pricing => ({
  currency: "EUR",
  storagePrice: null,
  storageUnit: "GB",
  mailboxPrice: null,
  ...over,
});

describe("priceEstimate", () => {
  it("multiplies the mailboxes and the stored decimal gigabytes or terabytes", () => {
    expect(priceEstimate(pricing({ mailboxPrice: 2.5, storagePrice: 0.02 }), 12, 340e9)).toEqual({
      mailboxes: { quantity: 12, price: 2.5, amount: 30 },
      storage: { quantity: 340, price: 0.02, amount: 6.8, unit: "GB" },
      total: 36.8,
    });
    const tb = priceEstimate(pricing({ storagePrice: 20, storageUnit: "TB" }), 3, 1.5e12);
    expect(tb?.storage).toMatchObject({ quantity: 1.5, amount: 30, unit: "TB" });
    expect(tb?.mailboxes).toBeNull();
    expect(tb?.total).toBe(30);
  });

  it("leaves out what has no price or no figure, and is null when nothing remains", () => {
    expect(priceEstimate(pricing(), 12, 1e9)).toBeNull();
    expect(priceEstimate(undefined, 12, 1e9)).toBeNull();
    expect(priceEstimate(pricing({ mailboxPrice: 2 }), null, 1e9)).toBeNull();
    expect(priceEstimate(pricing({ mailboxPrice: 2, storagePrice: 1 }), 0, null)).toEqual({
      mailboxes: { quantity: 0, price: 2, amount: 0 },
      storage: null,
      total: 0,
    });
  });
});

describe("formatMoney", () => {
  it("shows a fraction of a cent for small prices", () => {
    expect(formatMoney(36.8, "EUR", "de")).toBe("36,80 €");
    expect(formatMoney(0.025, "EUR", "en")).toBe("€0.025");
  });
});
