import type { BillingCorrectionRow } from "@restow/db";
import { z } from "zod";
import { component } from "../../../../apps/api/src/routes/v1/components.js";
import { timestampSchema, uuidSchema } from "../../../../apps/api/src/routes/v1/schemas.js";
import { localDay, nextPeriod, periodBounds, periodOfDay } from "../billing-close/period.js";
import type { LoadedPeriod, listClosedPeriods } from "../billing-close/service.js";
import {
  BILLING_LINE_TYPES,
  billingLineSchema,
  billingSchema,
  billingTenantSchema,
} from "./billing.js";

/**
 * The closed months of the billing close (0.6.0, Service Provider; docs/ARCHITECTURE.md,
 * "Monatsabschluss der Abrechnung") on the integration API:
 *
 *   GET  /provider/billing/periods                         every closed month, and the open one
 *   GET  /provider/billing/periods/{period}                one closed month, shaped like
 *                                                          GET /provider/billing
 *   POST /provider/billing/periods/{period}/corrections    a correction next to the close
 *
 * The open (current) month is never answered as a period: GET /provider/billing is its live
 * estimate, and its close comes on the 1st.
 */

export const BILLING_PERIOD_OPEN_PROBLEM = "urn:restow:problem:billing-period-open";

export const periodParamSchema = z.object({
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "A month as YYYY-MM.")
    .describe("The month, `YYYY-MM`, in the installation's time zone."),
});

const periodSchema = z.string().describe("The month, `YYYY-MM`, in the installation's time zone.");
const daySchema = z.string().describe("A day, `YYYY-MM-DD`, in the installation's time zone.");

export const billingCorrectionSchema = component(
  "BillingCorrection",
  z.object({
    id: uuidSchema,
    tenantId: uuidSchema,
    type: z
      .enum(BILLING_LINE_TYPES)
      .nullable()
      .describe("The line it corrects; null for the tenant's bill as a whole."),
    amount: z.number().describe("Signed, in the period's `currency`; added to the closed total."),
    reason: z.string(),
    createdAt: timestampSchema,
    createdBy: z.string().describe("Who entered it (the API key's audit label)."),
  }),
);
export type BillingCorrectionDto = z.infer<typeof billingCorrectionSchema>;

export const billingPeriodLineSchema = component(
  "BillingPeriodLine",
  billingLineSchema.extend({
    quantity: z
      .number()
      .describe(
        "The month's peak: the highest daily quantity (for `storage` the highest stored bytes, rounded and in `unit` as the installation said at the close).",
      ),
    unitPrice: z.number().describe("The price per `unit` in force at the close."),
    peakDate: daySchema.describe("The first day the peak was reached."),
  }),
);

export const billingPeriodTenantSchema = component(
  "BillingPeriodTenant",
  billingTenantSchema.extend({
    status: z
      .enum(["active", "suspended", "deleting"])
      .describe("The tenant's status at the close; `deleting`: deleted during or after the month."),
    complete: z
      .boolean()
      .describe("False when the tenant has a price but some of its peaks are missing."),
    sampledDays: z
      .number()
      .int()
      .describe("Days of the month with a sample of this tenant; the peak is over these days."),
    lines: z
      .array(billingPeriodLineSchema)
      .describe("Only quantities that had a price at the close."),
    corrections: z.array(billingCorrectionSchema),
    correctedTotal: z
      .number()
      .nullable()
      .describe("`total` plus the corrections; null when neither exists."),
  }),
);
export type BillingPeriodTenantDto = z.infer<typeof billingPeriodTenantSchema>;

export const billingPeriodSchema = component(
  "BillingPeriod",
  billingSchema.extend({
    period: periodSchema,
    status: z.enum(["closed"]),
    timeZone: z.string().describe("The time zone the month was closed in."),
    startsAt: timestampSchema,
    endsAt: timestampSchema,
    closedAt: timestampSchema.describe("When the close ran (on or after `endsAt`)."),
    generatedAt: timestampSchema.describe("The same as `closedAt`: the figures do not change."),
    days: z.number().int().describe("Days of the month."),
    sampledDays: z.number().int().describe("Days of the month on which tenants were sampled."),
    tenants: z.array(billingPeriodTenantSchema),
    correctedTotal: z
      .number()
      .nullable()
      .describe("The customers' corrected totals added up (not `internal`)."),
  }),
);
export type BillingPeriodDto = z.infer<typeof billingPeriodSchema>;

export const billingPeriodSummarySchema = component(
  "BillingPeriodSummary",
  z.object({
    period: periodSchema,
    status: z.enum(["closed"]),
    timeZone: z.string(),
    startsAt: timestampSchema,
    endsAt: timestampSchema,
    closedAt: timestampSchema,
    currency: z.string(),
    tenants: z.number().int(),
    total: z.number().nullable(),
    correctedTotal: z.number().nullable(),
    corrections: z.number().int().describe("How many corrections the month has."),
  }),
);

