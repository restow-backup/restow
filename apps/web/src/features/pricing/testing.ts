import type { EstimateTenant, PricingEstimate, TenantPricing } from "./api.js";

/** Fixtures of the price tests (not part of the app bundle: nothing imports this outside tests). */

export const ACME = "11111111-1111-4111-8111-111111111111";
export const BERG = "22222222-2222-4222-8222-222222222222";
export const OWN = "33333333-3333-4333-8333-333333333333";

/** A tenant at the installation's prices (EUR, 2.50 per mailbox, 0.02 per GB): 12 mailboxes, 340 GB. */
export function estimateTenant(over: Partial<EstimateTenant> = {}): EstimateTenant {
  return {
    tenantId: ACME,
    name: "Acme",
    kind: "customer",
    mailboxes: 12,
    storedBytes: 340e9,
    mailboxPrice: 2.5,
    storagePrice: 0.02,
    overridden: { mailbox: false, storage: false },
    amount: { mailboxes: 30, storage: 6.8, total: 36.8 },
    ...over,
  };
}

export function estimateFixture(over: Partial<PricingEstimate> = {}): PricingEstimate {
  return {
    currency: "EUR",
    storageUnit: "GB",
    global: { mailboxPrice: 2.5, storagePrice: 0.02 },
    perTenantOverrides: true,
    hasPrices: true,
    tenants: [estimateTenant()],
    total: 36.8,
    missing: 0,
    ...over,
  };
}

/** An installation without any price: the server lists the tenants with nothing to multiply. */
export function noPriceEstimate(over: Partial<PricingEstimate> = {}): PricingEstimate {
  return estimateFixture({
    global: { mailboxPrice: null, storagePrice: null },
    hasPrices: false,
    tenants: [
      estimateTenant({
        mailboxes: null,
        storedBytes: null,
        mailboxPrice: null,
        storagePrice: null,
        amount: { mailboxes: null, storage: null, total: null },
      }),
    ],
    total: null,
    ...over,
  });
}

export function tenantPricingFixture(over: Partial<TenantPricing> = {}): TenantPricing {
  return {
    tenantId: ACME,
    currency: "EUR",
    storageUnit: "GB",
    overridesEnabled: true,
    global: { mailboxPrice: 2.5, storagePrice: 0.02 },
    overrides: { mailboxPrice: null, storagePrice: null },
    effective: { mailboxPrice: 2.5, storagePrice: 0.02 },
    ...over,
  };
}
