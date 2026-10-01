import type { ReportSection } from "@restow/core";
import { isReportSection } from "@restow/core";
import { createI18n } from "@restow/i18n";
import type { ApiExtension } from "../../../../apps/api/src/extensions.js";
import type { ReportSummaryRenderer } from "../../../../apps/api/src/features/reports/hooks.js";
import { renderSummaryFrame } from "../../../../apps/api/src/features/reports/render.js";
import { aggregateTenant } from "../../../../apps/api/src/features/stats/aggregate.js";
import { buildStats } from "../../../../apps/api/src/features/stats/build.js";
import { collectTenantFacts } from "../../../../apps/api/src/features/stats/collect.js";
import { type KpiDto, isUnavailable } from "../../../../apps/api/src/features/stats/dto.js";
import { resolvePeriod, utcDay } from "../../../../apps/api/src/features/stats/period.js";
import type { Transaction } from "../../../../apps/api/src/lib/tenant-context.js";

/**
 * Summary reports (Business, capability `reports.scheduled`): the key figures
 * of the statistics page for the rule's period, one block per chosen section.
 * The core queues and delivers the report (apps/api features/reports); this
 * module only builds its content, from the same code the statistics page
 * uses, so a report never says something the page would not.
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

export const summaryRenderer: ReportSummaryRenderer = {
  async render(input) {
    const i18n = createI18n({ lng: input.language });
    const t = (key: string, values?: Record<string, unknown>) => String(i18n.t(key, values));
    const locale = input.language === "de" ? "de-DE" : "en-GB";
    const payload = input.payload;
    const end = new Date(String(payload.periodEnd ?? new Date().toISOString()));
    const days = typeof payload.periodDays === "number" ? payload.periodDays : 7;
    const period = resolvePeriod(
      { from: utcDay(new Date(end.getTime() - (days - 1) * DAY_MS)), to: utcDay(end) },
      end,
    );
    const facts = await collectTenantFacts(
      input.db as Transaction,
      { id: input.tenantId, name: input.tenantName },
      period,
    );
    const stats = buildStats({
      period,
      scope: "tenant",
      tenants: [aggregateTenant(facts, period, "tenant")],
      generatedAt: end,
    });
    const { kpis } = stats;
    const previous = t("reports:summary.previous");
    const sections = (Array.isArray(payload.sections) ? payload.sections : []).filter(
      (section): section is ReportSection =>
        typeof section === "string" && isReportSection(section),
    );

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

    const message = renderSummaryFrame(
      {
        language: input.language,
        tenantName: input.tenantName,
        ruleName: input.ruleName,
        payload,
        test: input.test,
      },
      rows,
    );
    return {
      ...message,
      headline: {
        backupSuccessRate: kpis.backupSuccessRate.value,
        verifiedShare: kpis.verifiedShare.value,
        failedItems: kpis.failedItems.value,
      },
    };
  },
};

export const reportsExtensionHooks: NonNullable<ApiExtension["hooks"]> = {
  reportSummary: summaryRenderer,
};
