import { apiFetch } from "@/lib/api";

/** The provider's prices per month (apps/api settings/pricing.ts); nothing bills them. */
export interface Pricing {
  /** ISO 4217 code: EUR, CHF, USD or GBP. */
  currency: string;
  storagePrice: number | null;
  /** Decimal units: 1 GB = 10^9 bytes, 1 TB = 10^12 bytes. */
  storageUnit: "GB" | "TB";
  mailboxPrice: number | null;
}

export const PRICING_CURRENCIES = ["EUR", "CHF", "USD", "GBP"] as const;

export const pricingKey = ["installation", "pricing"] as const;

export const fetchPricing = () => apiFetch<Pricing>("/settings/pricing");

export const savePricing = (input: Partial<Pricing>) =>
  apiFetch<Pricing>("/settings/pricing", { method: "PUT", body: input });
