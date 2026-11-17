import type {
  BillingClosedLine,
  BillingSamplePrices,
  BillingSampleQuantities,
  TenantKind,
  TenantPricing,
} from "@restow/db";
import {
  type PriceKey,
  type PricingDto,
  UNIT_LINES,
} from "../../../../apps/api/src/features/settings/pricing.js";
import {
  estimateTenant,
  type TenantFigures,
} from "../../../../apps/api/src/features/settings/pricing-estimate.js";
import {
  globalPriceSet,
  NO_OVERRIDES,
  resolveTenantOverrides,
  type TenantPriceOverridesDto,
} from "../../../../apps/api/src/features/settings/tenant-pricing.js";
import { BILLING_LINE_TYPES, type BillingLineType, billingLines } from "../provider-api/billing.js";

/**
 * The close of one tenant's month, pure (docs/ARCHITECTURE.md, "Monatsabschluss der Abrechnung"):
 * the peak of every quantity over the month's daily samples, then the lines and the total with
 * the estimate's own functions (`estimateTenant`, `billingLines`) at the prices of the month's
 * end, the ones the tenant's last sample of the month recorded, so a closed month counts and
 * prices exactly as GET /provider/billing did on its last day, whenever the close runs.
 */

/** The price key of each billed line. */
export const LINE_PRICE_KEY: Readonly<Record<BillingLineType, PriceKey>> = {
  mailboxes: "mailboxPrice",
  storage: "storagePrice",
  ...(Object.fromEntries(UNIT_LINES.map((line) => [line.key, line.price])) as Record<
    (typeof UNIT_LINES)[number]["key"],
    PriceKey
  >),
};

/** The prices in force for a tenant now, as a sample records them (pure). */
export function pricesInForce(input: {
  pricing: PricingDto;
  /** The tenant's own prices (`tenants.pricing`). */
  own: TenantPricing;
  /** The gate `tenants.additional`: whether its own prices apply. */
  overridesEnabled: boolean;
}): BillingSamplePrices {
  const { pricing, overridesEnabled } = input;
  const overrides = overridesEnabled ? resolveTenantOverrides(input.own) : NO_OVERRIDES;
  const lines: BillingSamplePrices["lines"] = {};
  for (const type of BILLING_LINE_TYPES) {
    const key = LINE_PRICE_KEY[type];
    const own = overrides[key];
    const installation = pricing[key];
    if (own !== null) {
      lines[type] = { unitPrice: own, source: "tenant" };
    } else if (installation !== null) {
      lines[type] = { unitPrice: installation, source: "installation" };
    }
  }
  return {
    currency: pricing.currency,
    storageUnit: pricing.storageUnit,
    storageBilling: pricing.storageBilling,
    perTenantOverrides: overridesEnabled,
    installation: { ...globalPriceSet(pricing) },
    lines,
  };
}

/**
 * The installation's prices and the tenant's own ones as a sample recorded them, in the shape the
 * estimate takes: a line priced by the tenant is an override, one priced by the installation the
 * installation's price (pure).
 */
export function pricingOfSample(prices: BillingSamplePrices): {
  pricing: PricingDto;
  overrides: TenantPriceOverridesDto;
} {
  const pricing = {
    currency: prices.currency,
    storageUnit: prices.storageUnit,
    storageBilling: prices.storageBilling,
  } as PricingDto;
  const overrides = { ...NO_OVERRIDES };
  for (const type of BILLING_LINE_TYPES) {
    const key = LINE_PRICE_KEY[type];
    const line = prices.lines[type];
    if (!line) {
      // No price applied that day: neither the installation's nor an own one.
      pricing[key] = null;
      overrides[key] = null;
    } else if (line.source === "tenant") {
      pricing[key] = prices.installation[key] ?? null;
      overrides[key] = line.unitPrice;
    } else {
      pricing[key] = line.unitPrice;
      overrides[key] = null;
    }
  }
  return { pricing, overrides };
}

/** The quantities a sample holds, in the order of the lines. */
export const SAMPLED_QUANTITIES = [
  "mailboxes",
  "storedBytes",
  ...UNIT_LINES.map((line) => line.key),
] as const;
export type SampledQuantity = (typeof SAMPLED_QUANTITIES)[number];

/** The sampled quantity a billing line is priced on. */
export function quantityOfLine(type: BillingLineType): SampledQuantity {
  return type === "storage" ? "storedBytes" : type;
}

export interface DaySample {
  day: string;
  quantities: BillingSampleQuantities;
  /** The prices in force that day; absent on samples written before they were recorded. */
  prices?: BillingSamplePrices | null;
}

