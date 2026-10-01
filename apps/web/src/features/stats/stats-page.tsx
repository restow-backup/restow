import { Building2, ChartColumn, FileDown, ShieldAlert, TriangleAlert } from "lucide-react";
import * as React from "react";

import { ErrorState, PageHeader, RefreshButton } from "@/components/kit";
import { RequireRole } from "@/components/require-role";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/session";

import type { StatsDataset } from "./api.js";
import {
  DatasetMenu,
  DownloadIcon,
  type StatsExports,
  StatsExportsProvider,
} from "./components/chart-parts.js";
import { FailuresTable } from "./components/failures-table.js";
import { KpiGrid } from "./components/kpi-grid.js";
import { LargestObjectsTable } from "./components/largest-objects-table.js";
import { JobDurationsChart, ThrottlingChart } from "./components/operations-charts.js";
import { BackupsChart, ReadinessChart, RestoresChart } from "./components/outcome-charts.js";
import { PeriodSelector } from "./components/period-selector.js";
import { ScopeToggle } from "./components/scope-toggle.js";
import { StatsSection } from "./components/section.js";
import { TenantsTable } from "./components/tenants-table.js";
import { StorageChart, VolumeChart } from "./components/volume-charts.js";
import { csvDownload, pdfDownload } from "./exports.js";
import {
  STATS_ROLES,
  type StatsAccess,
  useDownloads,
  useResolvedPeriod,
  useStatsAccess,
  useStatsOverview,
  useStatsSearch,
} from "./hooks.js";
import {
  type ResolvedPeriod,
  type StatsScope,
  type StatsSearch,
  previousPeriodDays,
  withScope,
} from "./period.js";
import { boundsToDays, dedupFigures } from "./presenters.js";
import { type StatsFormat, useStatsFormat } from "./use-stats-format.js";

/**
 * Statistics: how backups, restores, storage and recoverability developed
 * over a period, compared with the period before. Every figure either shows
 * real data or says why it cannot; the period and the scope live in the URL.
 */
export function StatsPage() {
  return (
    <RequireRole roles={STATS_ROLES}>
      <StatsContent />
    </RequireRole>
  );
}

function StatsContent() {
  const { search, update } = useStatsSearch();
  const access = useStatsAccess(search);
  const period = useResolvedPeriod(search);
  const { t } = useStatsFormat();

  switch (access.kind) {
    case "loading":
      return (
        <div className="space-y-6">
          <PageHeader
            icon={ChartColumn}
            title={t("title")}
            description={t("description.loading")}
          />
          <KpiGrid kpis={undefined} />
        </div>
      );
    case "noTenant":
      return (
        <div className="space-y-6">
          <PageHeader icon={ChartColumn} title={t("title")} />
          <Alert variant="info">
            <Building2 />
            <AlertTitle>{t("noTenant.title")}</AlertTitle>
            <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{t("noTenant.description")}</span>
              {access.providerAllowed ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => update(withScope(search, "provider"))}
                >
                  {t("noTenant.providerAction")}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        </div>
      );
    case "notAdmin":
      return (
        <div className="space-y-6">
          <PageHeader icon={ChartColumn} title={t("title")} />
          <Alert variant="warning">
            <ShieldAlert />
            <AlertTitle>{t("notAdmin.title")}</AlertTitle>
            <AlertDescription>
              {t("notAdmin.description", { tenant: access.tenantName })}
            </AlertDescription>
          </Alert>
        </div>
      );
    default:
      return <StatsView access={access} search={search} update={update} period={period} />;
  }
}

interface StatsViewProps {
  access: Extract<StatsAccess, { kind: "ready" }>;
  search: StatsSearch;
  update: (next: StatsSearch) => void;
  period: ResolvedPeriod;
}

/** The comparison period in words: the server's statement, else the same length before. */
function comparisonLabel(
  format: StatsFormat,
  period: ResolvedPeriod,
  previous: { from: string; to: string } | null | undefined,
): string {
  const days = (previous ? boundsToDays(previous) : null) ?? previousPeriodDays(period);
  return format.range(days.firstDay, days.lastDay);
}

