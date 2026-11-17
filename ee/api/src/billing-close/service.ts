import {
  type BillingCorrectionRow,
  type BillingPeriodRow,
  type BillingPeriodTenantRow,
  type BillingSampleQuantities,
  billingCorrections,
  billingPeriods,
  billingPeriodTenants,
  billingSamples,
  type Database,
  safeErrorMessage,
  settings,
  type TenantPricing,
  tenants,
} from "@restow/db";
import { and, asc, desc, eq, gte, inArray, lt, ne, notExists, sql } from "drizzle-orm";
import { getPricing } from "../../../../apps/api/src/features/settings/pricing.js";
import {
  readTenantFigures,
  type TenantFigures,
} from "../../../../apps/api/src/features/settings/pricing-estimate.js";
import {
  globalPriceSet,
  TENANT_PRICING_FEATURE,
} from "../../../../apps/api/src/features/settings/tenant-pricing.js";
import { TENANT_READS_AT_ONCE } from "../../../../apps/api/src/features/tenant-jobs/service.js";
import { audit as appendAudit } from "../../../../apps/api/src/lib/audit.js";
import { mapBounded } from "../../../../apps/api/src/lib/bounded-map.js";
import { featureEnabled } from "../../../../apps/api/src/lib/features.js";
import { loadInstallationTimeZone } from "../../../../apps/api/src/lib/installation-time-zone.js";
import type { DbExecutor } from "../../../../apps/api/src/lib/tenant-context.js";
import { ProblemError } from "../../../../apps/api/src/problem.js";
import {
  PROVIDER_WEBHOOK_BILLING_CLOSED,
  queueProviderWebhookEvent,
} from "../provider-webhooks/service.js";
import {
  type ClosedTenant,
  closeTenant,
  type DaySample,
  monthEndPrices,
  periodTotal,
  pricesInForce,
} from "./peaks.js";
import {
  daysInPeriod,
  localDay,
  periodBounds,
  periodDayRange,
  periodHasEnded,
  periodOfDay,
} from "./period.js";

/**
 * The monthly billing close (0.6.0, Service Provider; docs/ARCHITECTURE.md, "Monatsabschluss der
 * Abrechnung"): the daily sample of every tenant's billed quantities, the close of each month
 * at its peak, the corrections of a closed month and the reads of the API. Everything here runs
 * on the installation pool; a tenant's figures are read on the application pool inside its pinned
 * transaction (pricing-estimate.ts `readTenantFigures`), as the estimate reads them.
 *
 * Exactly once: the close of a month is one transaction under an exclusive advisory lock that
 * checks for the month's row first, and `billing_periods.period` is unique; the sample of a day
 * is written under the same lock, shared, and never into a closed month. A transaction cut off
 * by a crash rolls back and the next pass does it again.
 */

/** The advisory lock of the close (exclusive) and of writing a sample (shared). */
export const BILLING_CLOSE_LOCK = "restow:billing-close";

/** Tenants sampled per pass at most; the next pass takes the rest. */
export const SAMPLES_PER_PASS = 50;

/** Samples of a closed month older than this many days are removed. */
export const BILLING_SAMPLE_RETENTION_DAYS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The audit actions of the close and of a correction. */
export const BILLING_AUDIT_ACTIONS = {
  /** Installation chain, actor `system`, in the transaction of the close. */
  periodClosed: "billing.period.closed",
  /** The tenant's chain, in the transaction of the correction. */
  correctionCreated: "billing.correction.created",
  /** Installation chain: a closed month exported as CSV (Installation › Billing). */
  exported: "billing.period.exported",
} as const;

/** The gated feature that opens the provider API (Service Provider): no close without it. */
export const BILLING_FEATURE = "apiKeys.provider" as const;

type Log = (level: "info" | "warn" | "error", message: string, fields?: object) => void;

export interface BillingCloseDeps {
  /** The application pool (Row Level Security): a tenant's figures. */
  db: Database;
  /** The installation pool: everything else. */
  providerDb: Database;
  /** Appends an audit entry (lib/audit.ts); replaced in tests. */
  audit?: typeof appendAudit;
  /** Reads a tenant's figures; replaced in tests. */
  readFigures?: (db: Database, tenantId: string) => Promise<TenantFigures>;
  log?: Log;
}