export const billingPeriodListSchema = component(
  "BillingPeriodList",
  z.object({
    items: z.array(billingPeriodSummarySchema).describe("The closed months, newest first."),
    open: z
      .object({
        period: periodSchema,
        startsAt: timestampSchema,
        closesAt: timestampSchema.describe("When it will be closed (the next month's start)."),
      })
      .describe("The current month: not closed yet, GET /provider/billing estimates it."),
  }),
);
export type BillingPeriodListDto = z.infer<typeof billingPeriodListSchema>;

export const createCorrectionSchema = z
  .object({
    tenantId: uuidSchema,
    type: z.enum(BILLING_LINE_TYPES).optional().describe("The line it corrects, if one."),
    amount: z
      .number()
      .finite()
      .refine((value) => value !== 0, "A correction of 0 corrects nothing.")
      .describe("Signed, in the period's currency."),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

/** The current month in `timeZone` at `now`, with its bounds. */
export function openPeriod(now: Date, timeZone: string): BillingPeriodListDto["open"] {
  const period = periodOfDay(localDay(now, timeZone));
  const { startsAt } = periodBounds(period, timeZone);
  return {
    period,
    startsAt: startsAt.toISOString(),
    closesAt: periodBounds(nextPeriod(period), timeZone).startsAt.toISOString(),
  };
}

export function correctionDto(row: BillingCorrectionRow): BillingCorrectionDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    type: (row.lineType as BillingCorrectionDto["type"]) ?? null,
    amount: row.amount,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.actor,
  };
}

function corrected(
  total: number | null,
  corrections: readonly { amount: number }[],
): number | null {
  if (corrections.length === 0) {
    return total;
  }
  return (total ?? 0) + corrections.reduce((sum, row) => sum + row.amount, 0);
}

/** The list of GET /provider/billing/periods. */
export function periodListDto(
  closed: Awaited<ReturnType<typeof listClosedPeriods>>,
  open: BillingPeriodListDto["open"],
): BillingPeriodListDto {
  return {
    items: closed.map((entry) => ({
      period: entry.period.period,
      status: "closed",
      timeZone: entry.period.timeZone,
      startsAt: entry.period.startsAt.toISOString(),
      endsAt: entry.period.endsAt.toISOString(),
      closedAt: entry.period.closedAt.toISOString(),
      currency: entry.period.currency,
      tenants: entry.tenants,
      total: entry.period.total,
      correctedTotal:
        entry.corrections === 0
          ? entry.period.total
          : (entry.period.total ?? 0) + entry.customerCorrections,
      corrections: entry.corrections,
    })),
    open,
  };
}

/** GET /provider/billing/periods/{period}, narrowed to `tenantId` when given. */
export function periodDto(loaded: LoadedPeriod, tenantId?: string): BillingPeriodDto {
  const { period } = loaded;
  const rows = tenantId
    ? loaded.tenants.filter((row) => row.tenantId === tenantId)
    : loaded.tenants;
  const tenants: BillingPeriodTenantDto[] = rows.map((row) => {
    const own = loaded.corrections.filter((correction) => correction.tenantId === row.tenantId);
    return {
      tenantId: row.tenantId,
      name: row.name,
      customerNumber: row.customerNumber,
      kind: row.kind as BillingPeriodTenantDto["kind"],
      status: row.status as BillingPeriodTenantDto["status"],
      complete: row.complete,
      sampledDays: row.sampledDays,
      lines: row.lines.map((line) => ({
        type: line.type as BillingPeriodTenantDto["lines"][number]["type"],
        quantity: line.quantity,
        unit: line.unit as BillingPeriodTenantDto["lines"][number]["unit"],
        unitPrice: line.unitPrice,
        priceSource: line.priceSource,
        amount: line.amount,
        peakDate: line.peakDate,
      })),
      total: row.total,
      corrections: own.map(correctionDto),
      correctedTotal: corrected(row.total, own),
    };
  });
  // The whole month adds up the customers; one tenant asked for answers for that tenant.
  const counted = tenantId ? tenants : tenants.filter((tenant) => tenant.kind !== "internal");
  const sum = (values: (number | null)[]) => {
    const present = values.filter((value): value is number => value !== null);
    return present.length > 0 ? present.reduce((total, value) => total + value, 0) : null;
  };
  return {
    period: period.period,
    status: "closed",
    timeZone: period.timeZone,
    startsAt: period.startsAt.toISOString(),
    endsAt: period.endsAt.toISOString(),
    closedAt: period.closedAt.toISOString(),
    generatedAt: period.closedAt.toISOString(),
    currency: period.currency,
    storageBilling: period.storageBilling as BillingPeriodDto["storageBilling"],
    days: period.days,
    sampledDays: period.sampledDays,
    tenants,
    total: tenantId ? sum(tenants.map((tenant) => tenant.total)) : period.total,
    correctedTotal: sum(counted.map((tenant) => tenant.correctedTotal)),
    missing: counted.filter((tenant) => !tenant.complete).length,
  };
}

/** The tenant a customer number names in a closed month (as recorded at the close), compared without case. */
export function periodTenantByCustomerNumber(
  loaded: LoadedPeriod,
  customerNumber: string,
): string | undefined {
  const wanted = customerNumber.trim().toLowerCase();
  return loaded.tenants.find((row) => row.customerNumber?.toLowerCase() === wanted)?.tenantId;
}
