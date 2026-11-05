import { monthPeriod } from "@restow/core";
import { notifications, protectedObjects } from "@restow/db";
import { createI18n } from "@restow/i18n";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { ApiExtension } from "../../../../apps/api/src/extensions.js";
import type {
  CustomerReportRenderer,
  ReportRenderInput,
} from "../../../../apps/api/src/features/reports/hooks.js";
import { renderSummaryFrame } from "../../../../apps/api/src/features/reports/render.js";
import { aggregateTenant } from "../../../../apps/api/src/features/stats/aggregate.js";
import { buildStats } from "../../../../apps/api/src/features/stats/build.js";
import { collectTenantFacts } from "../../../../apps/api/src/features/stats/collect.js";
import { isUnavailable } from "../../../../apps/api/src/features/stats/dto.js";
import { resolvePeriod } from "../../../../apps/api/src/features/stats/period.js";
import type { Transaction } from "../../../../apps/api/src/lib/tenant-context.js";
import {
  type CustomerReportFigures,
  renderCustomerReport,
} from "../../../../apps/api/src/reports/customer-report.js";

/**
 * The customer monthly report (Service Provider, capability `reports.customer`, 0.5.0): an HTML
 * mail and a PDF for a tenant's contacts, in the provider's branding or the tenant's own. The
 * figures are the statistics page's for the calendar month (UTC days), plus the protected objects
 * per kind and the count of suspicious findings. Plain language, no prices.
 */

const SUSPICIOUS_EVENTS = ["backup.suspicious", "endpoint.suspicious_snapshot"];

function monthDays(month: string): { from: string; to: string } {
  const period = monthPeriod(month, "UTC");
  if (!period) {
    throw new RangeError(`not a month: ${month}`);
  }
  const last = new Date(period.end.getTime() - 24 * 60 * 60_000);
  return { from: period.start.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** The report's figures for one tenant and month. */
export async function customerFigures(
  tx: Transaction,
  tenant: { id: string; name: string },
  month: string,
  now: Date = new Date(),
): Promise<CustomerReportFigures> {
  const days = monthDays(month);
  // A preview of the month in progress reads up to its last day.
  const period = resolvePeriod(
    days,
    new Date(Math.max(now.getTime(), Date.parse(`${days.to}T12:00:00Z`))),
  );
  const facts = await collectTenantFacts(tx, tenant, period);
  const stats = buildStats({
    period,
    scope: "tenant",
    tenants: [aggregateTenant(facts, period, "tenant")],
    generatedAt: now,
  });
  const kinds = await tx
    .select({ kind: protectedObjects.kind, count: sql<number>`count(*)::int` })
    .from(protectedObjects)
    .where(eq(protectedObjects.tenantId, tenant.id))
    .groupBy(protectedObjects.kind)
    .orderBy(protectedObjects.kind);
  const [suspicious] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.tenantId, tenant.id),
        inArray(notifications.event, SUSPICIOUS_EVENTS),
        gte(notifications.createdAt, period.current.start),
        lt(notifications.createdAt, period.current.end),
      ),
    );
  const causes = stats.tables.failuresByCause;
  return {
    objectsByKind: kinds.map((row) => ({ kind: String(row.kind), count: row.count })),
    backupSuccessRate: stats.kpis.backupSuccessRate.value,
    verifiedShare: stats.kpis.verifiedShare.value,
    restores: stats.kpis.restores.value,
    storedBytes: stats.kpis.physicalBytes.value,
    causes: isUnavailable(causes)
      ? []
      : causes.slice(0, 5).map((cause) => ({ cause: cause.cause, count: cause.count })),
    suspicious: suspicious?.count ?? 0,
  };
}

type CustomerInput = ReportRenderInput & { readonly month: string };

async function pdfOf(input: CustomerInput, figures: CustomerReportFigures): Promise<Buffer> {
  return renderCustomerReport({
    language: input.language,
    tenantName: input.tenantName,
    month: input.month,
    figures,
    brand: input.pdfBrand ?? null,
    generatedAt: new Date(),
  });
}

function percent(value: number | null, locale: string): string {
  return value === null
    ? "–"
    : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value);
}

export const customerRenderer: CustomerReportRenderer = {
  async render(input) {
    if (!input.tenantId) {
      throw new Error("the customer report needs a tenant");
    }
    const i18n = createI18n(
      input.brand
        ? { lng: input.language, appName: input.brand.senderName }
        : { lng: input.language },
    );
    const t = (key: string, values?: Record<string, unknown>) => String(i18n.t(key, values));
    const locale = input.language === "de" ? "de-DE" : "en-GB";
    const figures = await customerFigures(
      input.db as Transaction,
      { id: input.tenantId, name: input.tenantName },
      input.month,
    );
    const count = (value: number | null) =>
      value === null ? "–" : new Intl.NumberFormat(locale).format(value);
    const rows: [string, string][] = [
      ...figures.objectsByKind.map(
        (row) => [t(`reports:customer.kinds.${row.kind}`), count(row.count)] as [string, string],
      ),
      [t("reports:customer.kpis.backupSuccessRate"), percent(figures.backupSuccessRate, locale)],
      [t("reports:customer.kpis.verifiedShare"), percent(figures.verifiedShare, locale)],
      [t("reports:customer.kpis.restores"), count(figures.restores)],
      [t("reports:customer.kpis.suspicious"), count(figures.suspicious)],
      ...figures.causes.map(
        (cause) =>
          [t("reports:customer.incidents.cause"), `${cause.cause} (${count(cause.count)}×)`] as [
            string,
            string,
          ],
      ),
    ];
    const period = monthPeriod(input.month, "UTC");
    const message = renderSummaryFrame(
      {
        language: input.language,
        tenantName: input.tenantName,
        ruleName: input.ruleName,
        payload: {
          periodStart: period?.start.toISOString(),
          periodEnd: period?.end.toISOString(),
        },
        test: input.test,
        brand: input.brand,
      },
      rows,
    );
    return {
      ...message,
      headline: {
        month: input.month,
        backupSuccessRate: figures.backupSuccessRate,
        verifiedShare: figures.verifiedShare,
      },
      attachments: [
        {
          filename: `report-${input.month}.pdf`,
          contentType: "application/pdf",
          content: await pdfOf(input, figures),
        },
      ],
    };
  },

  async pdf(input) {
    if (!input.tenantId) {
      throw new Error("the customer report needs a tenant");
    }
    const figures = await customerFigures(
      input.db as Transaction,
      { id: input.tenantId, name: input.tenantName },
      input.month,
    );
    return pdfOf(input, figures);
  },
};

export const customerReportHooks: NonNullable<ApiExtension["hooks"]> = {
  reportCustomer: customerRenderer,
};
