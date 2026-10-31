import { type Database, type PricingSettings, settings } from "@restow/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";

/**
 * The provider's own prices (0.4.7): per month, per gigabyte or terabyte of stored backups and per
 * protected mailbox. Nothing bills, limits or enforces them: the tenant overview multiplies them
 * with the tenant's figures in one small card, so the provider can keep an eye on it. Every
 * provider admin reads them (GET /api/v1/settings/pricing), the owner changes them (PUT, audited
 * in the installation chain, lib/provider-access.ts). Tenant users never see them.
 *
 * Since 0.4.8 a tenant can have prices of its own where the installation offers several tenants
 * (tenant-pricing.ts), and one estimate answers for both the dashboard and the tenant page
 * (pricing-estimate.ts).
 */

export const PRICING_AUDIT_ACTIONS = { updated: "settings.pricing.updated" } as const;

export const DEFAULT_CURRENCY = "EUR";

/** The currencies offered; the figures are formatted with the browser's Intl. */
export const PRICING_CURRENCIES = ["EUR", "CHF", "USD", "GBP"] as const;

/**
 * How the stored bytes are counted (0.4.9): `exact`, or rounded up to the next full block of
 * 100 GB or 1 TB (decimal units) before the storage price applies, whatever its unit. It applies
 * to tenants with prices of their own as well.
 */
export const STORAGE_BILLING = ["exact", "block_100gb", "block_1tb"] as const;
export type StorageBilling = (typeof STORAGE_BILLING)[number];

/** The bytes of one block; null for `exact`. */
export const BILLING_BLOCK_BYTES: Readonly<Record<StorageBilling, number | null>> = {
  exact: null,
  block_100gb: 100e9,
  block_1tb: 1e12,
};

/** The bytes a price applies to: the stored bytes, rounded up to full blocks; 0 stays 0. */
export function billedBytes(storedBytes: number, billing: StorageBilling): number {
  const block = BILLING_BLOCK_BYTES[billing];
  if (block === null || storedBytes <= 0) {
    return Math.max(0, storedBytes);
  }
  return Math.ceil(storedBytes / block) * block;
}

/** One price: null clears it. The limits also hold for a tenant's own price (tenant-pricing.ts). */
export const priceSchema = z.number().min(0).max(1_000_000).multipleOf(0.0001).nullable();

export const pricingSchema = z
  .object({
    currency: z.enum(PRICING_CURRENCIES).optional(),
    storagePrice: priceSchema.optional(),
    storageUnit: z.enum(["GB", "TB"]).optional(),
    storageBilling: z.enum(STORAGE_BILLING).optional(),
    mailboxPrice: priceSchema.optional(),
  })
  .strict();

export interface PricingDto {
  currency: string;
  storagePrice: number | null;
  storageUnit: "GB" | "TB";
  /** How the stored bytes are counted before the storage price applies. */
  storageBilling: StorageBilling;
  mailboxPrice: number | null;
}

export function resolvePricing(stored: PricingSettings | null | undefined): PricingDto {
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    currency:
      typeof stored?.currency === "string" &&
      (PRICING_CURRENCIES as readonly string[]).includes(stored.currency)
        ? stored.currency
        : DEFAULT_CURRENCY,
    storagePrice: number(stored?.storagePrice),
    storageUnit: stored?.storageUnit === "TB" ? "TB" : "GB",
    storageBilling: (STORAGE_BILLING as readonly string[]).includes(stored?.storageBilling ?? "")
      ? (stored?.storageBilling as StorageBilling)
      : "exact",
    mailboxPrice: number(stored?.mailboxPrice),
  };
}

export async function getPricing(db: DbExecutor): Promise<PricingDto> {
  const [row] = await db.select({ value: settings.pricing }).from(settings).limit(1);
  return resolvePricing(row?.value);
}

export async function updatePricing(
  db: Database,
  input: z.infer<typeof pricingSchema>,
  actor: { id: string; email: string; ip: string | null },
): Promise<PricingDto> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).limit(1).for("update");
    if (!row) {
      throw new ProblemError(409, "Setup not completed", {
        type: "urn:restow:problem:setup-incomplete",
        detail: "Finish the setup wizard before changing installation settings.",
      });
    }
    const stored: PricingSettings = { ...row.pricing, ...input };
    await tx.update(settings).set({ pricing: stored }).where(eq(settings.id, row.id));
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: PRICING_AUDIT_ACTIONS.updated,
      target: row.id,
      targetType: "settings",
      ip: actor.ip,
      details: { before: row.pricing, after: stored },
    });
    return resolvePricing(stored);
  });
}
