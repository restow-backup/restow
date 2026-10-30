import {
  type Database,
  safeErrorMessage,
  type TenantKind,
  type TenantPricing,
  tenants,
} from "@restow/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { mapBounded } from "../../lib/bounded-map.js";
import { featureEnabled } from "../../lib/features.js";
import { type ProviderAccess, providerMayEnterTenant } from "../../lib/provider-access.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { loadPhysicalBytes } from "../../routes/v1/storage.js";
import { TenantFiguresCache } from "../tenant-jobs/figures-cache.js";
import { TENANT_READS_AT_ONCE } from "../tenant-jobs/service.js";
import { countTenantMailboxes } from "../usage/service.js";
import { getPricing, type PricingDto } from "./pricing.js";
import {
  effectivePrice,
  resolveTenantOverrides,
  TENANT_PRICING_FEATURE,
  type TenantPriceOverridesDto,
} from "./tenant-pricing.js";

/**
 * The monthly estimate behind every price card (0.4.8): the dashboard's, the tenant page's and
 * the all-tenants view's. One server-side source of truth instead of a sum in each page:
 *
 *   mailboxes     the protected mailboxes under the counting rule of GET /api/v1/usage
 *                 (@restow/core `countProtectedMailboxes`; usage/service.ts)
 *   stored bytes  the dashboard storage widget's physical bytes: the sealed packs of the chunk
 *                 store plus the restic repositories (storage `loadPhysicalBytes`)
 *   prices        the tenant's own price where it has one and the gate `tenants.additional` is
 *                 open (tenant-pricing.ts), else the installation's (pricing.ts)
 *
 * The amount of a line is the quantity times its price, in the decimal unit of the storage price
 * (1 GB = 10^9 bytes, 1 TB = 10^12 bytes). Nothing bills any of it.
 *
 * Tenants being deleted are left out, and so is every tenant outside the reach of a member of the
 * provider team who is limited to some tenants (the handler passes the member's access, as
 * tenant-running does). The figures of a tenant are read in its own pinned transaction, a few
 * tenants at a time, and only for a tenant that has at least one price (without one there is
 * nothing to multiply). A tenant's figures are kept for a short while for every viewer
 * ({@link ESTIMATE_FIGURES_TTL_MS}); a tenant whose figures cannot be read has none (`null`) and
 * is counted in `missing`, the others still add up.
 *
 * The operator's own organisation (`kind = internal`) is listed but is no customer: it does not
 * count in `total` and `missing` of the whole list. A request for that one tenant answers for it.
 */

/** GET /api/v1/settings/pricing/estimate?tenant=<id>: one tenant instead of the whole list. */
export const pricingEstimateQuerySchema = z.object({ tenant: z.string().uuid().optional() });

/** How long a tenant's figures are served again; the dashboard asks about as often as it opens. */
export const ESTIMATE_FIGURES_TTL_MS = 30_000;

const UNIT_BYTES = { GB: 1e9, TB: 1e12 } as const;

/** What one tenant protects and stores right now. */
export interface TenantFigures {
  mailboxes: number;
  storedBytes: number;
}

export interface EstimateAmountDto {
  /** Mailboxes times the mailbox price; null when there is no price or no figure. */
  mailboxes: number | null;
  /** Stored bytes in the price's unit times the storage price; null when there is none of either. */
  storage: number | null;
  /** The two added up; null when no line has an amount, or a figure is missing for a price. */
  total: number | null;
}

export interface EstimateTenantDto {
  tenantId: string;
  name: string;
  /** `internal`: the operator's own organisation, no customer. */
  kind: TenantKind;
  /** Protected mailboxes; null when the figure is not available (or no price needed it). */
  mailboxes: number | null;
  /** Everything stored, in bytes; null when the figure is not available (or no price needed it). */
  storedBytes: number | null;
  /** The price per mailbox that applies to this tenant; null = none set. */
  mailboxPrice: number | null;
  /** The price per `storageUnit` that applies to this tenant; null = none set. */
  storagePrice: number | null;
  /** Whether the tenant's own price applies instead of the installation's. */
  overridden: { mailbox: boolean; storage: boolean };
  amount: EstimateAmountDto;
}

/** GET /api/v1/settings/pricing/estimate. */
export interface PricingEstimateDto {
  currency: string;
  storageUnit: "GB" | "TB";
  /** The installation's prices. */
  global: { mailboxPrice: number | null; storagePrice: number | null };
  /** Whether tenants may have prices of their own (the gate `tenants.additional` is open). */
  perTenantOverrides: boolean;
  /** At least one tenant of the list has a price, the installation's or its own. */
  hasPrices: boolean;
  tenants: EstimateTenantDto[];
  /** The tenants' totals added up (customers only); null when no tenant has one. */
  total: number | null;
  /** Tenants with a price whose figures are not available (customers only). */
  missing: number;
}

/** The amount of one tenant; pure. */
export function estimateAmount(input: {
  figures: TenantFigures | null;
  mailboxPrice: number | null;
  storagePrice: number | null;
  storageUnit: "GB" | "TB";
}): EstimateAmountDto {
  const { figures, mailboxPrice, storagePrice, storageUnit } = input;
  const priced = mailboxPrice !== null || storagePrice !== null;
  if (!figures || !priced) {
    return { mailboxes: null, storage: null, total: null };
  }
  const mailboxes = mailboxPrice !== null ? figures.mailboxes * mailboxPrice : null;
  const storage =
    storagePrice !== null ? (figures.storedBytes / UNIT_BYTES[storageUnit]) * storagePrice : null;
  return { mailboxes, storage, total: (mailboxes ?? 0) + (storage ?? 0) };
}

