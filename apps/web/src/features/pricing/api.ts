import { apiFetch } from "@/lib/api";

/** The provider's prices per month (apps/api settings/pricing.ts); nothing bills them. */
export interface Pricing {
  /** ISO 4217 code: EUR, CHF, USD or GBP. */
  currency: string;
  storagePrice: number | null;
  /** Decimal units: 1 GB = 10^9 bytes, 1 TB = 10^12 bytes. */
  storageUnit: "GB" | "TB";
  /**
   * How the stored bytes are counted before the storage price applies: exactly, or rounded up to
   * the next full 100 GB or TB (servers from 0.4.9; absent reads as exact).
   */
  storageBilling?: StorageBilling;
  mailboxPrice: number | null;
}

export const STORAGE_BILLING = ["exact", "block_100gb", "block_1tb"] as const;
export type StorageBilling = (typeof STORAGE_BILLING)[number];

export const PRICING_CURRENCIES = ["EUR", "CHF", "USD", "GBP"] as const;

export const pricingKey = ["installation", "pricing"] as const;

export const fetchPricing = () => apiFetch<Pricing>("/settings/pricing");

export const savePricing = (input: Partial<Pricing>) =>
  apiFetch<Pricing>("/settings/pricing", { method: "PUT", body: input });

/** What a tenant comes to per month (apps/api settings/pricing-estimate.ts). */
export interface EstimateAmount {
  mailboxes: number | null;
  storage: number | null;
  total: number | null;
}

export interface EstimateTenant {
  tenantId: string;
  name: string;
  /** `internal`: the operator's own organisation, which is no customer. */
  kind: "customer" | "internal";
  /** Protected mailboxes; null = not available (or not read: the tenant has no price). */
  mailboxes: number | null;
  /** Everything stored, in bytes; null = not available (or not read). */
  storedBytes: number | null;
  /**
   * The bytes the storage price applies to: rounded up to full blocks when the installation bills
   * so (servers from 0.4.9; absent: the stored bytes).
   */
  billedBytes?: number | null;
  /** The price that applies: the tenant's own one, else the installation's. */
  mailboxPrice: number | null;
  /** Per `storageUnit` of the estimate. */
  storagePrice: number | null;
  overridden: { mailbox: boolean; storage: boolean };
  amount: EstimateAmount;
}

export interface PricingEstimate {
  currency: string;
  storageUnit: "GB" | "TB";
  /** How the stored bytes are counted (servers from 0.4.9; absent reads as exact). */
  storageBilling?: StorageBilling;
  global: { mailboxPrice: number | null; storagePrice: number | null };
  /** Tenants may have prices of their own (the gate `tenants.additional` is open). */
  perTenantOverrides: boolean;
  /** The installation has a price, or a listed tenant has one of its own. */
  hasPrices: boolean;
  tenants: EstimateTenant[];
  /** Over the customer tenants; null when no tenant has an amount. */
  total: number | null;
  /** Customer tenants with a price whose figures are not available. */
  missing: number;
}

/** One estimate for the whole list, or for the tenant asked for. */
export const estimateKey = (tenantId?: string) =>
  [...pricingKey, "estimate", tenantId ?? "all"] as const;

export const fetchEstimate = (tenantId?: string) =>
  apiFetch<PricingEstimate>(
    tenantId
      ? `/settings/pricing/estimate?tenant=${encodeURIComponent(tenantId)}`
      : "/settings/pricing/estimate",
  );

/** The prices of one tenant (apps/api settings/tenant-pricing.ts). */
export interface TenantPricing {
  tenantId: string;
  currency: string;
  storageUnit: "GB" | "TB";
  overridesEnabled: boolean;
  global: { mailboxPrice: number | null; storagePrice: number | null };
  overrides: { mailboxPrice: number | null; storagePrice: number | null };
  effective: { mailboxPrice: number | null; storagePrice: number | null };
}

export const tenantPricingKey = (tenantId: string) => [...pricingKey, "tenant", tenantId] as const;

export const fetchTenantPricing = (tenantId: string) =>
  apiFetch<TenantPricing>(`/tenants/${encodeURIComponent(tenantId)}/pricing`);

/** A price as a number sets the tenant's own, null removes it so the installation's applies. */
export const saveTenantPricing = (
  tenantId: string,
  input: { mailboxPrice?: number | null; storagePrice?: number | null },
) =>
  apiFetch<TenantPricing>(`/tenants/${encodeURIComponent(tenantId)}/pricing`, {
    method: "PUT",
    body: input,
  });