function StatsView({ access, search, update, period }: StatsViewProps) {
  const format = useStatsFormat();
  const { t, language } = format;
  const { setActiveTenant } = useSession();
  const { query, params } = useStatsOverview(access, period);
  const downloads = useDownloads();
  const data = query.data;
  const provider = access.scope === "provider";

  const exports = React.useMemo<StatsExports>(
    () => ({
      csv: (dataset: StatsDataset) =>
        void downloads.start(
          `csv:${dataset}`,
          csvDownload(dataset, params, period),
          t("download.csvPreparing"),
        ),
      csvPending: (dataset: StatsDataset) => downloads.pending(`csv:${dataset}`),
    }),
    [downloads, params, period, t],
  );

  const exportPdf = () =>
    void downloads.start("pdf", pdfDownload(params, period, language), t("download.pdfPreparing"));

  const changeScope = (scope: StatsScope) => update(withScope(search, scope));
  const openTenantStats = React.useCallback(
    (tenantId: string) => {
      setActiveTenant(tenantId);
      update(withScope(search, "tenant"));
    },
    [setActiveTenant, update, search],
  );

  const sectionId = React.useId();
  const failedFirstLoad = query.isError && data === undefined;
  const staleError = query.isError && data !== undefined;

  return (
    <StatsExportsProvider value={exports}>
      <div className="space-y-6">
        <div className="space-y-4">
          <PageHeader
            icon={ChartColumn}
            title={t("title")}
            description={
              provider
                ? t("description.provider")
                : t("description.tenant", { tenant: access.tenantName ?? "" })
            }
          >
            <RefreshButton
              onRefresh={() => void query.refetch()}
              fetching={query.isFetching}
              label={t("actions.refresh")}
              variant="outline"
              size="icon"
            />
            <Button onClick={exportPdf} aria-busy={downloads.pending("pdf") || undefined}>
              <DownloadIcon pending={downloads.pending("pdf")} icon={FileDown} />
              {t("actions.exportPdf")}
            </Button>
          </PageHeader>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <PeriodSelector search={search} period={period} onChange={update} />
            {access.providerAllowed ? (
              <ScopeToggle scope={access.scope} onChange={changeScope} />
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground" data-slot="stats-period">
            {t("period.summary", {
              range: format.range(period.firstDay, period.lastDay),
              granularity: format.granularity(period.granularity),
            })}{" "}
            {t("period.comparison", { range: comparisonLabel(format, period, data?.previous) })}
          </p>
        </div>

        {failedFirstLoad ? (
          <ErrorState
            title={t("error.title")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : (
          <>
            {staleError ? (
              <Alert variant="warning">
                <TriangleAlert />
                <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span>{t("error.stale")}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void query.refetch()}
                    loading={query.isFetching}
                  >
                    {t("error.retry")}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}

            <StatsSection
              id={`${sectionId}-kpis`}
              title={t("kpi.sectionLabel")}
              action={data ? <DatasetMenu dataset="kpis" title={t("kpi.sectionLabel")} /> : null}
            >
              <KpiGrid kpis={data?.kpis} />
            </StatsSection>

            {provider && data?.tables.tenants !== null ? (
              <TenantsTable data={data?.tables.tenants} onOpenTenantStats={openTenantStats} />
            ) : null}

            <StatsSection id={`${sectionId}-trends`} title={t("charts.sectionLabel")}>
              <BackupsChart data={data?.series.backups} granularity={period.granularity} />
              <div className="grid grid-cols-1 gap-4 *:min-w-0 lg:grid-cols-2">
                <RestoresChart data={data?.series.restores} granularity={period.granularity} />
                <ReadinessChart data={data?.series.readiness} granularity={period.granularity} />
                <VolumeChart
                  data={data?.series.volume}
                  granularity={period.granularity}
                  dedup={data ? dedupFigures(data.kpis) : null}
                />
                <StorageChart data={data?.series.storage} granularity={period.granularity} />
                <JobDurationsChart data={data?.series.jobDurations} />
                <ThrottlingChart data={data?.series.throttling} granularity={period.granularity} />
              </div>
            </StatsSection>

            <StatsSection id={`${sectionId}-details`} title={t("tables.sectionLabel")}>
              <FailuresTable data={data?.tables.failuresByCause} />
              <LargestObjectsTable data={data?.tables.largestObjects} />
            </StatsSection>
          </>
        )}
      </div>
    </StatsExportsProvider>
  );
}