async function lock(tx: DbExecutor, mode: "shared" | "exclusive"): Promise<void> {
  await tx.execute(
    mode === "shared"
      ? sql`select pg_advisory_xact_lock_shared(hashtext(${BILLING_CLOSE_LOCK}))`
      : sql`select pg_advisory_xact_lock(hashtext(${BILLING_CLOSE_LOCK}))`,
  );
}

async function periodClosed(tx: DbExecutor, period: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: billingPeriods.id })
    .from(billingPeriods)
    .where(eq(billingPeriods.period, period))
    .limit(1);
  return row !== undefined;
}

/** The quantities of a sample from a tenant's figures. */
export function quantitiesOf(figures: TenantFigures): BillingSampleQuantities {
  return {
    mailboxes: figures.mailboxes,
    storedBytes: figures.storedBytes,
    ...(figures.units ?? {}),
  };
}

// ---------------------------------------------------------------------------
// The daily sample
// ---------------------------------------------------------------------------

export interface SampleSummary {
  day: string;
  /** Tenants written in this pass. */
  sampled: number;
  /** Tenants whose figures could not be read (due again on the next pass). */
  failed: number;
}

/** Tenants (not being deleted) without a sample for `day`, the oldest first. */
async function tenantsDue(
  providerDb: Database,
  day: string,
  limit: number,
): Promise<{ id: string; pricing: TenantPricing }[]> {
  return providerDb
    .select({ id: tenants.id, pricing: tenants.pricing })
    .from(tenants)
    .where(
      and(
        ne(tenants.status, "deleting"),
        notExists(
          providerDb
            .select({ one: sql`1` })
            .from(billingSamples)
            .where(and(eq(billingSamples.tenantId, tenants.id), eq(billingSamples.day, day))),
        ),
      ),
    )
    .orderBy(asc(tenants.createdAt), asc(tenants.id))
    .limit(limit);
}

/**
 * Write today's sample (`timeZone`'s day of `now`) for the tenants that have none yet, at most
 * {@link SAMPLES_PER_PASS}: the quantities and the prices in force today (the installation's, the
 * tenant's own where the gate `tenants.additional` is open). A tenant whose figures cannot be read
 * stays due; two processes that sample the same tenant write one row.
 */
export async function sampleDueTenants(
  deps: BillingCloseDeps,
  now: Date,
  timeZone: string,
  options: { limit?: number } = {},
): Promise<SampleSummary> {
  const day = localDay(now, timeZone);
  const period = periodOfDay(day);
  const read = deps.readFigures ?? readTenantFigures;
  const due = await tenantsDue(deps.providerDb, day, options.limit ?? SAMPLES_PER_PASS);
  if (due.length === 0) {
    return { day, sampled: 0, failed: 0 };
  }
  const pricing = await getPricing(deps.providerDb);
  const overridesEnabled = await featureEnabled(TENANT_PRICING_FEATURE, deps.providerDb);
  const outcomes = await mapBounded(due, TENANT_READS_AT_ONCE, async (tenant) => {
    const tenantId = tenant.id;
    try {
      const figures = await read(deps.db, tenantId);
      return await deps.providerDb.transaction(async (tx) => {
        await lock(tx, "shared");
        // A day of a month closed meanwhile (a clock or zone change) is never added to it.
        if (await periodClosed(tx, period)) {
          return "skipped" as const;
        }
        await tx
          .insert(billingSamples)
          .values({
            tenantId,
            day,
            quantities: quantitiesOf(figures),
            prices: pricesInForce({ pricing, own: tenant.pricing, overridesEnabled }),
          })
          .onConflictDoNothing();
        return "sampled" as const;
      });
    } catch (error) {
      deps.log?.("warn", "billing sample of a tenant could not be written", {
        tenantId,
        errorMessage: safeErrorMessage(error),
      });
      return "failed" as const;
    }
  });
  return {
    day,
    sampled: outcomes.filter((outcome) => outcome === "sampled").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
  };
}

// ---------------------------------------------------------------------------
// The close
// ---------------------------------------------------------------------------

