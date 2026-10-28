import type { Pricing } from "./api.js";

const UNIT_BYTES = { GB: 1e9, TB: 1e12 } as const;

export interface PriceLine {
  /** Mailboxes, or the stored amount in the price's unit. */
  quantity: number;
  price: number;
  amount: number;
}

export interface PriceEstimate {
  mailboxes: PriceLine | null;
  storage: (PriceLine & { unit: "GB" | "TB" }) | null;
  total: number;
}

/**
 * What a tenant comes to per month at the provider's prices: its protected mailboxes times the
 * mailbox price, its stored bytes (decimal GB or TB) times the storage price. A price that is not
 * set, or a figure that is unknown, leaves its line out; null when no line remains.
 */
export function priceEstimate(
  pricing: Pricing | undefined,
  mailboxes: number | null,
  storedBytes: number | null,
): PriceEstimate | null {
  if (!pricing) {
    return null;
  }
  const mailboxLine =
    pricing.mailboxPrice !== null && mailboxes !== null
      ? {
          quantity: mailboxes,
          price: pricing.mailboxPrice,
          amount: mailboxes * pricing.mailboxPrice,
        }
      : null;
  const quantity = storedBytes !== null ? storedBytes / UNIT_BYTES[pricing.storageUnit] : null;
  const storageLine =
    pricing.storagePrice !== null && quantity !== null
      ? {
          quantity,
          price: pricing.storagePrice,
          amount: quantity * pricing.storagePrice,
          unit: pricing.storageUnit,
        }
      : null;
  if (!mailboxLine && !storageLine) {
    return null;
  }
  return {
    mailboxes: mailboxLine,
    storage: storageLine,
    total: (mailboxLine?.amount ?? 0) + (storageLine?.amount ?? 0),
  };
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
