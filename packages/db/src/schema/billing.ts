import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdOnly } from "./_shared.js";
import { tenants } from "./tenants.js";

/**
 * The monthly billing close (0.6.0, Service Provider; docs/ARCHITECTURE.md, "Monatsabschluss der
 * Abrechnung"): a daily sample per tenant of every billed quantity, and each month closed once,
 * on the 1st at 00:00 in the installation's time zone, at the month's peak. Written and read by
 * the API's billing service (ee/api/src/billing-close) on the installation pool only
 * (roles.ts TABLE_ACCESS); the tables with `tenant_id` also carry the tenant policy of
 * sql/rls.sql as a second line.
 *
 * A closed month (`billing_periods`, `billing_period_tenants`) and its corrections
 * (`billing_corrections`) never change: the trigger of sql/rls.sql refuses UPDATE and DELETE,
 * and the roles hold neither (roles.ts BILLING_CLOSE_TABLES). A correction is a new row.
 */

/**
 * The quantities of one tenant on one day, as the price estimate counts them
 * (apps/api features/settings/pricing-estimate.ts): protected mailboxes, the stored bytes before
 * any rounding, and the protected units of each unit line. A quantity that was not read is left
 * out.
 */
export interface BillingSampleQuantities {
  mailboxes?: number;
  storedBytes?: number;
  servers?: number;
  clients?: number;
  vms?: number;
  containers?: number;
  fileShares?: number;
}

/** One price of a sample: the price per unit in force that day and where it came from. */
export interface BillingSamplePrice {
  unitPrice: number;
  source: "installation" | "tenant";
}

/**
 * The prices in force for one tenant on the day of a sample (0.6.0): per billed line (`mailboxes`,
 * `storage`, `servers`, ...) the price that applied (the tenant's own where the gate
 * `tenants.additional` was open and it has one, else the installation's), absent where none did;
 * with the currency and how stored data was billed. The close takes them from the month's last
 * sample of the tenant, so a close that runs late bills the prices of the month's end.
 */
export interface BillingSamplePrices {
  currency: string;
  storageUnit: "GB" | "TB";
  storageBilling: "exact" | "block_100gb" | "block_1tb";
  /** Whether tenants' own prices applied that day (the gate `tenants.additional`). */
  perTenantOverrides: boolean;
  /** The installation's prices that day, by price key (`mailboxPrice`, ...); null = none. */
  installation: Record<string, number | null>;
  /** The price that applied to this tenant, by line. */
  lines: Partial<Record<string, BillingSamplePrice>>;
}

/** One line of a closed month, as GET /provider/billing answers it plus the peak's day. */
export interface BillingClosedLine {
  type: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  priceSource: "installation" | "tenant";
  amount: number;
  /** The first day (YYYY-MM-DD, installation time zone) the peak quantity was reached. */
  peakDate: string;
}

/** The installation's prices at the close (apps/api tenant-pricing.ts `TenantPriceSet`). */
export type BillingPriceSet = Record<string, number | null>;

/** One row per tenant and day (installation time zone); at most one, the first pass's. */
export const billingSamples = pgTable(
  "billing_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    quantities: jsonb("quantities").$type<BillingSampleQuantities>().notNull(),
    /** The prices in force that day (0.6.0, migration 0107); null on samples written before. */
    prices: jsonb("prices").$type<BillingSamplePrices>(),
    ...createdOnly(),
  },
  (t) => [
    unique("billing_samples_tenant_day_uq").on(t.tenantId, t.day),
    index("billing_samples_day_idx").on(t.day),
  ],
);

/** One row per closed month (`YYYY-MM`), written once by the close. */
export const billingPeriods = pgTable(
  "billing_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    period: text("period").notNull(),
    /** The zone the month was computed in (the installation's at the close). */
    timeZone: text("time_zone").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
    currency: text("currency").notNull(),
    storageUnit: text("storage_unit").notNull(),
    storageBilling: text("storage_billing").notNull(),
    /** The installation's prices at the close. */
    prices: jsonb("prices").$type<BillingPriceSet>().notNull(),
    /** Whether tenants' own prices applied (the gate `tenants.additional` at the close). */
    perTenantOverrides: boolean("per_tenant_overrides").notNull(),
    /** Days of the month, and days on which at least one tenant was sampled. */
    days: integer("days").notNull(),
    sampledDays: integer("sampled_days").notNull(),
    /** The customers' totals added up (not `internal`); null when none has one. */
    total: doublePrecision("total"),
    ...createdOnly(),
  },
  (t) => [
    unique("billing_periods_period_uq").on(t.period),
    check("billing_periods_period_ck", sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("billing_periods_bounds_ck", sql`${t.startsAt} < ${t.endsAt}`),
  ],
);

/** One row per closed month and tenant: what it is billed, frozen at the close. */
export const billingPeriodTenants = pgTable(
  "billing_period_tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    periodId: uuid("period_id")
      .notNull()
      .references(() => billingPeriods.id, { onDelete: "restrict" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    customerNumber: text("customer_number"),
    kind: text("kind").notNull(),
    /** The tenant's status at the close (`deleting`: deleted during or after the month). */
    status: text("status").notNull(),
    complete: boolean("complete").notNull(),
    sampledDays: integer("sampled_days").notNull(),
    lines: jsonb("lines").$type<BillingClosedLine[]>().notNull(),
    total: doublePrecision("total"),
    ...createdOnly(),
  },
  (t) => [
    unique("billing_period_tenants_period_tenant_uq").on(t.periodId, t.tenantId),
    index("billing_period_tenants_tenant_idx").on(t.tenantId),
  ],
);

/** A correction of a closed month: a signed amount next to the close, never a change of it. */
export const billingCorrections = pgTable(
  "billing_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    periodId: uuid("period_id")
      .notNull()
      .references(() => billingPeriods.id, { onDelete: "restrict" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    /** The line it corrects; null for the tenant's bill as a whole. */
    lineType: text("line_type"),
    amount: doublePrecision("amount").notNull(),
    reason: text("reason").notNull(),
    /** Who entered it (the API key's label) and with which key. */
    actor: text("actor").notNull(),
    apiKeyId: text("api_key_id"),
    ...createdOnly(),
  },
  (t) => [
    index("billing_corrections_period_idx").on(t.periodId, t.createdAt),
    check("billing_corrections_amount_ck", sql`${t.amount} <> 0`),
  ],
);

export type BillingSampleRow = typeof billingSamples.$inferSelect;
export type NewBillingSampleRow = typeof billingSamples.$inferInsert;
export type BillingPeriodRow = typeof billingPeriods.$inferSelect;
export type NewBillingPeriodRow = typeof billingPeriods.$inferInsert;
export type BillingPeriodTenantRow = typeof billingPeriodTenants.$inferSelect;
export type NewBillingPeriodTenantRow = typeof billingPeriodTenants.$inferInsert;
export type BillingCorrectionRow = typeof billingCorrections.$inferSelect;
export type NewBillingCorrectionRow = typeof billingCorrections.$inferInsert;