/** Months before `now`'s month (in `timeZone`) that have samples and no close, oldest first. */
export async function duePeriods(
  providerDb: Database,
  now: Date,
  timeZone: string,
): Promise<string[]> {
  const current = periodOfDay(localDay(now, timeZone));
  const month = sql<string>`to_char(${billingSamples.day}, 'YYYY-MM')`;
  const rows = await providerDb
    .selectDistinct({ period: month })
    .from(billingSamples)
    .where(
      and(
        lt(billingSamples.day, `${current}-01`),
        notExists(
          providerDb
            .select({ one: sql`1` })
            .from(billingPeriods)
            .where(eq(billingPeriods.period, month)),
        ),
      ),
    )
    .orderBy(month);
  return rows.map((row) => row.period);
}

export type CloseOutcome =
  | { status: "closed"; period: string; tenants: number; total: number | null }
  | { status: "already_closed" | "no_samples" | "open"; period: string };

/**
 * Close `period`: the peak of each tenant's samples at the prices in force now, written once with
 * its audit entry. Idempotent: a month already closed is left alone.
 */
export async function closePeriod(
  deps: BillingCloseDeps,
  period: string,
  now: Date,
  timeZone: string,
): Promise<CloseOutcome> {
  if (!periodHasEnded(period, now, timeZone)) {
    return { status: "open", period };
  }
  return deps.providerDb.transaction(async (tx) => {
    await lock(tx, "exclusive");
    if (await periodClosed(tx, period)) {
      return { status: "already_closed", period } as const;
    }
    const range = periodDayRange(period);
    const samples = await tx
      .select({
        tenantId: billingSamples.tenantId,
        day: billingSamples.day,
        quantities: billingSamples.quantities,
        prices: billingSamples.prices,
      })
      .from(billingSamples)
      .where(and(gte(billingSamples.day, range.first), lt(billingSamples.day, range.end)));
    if (samples.length === 0) {
      return { status: "no_samples", period } as const;
    }
    const byTenant = new Map<string, DaySample[]>();
    for (const sample of samples) {
      const list = byTenant.get(sample.tenantId) ?? [];
      list.push({ day: sample.day, quantities: sample.quantities, prices: sample.prices });
      byTenant.set(sample.tenantId, list);
    }
    // The prices at the close only stand in for samples that did not record theirs (written
    // before 0.6.0's migration 0107); the month's end is what counts.
    const pricing = await getPricing(tx);
    const overridesEnabled = await featureEnabled(TENANT_PRICING_FEATURE, tx);
    const monthEnd = monthEndPrices(samples)?.prices ?? null;
    const rows = await tx
      .select({
        id: tenants.id,
        name: tenants.name,
        kind: tenants.kind,
        status: tenants.status,
        customerNumber: tenants.customerNumber,
        pricing: tenants.pricing,
      })
      .from(tenants)
      .where(inArray(tenants.id, [...byTenant.keys()]))
      .orderBy(asc(tenants.name), asc(tenants.id));
    const closed: ClosedTenant[] = rows.map((row) =>
      closeTenant({ row, samples: byTenant.get(row.id) ?? [], pricing, overridesEnabled }),
    );
    const total = periodTotal(closed);
    const { startsAt, endsAt } = periodBounds(period, timeZone);
    const sampledDays = new Set(samples.map((sample) => sample.day)).size;
    const [inserted] = await tx
      .insert(billingPeriods)
      .values({
        period,
        timeZone,
        startsAt,
        endsAt,
        closedAt: now,
        currency: monthEnd?.currency ?? pricing.currency,
        storageUnit: monthEnd?.storageUnit ?? pricing.storageUnit,
        storageBilling: monthEnd?.storageBilling ?? pricing.storageBilling,
        prices: monthEnd ? { ...monthEnd.installation } : { ...globalPriceSet(pricing) },
        perTenantOverrides: monthEnd?.perTenantOverrides ?? overridesEnabled,
        days: daysInPeriod(period),
        sampledDays,
        total,
      })
      .returning({ id: billingPeriods.id });
    if (!inserted) {
      throw new Error("billing period insert returned no row");
    }
    if (closed.length > 0) {
      await tx.insert(billingPeriodTenants).values(
        closed.map((tenant) => ({
          periodId: inserted.id,
          tenantId: tenant.tenantId,
          name: tenant.name,
          customerNumber: tenant.customerNumber,
          kind: tenant.kind,
          status: tenant.status,
          complete: tenant.complete,
          sampledDays: tenant.sampledDays,
          lines: tenant.lines,
          total: tenant.total,
        })),
      );
    }
    await (deps.audit ?? appendAudit)(tx, {
      tenantId: null,
      actor: "system",
      action: BILLING_AUDIT_ACTIONS.periodClosed,
      target: period,
      targetType: "billing_period",
      details: {
        period,
        timeZone,
        tenants: closed.length,
        total,
        currency: monthEnd?.currency ?? pricing.currency,
        days: daysInPeriod(period),
        sampledDays,
      },
    });
    // The provider's webhooks (0.6.0), queued in this transaction: exactly when the close commits.
    await queueProviderWebhookEvent(tx, {
      event: PROVIDER_WEBHOOK_BILLING_CLOSED,
      data: {
        period,
        closedAt: now.toISOString(),
        currency: monthEnd?.currency ?? pricing.currency,
        tenants: closed.length,
        total,
        url: await periodUrl(tx, period),
      },
      now,
    });
    return { status: "closed", period, tenants: closed.length, total } as const;
  });
}