/** The prices of the month's end: those of the latest sample that recorded them, or null. */
export function monthEndPrices(samples: readonly DaySample[]): {
  day: string;
  prices: BillingSamplePrices;
} | null {
  let latest: { day: string; prices: BillingSamplePrices } | null = null;
  for (const sample of samples) {
    if (sample.prices && (latest === null || sample.day > latest.day)) {
      latest = { day: sample.day, prices: sample.prices };
    }
  }
  return latest;
}

export interface Peaks {
  /** The highest quantity of each line, as figures for the estimate; null without samples. */
  figures: TenantFigures | null;
  /** The first day each peak was reached; absent for a quantity no sample holds. */
  peakDates: Partial<Record<SampledQuantity, string>>;
  /** Days with a sample. */
  sampledDays: number;
}

/** The peak of every quantity over `samples` (any order). */
export function peaksOf(samples: readonly DaySample[]): Peaks {
  const ordered = [...samples].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const peak: Partial<Record<SampledQuantity, number>> = {};
  const peakDates: Partial<Record<SampledQuantity, string>> = {};
  for (const sample of ordered) {
    for (const key of SAMPLED_QUANTITIES) {
      const value = sample.quantities[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        continue;
      }
      const current = peak[key];
      // Strictly higher: the first day the peak was reached keeps it.
      if (current === undefined || value > current) {
        peak[key] = value;
        peakDates[key] = sample.day;
      }
    }
  }
  if (ordered.length === 0) {
    return { figures: null, peakDates, sampledDays: 0 };
  }
  const units = Object.fromEntries(UNIT_LINES.map((line) => [line.key, peak[line.key] ?? 0]));
  return {
    figures: {
      mailboxes: peak.mailboxes ?? 0,
      storedBytes: peak.storedBytes ?? 0,
      units: units as unknown as NonNullable<TenantFigures["units"]>,
    },
    peakDates,
    sampledDays: new Set(ordered.map((sample) => sample.day)).size,
  };
}

/** A tenant as the close reads it from `tenants`. */
export interface ClosingTenantRow {
  id: string;
  name: string;
  kind: TenantKind;
  status: "active" | "suspended" | "deleting";
  customerNumber: string | null;
  pricing: TenantPricing;
}

export interface ClosedTenant {
  tenantId: string;
  name: string;
  customerNumber: string | null;
  kind: TenantKind;
  status: ClosingTenantRow["status"];
  complete: boolean;
  sampledDays: number;
  lines: BillingClosedLine[];
  total: number | null;
}

/**
 * One tenant's closed month from its samples, at the prices its last sample of the month
 * recorded. `pricing` and `overridesEnabled` are the prices at the close: only for samples
 * written before the prices were recorded with them.
 */
export function closeTenant(input: {
  row: ClosingTenantRow;
  samples: readonly DaySample[];
  pricing: PricingDto;
  /** The gate `tenants.additional` at the close: whether the tenant's own prices apply. */
  overridesEnabled: boolean;
}): ClosedTenant {
  const { row, samples } = input;
  const peaks = peaksOf(samples);
  const recorded = monthEndPrices(samples);
  const { pricing, overrides } = recorded
    ? pricingOfSample(recorded.prices)
    : {
        pricing: input.pricing,
        overrides: input.overridesEnabled ? resolveTenantOverrides(row.pricing) : NO_OVERRIDES,
      };
  const entry = estimateTenant({ row, overrides, pricing, figures: peaks.figures });
  const lines: BillingClosedLine[] = billingLines(entry, pricing.storageUnit).map((line) => ({
    ...line,
    peakDate: peaks.peakDates[quantityOfLine(line.type)] ?? samples[0]?.day ?? "",
  }));
  const priced =
    entry.mailboxPrice !== null ||
    entry.storagePrice !== null ||
    UNIT_LINES.some((line) => entry[line.price] !== null);
  return {
    tenantId: row.id,
    name: row.name,
    customerNumber: row.customerNumber,
    kind: row.kind,
    status: row.status,
    complete: !priced || entry.amount.total !== null,
    sampledDays: peaks.sampledDays,
    lines,
    total: entry.amount.total,
  };
}

/** The customers' totals added up (not `internal`); null when none has one. */
export function periodTotal(
  closed: readonly Pick<ClosedTenant, "kind" | "total">[],
): number | null {
  const totals = closed.flatMap((tenant) =>
    tenant.kind === "internal" || tenant.total === null ? [] : [tenant.total],
  );
  return totals.length > 0 ? totals.reduce((sum, amount) => sum + amount, 0) : null;
}
