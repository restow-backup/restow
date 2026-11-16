import type { ReportSection } from "@restow/core";
import { isReportSection, REPORT_SECTIONS } from "@restow/core";
import { tenants } from "@restow/db";
import { createI18n } from "@restow/i18n";
import { asc, eq } from "drizzle-orm";
import type { ApiExtension } from "../../../../apps/api/src/extensions.js";
import type {
  ReportRenderInput,
  ReportSummaryRenderer,
} from "../../../../apps/api/src/features/reports/hooks.js";
import { renderSummaryFrame } from "../../../../apps/api/src/features/reports/render.js";
import {
  aggregateTenant,
  type TenantAggregate,
} from "../../../../apps/api/src/features/stats/aggregate.js";
import { buildStats } from "../../../../apps/api/src/features/stats/build.js";
import { collectTenantFacts } from "../../../../apps/api/src/features/stats/collect.js";
import { isUnavailable, type KpiDto } from "../../../../apps/api/src/features/stats/dto.js";
import {
  type ResolvedPeriod,
  resolvePeriod,
  utcDay,
} from "../../../../apps/api/src/features/stats/period.js";
import { type Transaction, withTenantTx } from "../../../../apps/api/src/lib/tenant-context.js";
import { renderStatsReport } from "../../../../apps/api/src/reports/stats-report.js";
import { customerReportHooks } from "./customer.js";

/**
 * Summary reports (Business, capability `reports.scheduled`): the key figures
 * of the statistics page for the rule's period, one block per chosen section.
 * The core queues and delivers the report (apps/api features/reports); this
 * module only builds its content, from the same code the statistics page
 * uses, so a report never says something the page would not.
 *
 * Since 0.5.0 a report covers the calendar day, week or month its rule names (the scheduler puts
 * the period's days, `fromDay` and `toDay`, into the payload), the provider's report sums every
 * active tenant (scope `provider`, the tenants read one tenant-pinned transaction each), and with
 * `attachPdf` the statistics report goes along as a PDF in the mail's brand.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function bytes(value: number | null, language: string): string {
  if (value === null) return "–";
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  let size = value;
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit++;
  }
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(size)} ${units[unit]}`;
}

function share(value: number | null, language: string): string {
  return value === null
    ? "–"
    : new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function count(value: number | null, language: string): string {
  return value === null ? "–" : new Intl.NumberFormat(language).format(value);
}

/** "12 (previous: 9)", so a trend is visible without a chart. */
function withPrevious(kpi: KpiDto, format: (value: number | null) => string, previous: string) {
  return kpi.previous === null
    ? format(kpi.value)
    : `${format(kpi.value)} (${previous}: ${format(kpi.previous)})`;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The statistics period of a report: the calendar days the payload names (a cadence rule), else
 * the `periodDays` ending with the run (a rule with its own interval or cron).
 */
export function summaryPeriod(payload: Record<string, unknown>, generatedAt: Date): ResolvedPeriod {
  const end = new Date(String(payload.periodEnd ?? generatedAt.toISOString()));
  const fromDay =
    typeof payload.fromDay === "string" && DAY_PATTERN.test(payload.fromDay)
      ? payload.fromDay
      : null;
  const toDay =
    typeof payload.toDay === "string" && DAY_PATTERN.test(payload.toDay) ? payload.toDay : null;
  if (fromDay && toDay) {
    return resolvePeriod({ from: fromDay, to: toDay }, end);
  }
  const days = typeof payload.periodDays === "number" ? payload.periodDays : 7;
  return resolvePeriod(
    { from: utcDay(new Date(end.getTime() - (days - 1) * DAY_MS)), to: utcDay(end) },
    end,
  );
}

/** The figures of one tenant, or of every active tenant for the provider. */
export async function summaryAggregates(
  input: Pick<
    ReportRenderInput,
    "db" | "providerDb" | "tenantPool" | "scope" | "tenantId" | "tenantName"
  >,
  period: ResolvedPeriod,
): Promise<{ aggregates: TenantAggregate[]; tenantCount: number }> {
  if (input.scope === "tenant" && input.tenantId) {
    const facts = await collectTenantFacts(
      input.db as Transaction,
      { id: input.tenantId, name: input.tenantName },
      period,
    );
    return { aggregates: [aggregateTenant(facts, period, "tenant")], tenantCount: 1 };
  }
  const covered = await input.providerDb
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.status, "active"))
    .orderBy(asc(tenants.name), asc(tenants.id));
  const aggregates: TenantAggregate[] = [];
  for (const tenant of covered) {
    const facts = await withTenantTx(input.tenantPool, tenant.id, (tx) =>
      collectTenantFacts(tx, tenant, period),
    );
    aggregates.push(aggregateTenant(facts, period, "provider"));
  }
  return { aggregates, tenantCount: covered.length };
}