/**
 * Where a tool reads the closed month: the integration API's period, absolute with the
 * installation's public URL (Installation › Server, else RESTOW_PUBLIC_URL), else as a path.
 */
export async function periodUrl(tx: DbExecutor, period: string): Promise<string> {
  const path = `/api/v1/provider/billing/periods/${period}`;
  const [row] = await tx.select({ publicUrl: settings.publicUrl }).from(settings).limit(1);
  const base = row?.publicUrl ?? process.env.RESTOW_PUBLIC_URL ?? null;
  if (!base) {
    return path;
  }
  try {
    return new URL(path, new URL(base).origin).toString();
  } catch {
    return path;
  }
}

/** Close every month that is due, oldest first. */
export async function closeDuePeriods(
  deps: BillingCloseDeps,
  now: Date,
  timeZone: string,
): Promise<CloseOutcome[]> {
  const outcomes: CloseOutcome[] = [];
  for (const period of await duePeriods(deps.providerDb, now, timeZone)) {
    outcomes.push(await closePeriod(deps, period, now, timeZone));
  }
  return outcomes;
}

/** Remove the samples of closed months older than the retention; returns how many. */
export async function pruneBillingSamples(
  providerDb: Database,
  now: Date,
  timeZone: string,
): Promise<number> {
  const cutoff = localDay(
    new Date(now.getTime() - BILLING_SAMPLE_RETENTION_DAYS * DAY_MS),
    timeZone,
  );
  const removed = await providerDb
    .delete(billingSamples)
    .where(
      and(
        lt(billingSamples.day, cutoff),
        sql`exists (select 1 from ${billingPeriods} where ${billingPeriods.period} = to_char(${billingSamples.day}, 'YYYY-MM'))`,
      ),
    )
    .returning({ id: billingSamples.id });
  return removed.length;
}

export interface BillingPassSummary {
  /** False while the edition does not offer the provider API: nothing was done. */
  enabled: boolean;
  timeZone?: string;
  closed?: CloseOutcome[];
  samples?: SampleSummary;
}

/**
 * One pass of the service: close what is due, then sample today. Nothing while the license does
 * not open the provider API.
 */
export async function runBillingPass(
  deps: BillingCloseDeps,
  now: Date,
): Promise<BillingPassSummary> {
  if (!(await featureEnabled(BILLING_FEATURE, deps.providerDb))) {
    return { enabled: false };
  }
  const { timeZone } = await loadInstallationTimeZone(deps.providerDb);
  const closed = await closeDuePeriods(deps, now, timeZone);
  for (const outcome of closed) {
    if (outcome.status === "closed") {
      deps.log?.("info", "billing period closed", outcome);
    }
  }
  const samples = await sampleDueTenants(deps, now, timeZone);
  return { enabled: true, timeZone, closed, samples };
}

// ---------------------------------------------------------------------------
// Reads and corrections
// ---------------------------------------------------------------------------

export interface LoadedPeriod {
  period: BillingPeriodRow;
  tenants: BillingPeriodTenantRow[];
  corrections: BillingCorrectionRow[];
}

/** Every closed month, newest first. */
export async function listClosedPeriods(providerDb: Database): Promise<
  {
    period: BillingPeriodRow;
    tenants: number;
    /** Corrections of the customers (not `internal`) added up. */
    customerCorrections: number;
    corrections: number;
  }[]
