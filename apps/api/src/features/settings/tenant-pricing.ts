import { type Database, type TenantPricing, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import { featureEnabled, requireFeature } from "../../lib/features.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import {
  getPricing,
  PRICE_KEYS,
  type PricingDto,
  priceOrNull,
  priceSchema,
  type UnitPrices,
  unitPricesOf,
} from "./pricing.js";

/**
 * A tenant's own prices (0.4.8): the mailbox price and the storage price of one customer can
 * differ from the installation's (pricing.ts), and since 0.5.0 each price per protected unit
 * (server, client, VM, container, file share) as well. The currency and the storage unit stay
 * global.
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
    serverPrice: priceSchema.optional(),
    clientPrice: priceSchema.optional(),
    vmPrice: priceSchema.optional(),
    containerPrice: priceSchema.optional(),
    fileSharePrice: priceSchema.optional(),
  })
  .strict();

export type TenantPricingInput = z.infer<typeof tenantPricingSchema>;

/** The prices of one tenant that differ from the installation's; null = takes the installation's. */
export interface TenantPriceOverridesDto extends UnitPrices {
  mailboxPrice: number | null;
  storagePrice: number | null;
}

/** Every price of one side (installation, tenant, effective); null = none. */
export type TenantPriceSet = TenantPriceOverridesDto;

/** GET and PUT /api/v1/tenants/:id/pricing. */
export interface TenantPricingDto {
  tenantId: string;
  currency: string;
  storageUnit: "GB" | "TB";
  /** Whether tenants may have prices of their own here (the gate `tenants.additional` is open). */
  overridesEnabled: boolean;
  /** The installation's prices. */
  global: TenantPriceSet;
  /** The tenant's own prices; all null while `overridesEnabled` is false, stored or not. */
  overrides: TenantPriceOverridesDto;
  /** What applies to the tenant: its own price where it has one, else the installation's. */
  effective: TenantPriceSet;
}

export const NO_OVERRIDES: TenantPriceOverridesDto = {
  mailboxPrice: null,
  storagePrice: null,
  ...unitPricesOf(null),
};

/** The stored overrides, without whatever is not a price. */
export function resolveTenantOverrides(
  stored: TenantPricing | null | undefined,
): TenantPriceOverridesDto {
  return {
    mailboxPrice: priceOrNull(stored?.mailboxPrice),
    storagePrice: priceOrNull(stored?.storagePrice),
    ...unitPricesOf(stored),
  };
}

/** The installation's prices as one set. */
export function globalPriceSet(global: PricingDto): TenantPriceSet {
  const set = {} as TenantPriceSet;
  for (const key of PRICE_KEYS) {
    set[key] = global[key];
  }
  return set;
}

/** The price that applies: the tenant's own one, else the installation's. */
export function effectivePrice(own: number | null, global: number | null): number | null {
  return own ?? global;
}

/** Per price, the tenant's own one where it has one, else the installation's. */
function effectivePrices(overrides: TenantPriceOverridesDto, global: PricingDto): TenantPriceSet {
  const set = {} as TenantPriceSet;
  for (const key of PRICE_KEYS) {
    set[key] = effectivePrice(overrides[key], global[key]);
  }
  return set;
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
    global: globalPriceSet(global),
    overrides: { ...overrides },
    effective: effectivePrices(overrides, global),
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
    for (const key of PRICE_KEYS) {
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
  const result: TenantPricing = {};
  for (const key of PRICE_KEYS) {
    const value = overrides[key];
    if (value !== null) {
      result[key] = value;
    }
  }
  return result;
}
