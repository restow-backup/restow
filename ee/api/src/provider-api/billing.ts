import { type Database, tenants } from "@restow/db";
import { ne } from "drizzle-orm";
import { z } from "zod";
import { UNIT_LINES } from "../../../../apps/api/src/features/settings/pricing.js";
import type {
  EstimateTenantDto,
  PricingEstimateDto,
} from "../../../../apps/api/src/features/settings/pricing-estimate.js";
import { component } from "../../../../apps/api/src/routes/v1/components.js";
import { timestampSchema, uuidSchema } from "../../../../apps/api/src/routes/v1/schemas.js";

/**
 * GET /provider/billing (0.5.0, Service Provider): what each tenant would be billed this month
 * at the provider's prices, for a PSA or billing tool that fetches it with a provider key carrying
 * `billing:read`.
 *
 * It is the estimate behind every price card of the web UI (apps/api/src/features/settings/
 * pricing-estimate.ts `loadPricingEstimate`), so the API and the UI never disagree: the same
 * counting rules, the tenant's own price where it has one, the installation's otherwise. Each
 * tenant comes with its customer number (the key a billing tool matches its customer by) and one
 * line per priced quantity: quantity, unit, unit price, where the price comes from, amount.
 *
 * The figures are live, as of `generatedAt`. A fixed figure for an invoice (the month's close,
 * with a webhook) comes with 0.6.0; until then a tool reads on the day it bills.
 */

export const BILLING_LINE_TYPES = [
  "mailboxes",
  "storage",
  ...UNIT_LINES.map((line) => line.key),
] as const;
export type BillingLineType = (typeof BILLING_LINE_TYPES)[number];

export const billingLineSchema = component(
  "BillingLine",
  z.object({
    type: z
      .enum(BILLING_LINE_TYPES)
      .describe(
        "What is counted: protected mailboxes, stored data, servers, clients (workstations), virtual machines, containers or file shares.",
      ),
    quantity: z
      .number()
      .describe(
        "How many: mailboxes or units; for `storage` the billed amount in `unit` (GB or TB, decimal), after the installation's rounding.",
      ),
    unit: z.enum(["mailbox", "unit", "GB", "TB"]),
    unitPrice: z.number().describe("The price per `unit` that applies to this tenant."),
    priceSource: z
      .enum(["installation", "tenant"])
      .describe("`tenant`: the tenant's own price; `installation`: the provider's price."),
    amount: z.number().describe("`quantity` times `unitPrice`, unrounded."),
  }),
);
export type BillingLine = z.infer<typeof billingLineSchema>;

export const billingTenantSchema = component(
  "BillingTenant",
  z.object({
    tenantId: uuidSchema,
    name: z.string(),
    customerNumber: z.string().nullable().describe("The tenant's customer number, if set."),
    kind: z
      .enum(["customer", "internal"])
      .describe("`internal`: the provider's own organisation, no customer; not in `total`."),
    status: z.enum(["active", "suspended"]),
    complete: z
      .boolean()
      .describe(
        "False when the tenant has a price but its figures could not be read right now: its lines are missing, read again later.",
      ),
    lines: z.array(billingLineSchema).describe("Only quantities that have a price."),
    total: z.number().nullable().describe("The lines added up; null when no price applies."),
  }),
);
export type BillingTenant = z.infer<typeof billingTenantSchema>;

export const billingSchema = component(
  "Billing",
  z.object({
    generatedAt: timestampSchema,
    currency: z.string().describe("ISO 4217 code of every price and amount."),
    storageBilling: z
      .enum(["exact", "block_100gb", "block_1tb"])
      .describe("How stored bytes are counted: exactly, or rounded up to full 100 GB or 1 TB."),
    tenants: z.array(billingTenantSchema),
    total: z
      .number()
      .nullable()
      .describe("The customers' totals added up (not `internal`); null when none has one."),
    missing: z.number().int().describe("Customers with a price whose figures were not readable."),
  }),
);
export type Billing = z.infer<typeof billingSchema>;

export const billingQuerySchema = z.object({
  tenant: z.string().uuid().optional().describe("Only this tenant."),
  customerNumber: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Only the tenant with this customer number (compared without case)."),
});

/** Customer number and status of each tenant not being deleted (installation pool). */
export interface BillingTenantFacts {
  customerNumber: string | null;
  status: "active" | "suspended";
}

export async function loadBillingFacts(
  providerDb: Database,
): Promise<Map<string, BillingTenantFacts>> {
  const rows = await providerDb
    .select({ id: tenants.id, customerNumber: tenants.customerNumber, status: tenants.status })
    .from(tenants)
    .where(ne(tenants.status, "deleting"));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        customerNumber: row.customerNumber,
        status: row.status === "active" ? "active" : "suspended",
      },
    ]),
  );
}

const UNIT_BYTES = { GB: 1e9, TB: 1e12 } as const;

/** The billing lines of one tenant's estimate: every quantity that has a price. */
export function billingLines(entry: EstimateTenantDto, storageUnit: "GB" | "TB"): BillingLine[] {
  const lines: BillingLine[] = [];
  const add = (
    type: BillingLineType,
    quantity: number | null,
    unit: BillingLine["unit"],
    unitPrice: number | null,
    own: boolean,
    amount: number | null,
  ) => {
    if (quantity === null || unitPrice === null || amount === null) return;
    lines.push({
      type,
      quantity,
      unit,
      unitPrice,
      priceSource: own ? "tenant" : "installation",
      amount,
    });
  };
  add(
    "mailboxes",
    entry.mailboxes,
    "mailbox",
    entry.mailboxPrice,
    entry.overridden.mailbox,
    entry.amount.mailboxes,
  );
  add(
    "storage",
    entry.billedBytes === null ? null : entry.billedBytes / UNIT_BYTES[storageUnit],
    storageUnit,
    entry.storagePrice,
    entry.overridden.storage,
    entry.amount.storage,
  );
  for (const line of UNIT_LINES) {
    add(
      line.key,
      entry[line.key],
      "unit",
      entry[line.price],
      entry.overridden[line.flag],
      entry.amount[line.key],
    );
  }
  return lines;
}

/** The answer of GET /provider/billing from the estimate and each tenant's facts. */
export function billingFromEstimate(
  estimate: PricingEstimateDto,
  facts: ReadonlyMap<string, BillingTenantFacts>,
  now: Date,
): Billing {
  const items: BillingTenant[] = [];
  for (const entry of estimate.tenants) {
    const fact = facts.get(entry.tenantId);
    if (!fact) continue;
    const lines = billingLines(entry, estimate.storageUnit);
    const priced =
      entry.mailboxPrice !== null ||
      entry.storagePrice !== null ||
      UNIT_LINES.some((line) => entry[line.price] !== null);
    items.push({
      tenantId: entry.tenantId,
      name: entry.name,
      customerNumber: fact.customerNumber,
      kind: entry.kind,
      status: fact.status,
      complete: !priced || entry.amount.total !== null,
      lines,
      total: entry.amount.total,
    });
  }
  return {
    generatedAt: now.toISOString(),
    currency: estimate.currency,
    storageBilling: estimate.storageBilling,
    tenants: items,
    total: estimate.total,
    missing: estimate.missing,
  };
}

/** The tenant a customer number names, compared without case; undefined when none. */
export function tenantByCustomerNumber(
  facts: ReadonlyMap<string, BillingTenantFacts>,
  customerNumber: string,
): string | undefined {
  const wanted = customerNumber.trim().toLowerCase();
  for (const [id, fact] of facts) {
    if (fact.customerNumber?.toLowerCase() === wanted) return id;
  }
  return undefined;
}
