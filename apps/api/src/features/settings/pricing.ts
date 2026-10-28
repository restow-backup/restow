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
 */

export const PRICING_AUDIT_ACTIONS = { updated: "settings.pricing.updated" } as const;

export const DEFAULT_CURRENCY = "EUR";

/** The currencies offered; the figures are formatted with the browser's Intl. */
export const PRICING_CURRENCIES = ["EUR", "CHF", "USD", "GBP"] as const;

const price = z.number().min(0).max(1_000_000).multipleOf(0.0001).nullable();

export const pricingSchema = z
  .object({
    currency: z.enum(PRICING_CURRENCIES).optional(),
    storagePrice: price.optional(),
    storageUnit: z.enum(["GB", "TB"]).optional(),
    mailboxPrice: price.optional(),
  })
  .strict();

export interface PricingDto {
  currency: string;
  storagePrice: number | null;
  storageUnit: "GB" | "TB";
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