interface TenantRow {
  id: string;
  name: string;
  kind: TenantKind;
  pricing: TenantPricing;
}

/** One tenant's entry, from its row, the installation's prices and the figures read for it. */
export function estimateTenant(input: {
  row: Pick<TenantRow, "id" | "name" | "kind">;
  overrides: TenantPriceOverridesDto;
  pricing: Pick<PricingDto, "mailboxPrice" | "storagePrice" | "storageUnit">;
  figures: TenantFigures | null;
}): EstimateTenantDto {
  const { row, overrides, pricing, figures } = input;
  const mailboxPrice = effectivePrice(overrides.mailboxPrice, pricing.mailboxPrice);
  const storagePrice = effectivePrice(overrides.storagePrice, pricing.storagePrice);
  return {
    tenantId: row.id,
    name: row.name,
    kind: row.kind,
    mailboxes: figures?.mailboxes ?? null,
    storedBytes: figures?.storedBytes ?? null,
    mailboxPrice,
    storagePrice,
    overridden: {
      mailbox: overrides.mailboxPrice !== null,
      storage: overrides.storagePrice !== null,
    },
    amount: estimateAmount({
      figures,
      mailboxPrice,
      storagePrice,
      storageUnit: pricing.storageUnit,
    }),
  };
}

/** The tenant's figures, inside its pinned transaction. */
async function readFigures(db: Database, tenantId: string): Promise<TenantFigures> {
  return withTenantTx(db, tenantId, async (tx) => ({
    mailboxes: await countTenantMailboxes(tx, tenantId),
    storedBytes: await loadPhysicalBytes(tx, tenantId),
  }));
}

export interface PricingEstimateDeps {
  /** The application pool (Row Level Security applies). */
  db: Database;
  /** The installation pool: the tenant list, the settings row and the gate. */
  providerDb: Database;
  /** Each tenant's figures, kept for a short while; without it every request reads them. */
  cache?: TenantFiguresCache<TenantFigures>;
}

/** The figures shared by the routes, so several open pages cost the database no more than one. */
export const estimateFiguresCache = new TenantFiguresCache<TenantFigures>(ESTIMATE_FIGURES_TTL_MS);

/**
 * GET /api/v1/settings/pricing/estimate. `access` is the member's provider access (null = every
 * tenant); `tenantId` narrows the answer to one tenant (404 when it does not exist, is being
 * deleted or lies outside the member's tenants).
 */
export async function loadPricingEstimate(
  deps: PricingEstimateDeps,
  access: ProviderAccess | null,
  options: { tenantId?: string } = {},
): Promise<PricingEstimateDto> {
  const { db, providerDb, cache } = deps;
  const pricing = await getPricing(providerDb);
  const overridesEnabled = await featureEnabled(TENANT_PRICING_FEATURE, providerDb);

  const listed = await providerDb
    .select({ id: tenants.id, name: tenants.name, kind: tenants.kind, pricing: tenants.pricing })
    .from(tenants)
    .where(
      options.tenantId
        ? and(ne(tenants.status, "deleting"), eq(tenants.id, options.tenantId))
        : ne(tenants.status, "deleting"),
    )
    .orderBy(asc(tenants.name));
  const rows: TenantRow[] = access
    ? listed.filter((row) => providerMayEnterTenant(access, row.id))
    : listed;
  if (options.tenantId && rows.length === 0) {
    throw new ProblemError(404, "Tenant not found");
  }
  cache?.prune();

  const answers = await mapBounded(rows, TENANT_READS_AT_ONCE, async (row) => {
    // Overrides that are stored but not offered (the gate is closed) are ignored.
    const overrides = overridesEnabled
      ? resolveTenantOverrides(row.pricing)
      : { mailboxPrice: null, storagePrice: null };
    const priced =
      effectivePrice(overrides.mailboxPrice, pricing.mailboxPrice) !== null ||
      effectivePrice(overrides.storagePrice, pricing.storagePrice) !== null;
    if (!priced) {
      return { row, overrides, figures: null, priced };
    }
    try {
      const load = () => readFigures(db, row.id);
      return { row, overrides, figures: await (cache ? cache.get(row.id, load) : load()), priced };
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "price estimate read failed",
          tenantId: row.id,
          // Never the failed query with its bound parameters.
          errorMessage: safeErrorMessage(error),
        }),
      );
      return { row, overrides, figures: null, priced };
    }
  });

  const items = answers.map((answer) => ({
    ...answer,
    entry: estimateTenant({
      row: answer.row,
      overrides: answer.overrides,
      pricing,
      figures: answer.figures,
    }),
  }));
  // The whole list adds up the customers; a request for one tenant answers for that tenant.
  const counted = options.tenantId ? items : items.filter((item) => item.row.kind !== "internal");
  const totals = counted.flatMap((item) =>
    item.entry.amount.total === null ? [] : [item.entry.amount.total],
  );
  return {
    currency: pricing.currency,
    storageUnit: pricing.storageUnit,
    global: { mailboxPrice: pricing.mailboxPrice, storagePrice: pricing.storagePrice },
    perTenantOverrides: overridesEnabled,
    hasPrices:
      pricing.mailboxPrice !== null ||
      pricing.storagePrice !== null ||
      items.some((item) => item.priced),
    tenants: items.map((item) => item.entry),
    total: totals.length > 0 ? totals.reduce((sum, amount) => sum + amount, 0) : null,
    missing: counted.filter((item) => item.priced && item.figures === null).length,
  };
}