export const summaryRenderer: ReportSummaryRenderer = {
  async render(input) {
    const i18n = createI18n(
      input.brand
        ? { lng: input.language, appName: input.brand.senderName }
        : { lng: input.language },
    );
    const t = (key: string, values?: Record<string, unknown>) => String(i18n.t(key, values));
    const locale = input.language === "de" ? "de-DE" : "en-GB";
    const payload = input.payload;
    const generatedAt = new Date();
    const period = summaryPeriod(payload, generatedAt);
    const { aggregates, tenantCount } = await summaryAggregates(input, period);
    const stats = buildStats({
      period,
      scope: input.scope,
      tenants: aggregates,
      generatedAt: new Date(String(payload.periodEnd ?? generatedAt.toISOString())),
    });
    const { kpis } = stats;
    const previous = t("reports:summary.previous");
    // The provider's report and a cadence rule without a choice of sections show every block.
    const requested = (Array.isArray(payload.sections) ? payload.sections : []).filter(
      (section): section is ReportSection =>
        typeof section === "string" && isReportSection(section),
    );
    const sections = requested.length > 0 ? requested : [...REPORT_SECTIONS];

    const rows: [string, string][] = [];
    for (const section of sections) {
      switch (section) {
        case "backups":
          rows.push([
            t("reports:summary.backupSuccessRate"),
            withPrevious(kpis.backupSuccessRate, (v) => share(v, locale), previous),
          ]);
          rows.push([
            t("reports:summary.failedItems"),
            withPrevious(kpis.failedItems, (v) => count(v, locale), previous),
          ]);
          break;
        case "readiness":
          rows.push([
            t("reports:summary.verifiedShare"),
            withPrevious(kpis.verifiedShare, (v) => share(v, locale), previous),
          ]);
          rows.push([
            t("reports:summary.protectedObjects"),
            withPrevious(kpis.protectedObjects, (v) => count(v, locale), previous),
          ]);
          break;
        case "failures": {
          const causes = stats.tables.failuresByCause;
          if (isUnavailable(causes) || causes.length === 0) {
            rows.push([t("reports:summary.failures"), t("reports:summary.noFailures")]);
          } else {
            for (const cause of causes.slice(0, 5)) {
              rows.push([
                t("reports:summary.failure"),
                `${cause.cause} (${count(cause.count, locale)}×)`,
              ]);
            }
          }
          break;
        }
        case "storage":
          rows.push([
            t("reports:summary.logicalBytes"),
            withPrevious(kpis.logicalBytes, (v) => bytes(v, locale), previous),
          ]);
          rows.push([
            t("reports:summary.physicalBytes"),
            withPrevious(kpis.physicalBytes, (v) => bytes(v, locale), previous),
          ]);
          break;
        case "restores":
          rows.push([
            t("reports:summary.restores"),
            withPrevious(kpis.restores, (v) => count(v, locale), previous),
          ]);
          break;
      }
    }

    if (input.scope === "provider") {
      rows.unshift([t("reports:summary.tenants"), count(tenantCount, locale)]);
    }

    const message = renderSummaryFrame(
      {
        language: input.language,
        tenantName: input.tenantName,
        ruleName: input.ruleName,
        payload,
        test: input.test,
        brand: input.brand,
      },
      rows,
    );
    const attachments = input.attachPdf
      ? [
          {
            filename: `summary-${period.current.from}-${period.current.to}.pdf`,
            contentType: "application/pdf",
            content: await renderStatsReport({
              stats,
              language: input.language,
              subject:
                input.scope === "provider"
                  ? { kind: "provider", tenantCount }
                  : { kind: "tenant", name: input.tenantName },
              brand: input.pdfBrand ?? null,
            }),
          },
        ]
      : [];
    return {
      ...message,
      headline: {
        backupSuccessRate: kpis.backupSuccessRate.value,
        verifiedShare: kpis.verifiedShare.value,
        failedItems: kpis.failedItems.value,
      },
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  },
};

export const reportsExtensionHooks: NonNullable<ApiExtension["hooks"]> = {
  reportSummary: summaryRenderer,
  ...customerReportHooks,
};
