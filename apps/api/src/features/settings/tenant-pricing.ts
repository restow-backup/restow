import { type Database, type TenantPricing, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import { featureEnabled, requireFeature } from "../../lib/features.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { getPricing, type PricingDto, priceSchema } from "./pricing.js";

/**
 * A tenant's own prices (0.4.8): the mailbox price and the storage price of one customer can
 * differ from the installation's (pricing.ts). The currency and the storage unit stay global.
 *
 * The overrides belong to the Service Provider edition: they are read and changed only while the
 * feature gate `tenants.additional` is open. With the gate closed a change is refused (the
 * feature-unavailable problem) and whatever is stored is ignored everywhere, so an installation
 * that falls back to a single tenant prices it with the installation's prices again, and the
 * overrides are back when the gate opens. A provider admin reads (GET /api/v1/tenants/:id/pricing),
 * the owner changes (PUT, audited in the tenant's own chain next to the other tenant changes,
 * lib/provider-access.ts). A key that is absent takes the installation's price; a number, also 0,
 * is the tenant's price. Tenant users never see any of it.
 */

export const TENANT_PRICING_AUDIT_ACTIONS = { updated: "tenant.pricing.updated" } as const;

/** The gate the overrides need (lib/features.ts). */
export const TENANT_PRICING_FEATURE = "tenants.additional" as const;

/** null removes the tenant's price, so the installation's applies again; a key left out stays. */
export const tenantPricingSchema = z
  .object({
    mailboxPrice: priceSchema.optional(),
    storagePrice: priceSchema.optional(),
  })
  .strict();

export type TenantPricingInput = z.infer<typeof tenantPricingSchema>;

/** The prices of one tenant that differ from the installation's; null = takes the installation's. */
export interface TenantPriceOverridesDto {
  mailboxPrice: number | null;
  storagePrice: number | null;
}

/** GET and PUT /api/v1/tenants/:id/pricing. */
export interface TenantPricingDto {
  tenantId: string;
  currency: string;
  storageUnit: "GB" | "TB";
  /** Whether tenants may have prices of their own here (the gate `tenants.additional` is open). */
  overridesEnabled: boolean;
  /** The installation's prices. */
  global: { mailboxPrice: number | null; storagePrice: number | null };
  /** The tenant's own prices; both null while `overridesEnabled` is false, stored or not. */
  overrides: TenantPriceOverridesDto;
  /** What applies to the tenant: its own price where it has one, else the installation's. */
  effective: { mailboxPrice: number | null; storagePrice: number | null };
}

const NO_OVERRIDES: TenantPriceOverridesDto = { mailboxPrice: null, storagePrice: null };

/** The stored overrides, without whatever is not a price. */
export function resolveTenantOverrides(
  stored: TenantPricing | null | undefined,
): TenantPriceOverridesDto {
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    mailboxPrice: number(stored?.mailboxPrice),
    storagePrice: number(stored?.storagePrice),
  };
}

/** The price that applies: the tenant's own one, else the installation's. */
export function effectivePrice(own: number | null, global: number | null): number | null {
  return own ?? global;
}

export function toTenantPricingDto(
  tenantId: string,
  global: PricingDto,
  stored: TenantPricing | null | undefined,
  overridesEnabled: boolean,
): TenantPricingDto {
  const overrides = overridesEnabled ? resolveTenantOverrides(stored) : NO_OVERRIDES;
  return {
    tenantId,
    currency: global.currency,
    storageUnit: global.storageUnit,
    overridesEnabled,
    global: { mailboxPrice: global.mailboxPrice, storagePrice: global.storagePrice },
    overrides: { ...overrides },
    effective: {
      mailboxPrice: effectivePrice(overrides.mailboxPrice, global.mailboxPrice),
      storagePrice: effectivePrice(overrides.storagePrice, global.storagePrice),
    },
  };
}

const notFound = () => new ProblemError(404, "Tenant not found");

/**
 * Read the prices of one tenant. `db` is the application pool (the tenant row is read pinned),
 * `providerDb` the installation pool (the settings row and the gate).
 */
export async function getTenantPricing(
  db: Database,
  providerDb: Database,
  tenantId: string,
): Promise<TenantPricingDto> {
  const stored = await withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ status: tenants.status, pricing: tenants.pricing })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row || row.status === "deleting") {
      throw notFound();
    }
    return row.pricing;
  });
  return toTenantPricingDto(
    tenantId,
    await getPricing(providerDb),
    stored,
    await featureEnabled(TENANT_PRICING_FEATURE, providerDb),
  );
}

/**
 * Set or remove the tenant's own prices (what is left out stays), refused while the gate is
 * closed. The audit entry names the stored overrides before and after.
 */
export async function updateTenantPricing(
  db: Database,
  providerDb: Database,
  tenantId: string,
  input: TenantPricingInput,
  actor: { id: string; email: string; ip: string | null },
): Promise<TenantPricingDto> {
  await requireFeature(TENANT_PRICING_FEATURE, providerDb);
  const stored = await withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ status: tenants.status, pricing: tenants.pricing })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
      .for("update");
    if (!row) {
      throw notFound();
    }
    if (row.status === "deleting") {
      throw new ProblemError(409, "Tenant is being deleted");
    }
    const after: TenantPricing = { ...resolveStored(row.pricing) };
    for (const key of ["mailboxPrice", "storagePrice"] as const) {
      const value = input[key];
      if (value === null) {
        delete after[key];
      } else if (value !== undefined) {
        after[key] = value;
      }
    }
    await tx.update(tenants).set({ pricing: after }).where(eq(tenants.id, tenantId));
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: TENANT_PRICING_AUDIT_ACTIONS.updated,
      target: tenantId,
      targetType: "tenant",
      ip: actor.ip,
      details: { before: row.pricing, after },
    });
    return after;
  });
  return toTenantPricingDto(tenantId, await getPricing(providerDb), stored, true);
}

/** The stored object as a plain copy; anything else (never written by this module) reads as `{}`. */
function resolveStored(stored: TenantPricing | null | undefined): TenantPricing {
  const overrides = resolveTenantOverrides(stored);
  return {
    ...(overrides.mailboxPrice !== null ? { mailboxPrice: overrides.mailboxPrice } : {}),
    ...(overrides.storagePrice !== null ? { storagePrice: overrides.storagePrice } : {}),
  };
}
