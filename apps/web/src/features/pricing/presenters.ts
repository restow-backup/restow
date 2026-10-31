import type { EstimateTenant, PricingEstimate } from "./api.js";

const UNIT_BYTES = { GB: 1e9, TB: 1e12 } as const;

export interface PriceLine {
  /** Mailboxes, or the stored amount in the price's unit. */
  quantity: number;
  price: number;
  amount: number;
}

/**
 * The storage line. Billed in blocks (100 GB, 1 TB), it says what is stored, in GB, and what the
 * price applies to, in the price's unit: "1,240 GB, billed as 2 TB × 15.00 € = 30.00 €".
 */
export interface StorageLine extends PriceLine {
  unit: "GB" | "TB";
  /** Set when the installation bills in blocks: the stored GB and the billed quantity. */
  billed: { storedGb: number; quantity: number } | null;
}

/** What a price card shows for one tenant. */
export type TenantPriceView =
  /** No price applies to the tenant: nothing to show (the installation has none, nor the tenant). */
  | { kind: "none" }
  /** A price applies, but the figures to multiply it with could not be read (yet). */
  | { kind: "unavailable"; custom: boolean }
  | {
      kind: "ready";
      total: number;
      mailboxes: PriceLine | null;
      storage: StorageLine | null;
      /** The tenant's own price applies to at least one line. */
      custom: boolean;
    };

/**
 * What a tenant comes to per month, from the server's estimate (apps/api settings/
 * pricing-estimate.ts is the one place that multiplies): a line per price that applies, the
 * total, and whether the tenant's own price is in it. "None" is a tenant without any price, which
 * is not the same as figures that are not available yet.
 */
export function tenantPriceView(estimate: PricingEstimate, tenantId: string): TenantPriceView {
  const entry = estimate.tenants.find((tenant) => tenant.tenantId === tenantId);
  if (!entry || (entry.mailboxPrice === null && entry.storagePrice === null)) {
    return { kind: "none" };
  }
  const custom = entry.overridden.mailbox || entry.overridden.storage;
  if (entry.amount.total === null) {
    return { kind: "unavailable", custom };
  }
  const mailboxLine =
    entry.mailboxPrice !== null && entry.mailboxes !== null && entry.amount.mailboxes !== null
      ? {
          quantity: entry.mailboxes,
          price: entry.mailboxPrice,
          amount: entry.amount.mailboxes,
        }
      : null;
  const blocks = (estimate.storageBilling ?? "exact") !== "exact";
  const storageLine: StorageLine | null =
    entry.storagePrice !== null && entry.storedBytes !== null && entry.amount.storage !== null
      ? {
          quantity: entry.storedBytes / UNIT_BYTES[estimate.storageUnit],
          price: entry.storagePrice,
          amount: entry.amount.storage,
          unit: estimate.storageUnit,
          billed: blocks
            ? {
                storedGb: entry.storedBytes / UNIT_BYTES.GB,
                quantity:
                  (entry.billedBytes ?? entry.storedBytes) / UNIT_BYTES[estimate.storageUnit],
              }
            : null,
        }
      : null;
  return {
    kind: "ready",
    total: entry.amount.total,
    mailboxes: mailboxLine,
    storage: storageLine,
    custom,
  };
}

/** The customers with an amount, the highest first: the top of the list and how many are left. */
export function topTenants(
  estimate: PricingEstimate,
  limit: number,
): { top: EstimateTenant[]; more: number } {
  const ranked = estimate.tenants
    .filter((tenant) => tenant.kind !== "internal" && tenant.amount.total !== null)
    .sort((a, b) => (b.amount.total ?? 0) - (a.amount.total ?? 0) || a.name.localeCompare(b.name));
  return { top: ranked.slice(0, limit), more: Math.max(0, ranked.length - limit) };
}

/** The tenants with a price of their own, in the order the server lists them (by name). */
export function tenantsWithOwnPrices(estimate: PricingEstimate): EstimateTenant[] {
  return estimate.tenants.filter(
    (tenant) => tenant.overridden.mailbox || tenant.overridden.storage,
  );
}

/** A price or an amount in the provider's currency, in the UI language. */
export function formatMoney(value: number, currency: string, language: string): string {
  return new Intl.NumberFormat(language, {
    style: "currency",
    currency,
    // A storage price per GB is often a fraction of a cent.
    maximumFractionDigits: value !== 0 && Math.abs(value) < 0.1 ? 4 : 2,
  }).format(value);
}

/** A stored amount in its unit: whole numbers from a hundred up, else two decimals. */
export function formatQuantity(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: value >= 100 ? 0 : 2 }).format(
    value,
  );
}

/** A price as typed ("2,50", "0.02", empty = none); undefined when it is no price. */
export function parsePrice(text: string): number | null | undefined {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") {
    return null;
  }
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) && value <= 1_000_000 ? value : undefined;
}

/** A price as the field shows it; empty for none. */
export function priceText(value: number | null, language: string): string {
  return value === null
    ? ""
    : new Intl.NumberFormat(language, { maximumFractionDigits: 4, useGrouping: false }).format(
        value,
      );
}
