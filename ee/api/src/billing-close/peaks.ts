import type {
  BillingClosedLine,
  BillingSampleQuantities,
  TenantKind,
  TenantPricing,
} from "@restow/db";
import { type PricingDto, UNIT_LINES } from "../../../../apps/api/src/features/settings/pricing.js";
import {
  estimateTenant,
  type TenantFigures,
} from "../../../../apps/api/src/features/settings/pricing-estimate.js";
import {
  NO_OVERRIDES,
  resolveTenantOverrides,
} from "../../../../apps/api/src/features/settings/tenant-pricing.js";
import { type BillingLineType, billingLines } from "../provider-api/billing.js";

/**
 * The close of one tenant's month, pure (docs/ARCHITECTURE.md, "Monatsabschluss der Abrechnung"):
 * the peak of every quantity over the month's daily samples, then the lines and the total with
 * the estimate's own functions (`estimateTenant`, `billingLines`) at the prices of the close, so
 * a closed month counts and prices exactly as GET /provider/billing does on the day of the peak.
 */

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

/** One tenant's closed month from its samples and the prices of the close. */
export function closeTenant(input: {
  row: ClosingTenantRow;
  samples: readonly DaySample[];
  pricing: PricingDto;
  /** The gate `tenants.additional` at the close: whether the tenant's own prices apply. */
  overridesEnabled: boolean;
}): ClosedTenant {
  const { row, samples, pricing, overridesEnabled } = input;
  const peaks = peaksOf(samples);
  const overrides = overridesEnabled ? resolveTenantOverrides(row.pricing) : NO_OVERRIDES;
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