> {
  const periods = await providerDb
    .select()
    .from(billingPeriods)
    .orderBy(desc(billingPeriods.period));
  const counts = await providerDb
    .select({
      periodId: billingPeriodTenants.periodId,
      count: sql<number>`count(*)::int`,
    })
    .from(billingPeriodTenants)
    .groupBy(billingPeriodTenants.periodId);
  const corrections = await providerDb
    .select({
      periodId: billingCorrections.periodId,
      amount: billingCorrections.amount,
      kind: billingPeriodTenants.kind,
    })
    .from(billingCorrections)
    .innerJoin(
      billingPeriodTenants,
      and(
        eq(billingPeriodTenants.periodId, billingCorrections.periodId),
        eq(billingPeriodTenants.tenantId, billingCorrections.tenantId),
      ),
    );
  const tenantCounts = new Map(counts.map((row) => [row.periodId, row.count]));
  return periods.map((period) => {
    const own = corrections.filter((row) => row.periodId === period.id);
    return {
      period,
      tenants: tenantCounts.get(period.id) ?? 0,
      customerCorrections: own
        .filter((row) => row.kind !== "internal")
        .reduce((sum, row) => sum + row.amount, 0),
      corrections: own.length,
    };
  });
}

/** One closed month with its tenants and corrections; null when it is not closed. */
export async function loadClosedPeriod(
  providerDb: Database,
  period: string,
): Promise<LoadedPeriod | null> {
  const [row] = await providerDb
    .select()
    .from(billingPeriods)
    .where(eq(billingPeriods.period, period))
    .limit(1);
  if (!row) {
    return null;
  }
  const tenantRows = await providerDb
    .select()
    .from(billingPeriodTenants)
    .where(eq(billingPeriodTenants.periodId, row.id))
    .orderBy(asc(billingPeriodTenants.name), asc(billingPeriodTenants.tenantId));
  const corrections = await providerDb
    .select()
    .from(billingCorrections)
    .where(eq(billingCorrections.periodId, row.id))
    .orderBy(asc(billingCorrections.createdAt), asc(billingCorrections.id));
  return { period: row, tenants: tenantRows, corrections };
}

export interface CorrectionInput {
  period: string;
  tenantId: string;
  lineType: string | null;
  amount: number;
  reason: string;
  actor: { label: string; keyId: string | null; ip: string | null; userId?: string | null };
}

/**
 * Add a correction to a closed month: a row of its own next to the close, audited in the
 * tenant's chain in the same transaction. 404 when the month is not closed or the tenant is not
 * in it.
 */
export async function createCorrection(
  deps: Pick<BillingCloseDeps, "providerDb" | "audit">,
  input: CorrectionInput,
): Promise<BillingCorrectionRow> {
  return deps.providerDb.transaction(async (tx) => {
    const [period] = await tx
      .select({ id: billingPeriods.id })
      .from(billingPeriods)
      .where(eq(billingPeriods.period, input.period))
      .limit(1);
    if (!period) {
      throw new ProblemError(404, "Billing period not closed", {
        detail: "Only a closed month takes corrections.",
      });
    }
    const [member] = await tx
      .select({ id: billingPeriodTenants.id })
      .from(billingPeriodTenants)
      .where(
        and(
          eq(billingPeriodTenants.periodId, period.id),
          eq(billingPeriodTenants.tenantId, input.tenantId),
        ),
      )
      .limit(1);
    if (!member) {
      throw new ProblemError(404, "Tenant not found", {
        detail: "The tenant is not part of this closed month.",
      });
    }
    const [row] = await tx
      .insert(billingCorrections)
      .values({
        periodId: period.id,
        tenantId: input.tenantId,
        lineType: input.lineType,
        amount: input.amount,
        reason: input.reason,
        actor: input.actor.label,
        apiKeyId: input.actor.keyId,
      })
      .returning();
    if (!row) {
      throw new Error("billing correction insert returned no row");
    }
    await (deps.audit ?? appendAudit)(tx, {
      tenantId: input.tenantId,
      actor: input.actor.label,
      actorUserId: input.actor.userId ?? null,
      action: BILLING_AUDIT_ACTIONS.correctionCreated,
      target: row.id,
      targetType: "billing_correction",
      ip: input.actor.ip,
      details: {
        keyId: input.actor.keyId,
        period: input.period,
        lineType: input.lineType,
        amount: input.amount,
        reason: input.reason,
      },
    });
    return row;
  });
}
