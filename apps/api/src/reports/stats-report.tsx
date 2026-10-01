import { JOB_QUEUES } from "@restow/core";
import type { ReactNode } from "react";
import {
  type Dataset,
  type FailureCauseDto,
  type JobDurationDto,
  KPI_NAMES,
  type KpiDto,
  type KpiName,
  type LargestObjectDto,
  type StatsDto,
  type TenantRowDto,
  type UnavailableReason,
  isUnavailable,
} from "../features/stats/dto.js";
import type { Granularity } from "../features/stats/period.js";
import type { ObjectState } from "../features/verify/summary.js";
import { Legend, Notes, Notice, Section } from "./blocks.js";
import { BarChart, type ChartSeries, LineChart } from "./charts.js";
import { ReportDocument, ReportHeader, ReportPage } from "./document.js";
import {
  type ReportLanguage,
  formatBytes,
  formatDateTime,
  formatDay,
  formatDecimal,
  formatDuration,
  formatInteger,
  formatMonth,
  formatPercent,
  formatShortDay,
  signed,
} from "./format.js";
import { type Translate, reportTranslator } from "./i18n.js";
import { KpiGrid, type KpiTile } from "./kpi.js";
import { renderPdf } from "./render.js";
import { ReportTable, type TableCell, type TableColumn } from "./table.js";
import { type Tone, colors } from "./theme.js";

/**
 * The statistics report (`GET /api/v1/stats/report.pdf`): the same figures
 * as the stats page — key figures with their change, the charts, the tables
 * — and a short note on how each figure is measured. Datasets without a data
 * source say so instead of showing zeros.
 */

export type StatsReportSubject =
  | { readonly kind: "tenant"; readonly name: string }
  | { readonly kind: "provider"; readonly tenantCount: number };

export interface StatsReportProps {
  readonly stats: StatsDto;
  readonly subject: StatsReportSubject;
  readonly language: ReportLanguage;
}

/** Everything the parts of the report share. */
interface Context {
  readonly t: Translate;
  readonly language: ReportLanguage;
  readonly granularity: Granularity;
  readonly bytes: (value: number) => string;
  readonly count: (value: number) => string;
  readonly duration: (value: number) => string;
}

// ---------------------------------------------------------------------------
// Key figures
// ---------------------------------------------------------------------------

type KpiKind = "percent" | "count" | "bytes" | "ratio" | "duration";
type GoodDirection = "up" | "down" | "neutral";

/** How each figure is shown, and which direction of change is good news. */
const KPI_FORMAT: Record<KpiName, { kind: KpiKind; good: GoodDirection }> = {
  backupSuccessRate: { kind: "percent", good: "up" },
  protectedObjects: { kind: "count", good: "up" },
  logicalBytes: { kind: "bytes", good: "neutral" },
  physicalBytes: { kind: "bytes", good: "neutral" },
  dedupRatio: { kind: "ratio", good: "up" },
  restores: { kind: "count", good: "neutral" },
  verifiedShare: { kind: "percent", good: "up" },
  throttlingWaitSeconds: { kind: "duration", good: "down" },
  failedItems: { kind: "count", good: "down" },
};

function formatKpi(kind: KpiKind, value: number, context: Context): string {
  switch (kind) {
    case "percent":
      return formatPercent(value, context.language);
    case "count":
      return context.count(value);
    case "bytes":
      return context.bytes(value);
    case "ratio":
      return `${formatDecimal(value, context.language, 2)}×`;
    case "duration":
      return context.duration(value);
  }
}

function kpiTile(name: KpiName, kpi: KpiDto, context: Context): KpiTile {
  const { t, language } = context;
  const { kind, good } = KPI_FORMAT[name];
  const label = t(`stats.kpi.${name}`);
  if (kpi.value === null) {
    return { label, value: t("document.notAvailable"), muted: true };
  }
  const tile = { label, value: formatKpi(kind, kpi.value, context) };
  if (kpi.previous === null) {
    return { ...tile, delta: t("stats.delta.none") };
  }
  const change = kpi.value - kpi.previous;
  if (Math.abs(change) < 1e-9) {
    return { ...tile, delta: t("stats.delta.unchanged") };
  }
  // Rates change by percentage points, everything else in its own unit.
  const amount =
    kind === "percent"
      ? t("stats.delta.points", { value: signed(change, formatDecimal(change * 100, language)) })
      : signed(change, formatKpi(kind, change, context));
  const tone: Tone =
    good === "neutral" ? "neutral" : change > 0 === (good === "up") ? "success" : "destructive";
  return { ...tile, delta: t("stats.delta.change", { value: amount }), deltaTone: tone };
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function unavailableNotice(reason: UnavailableReason, t: Translate) {
  return <Notice title={t("document.notAvailable")} text={t(`unavailable.${reason}`)} />;
}

type ChartName = "backups" | "volume" | "storage" | "restores" | "readiness" | "throttling";

interface ChartSectionProps<Row extends { t: string }> {
  readonly name: ChartName;
  readonly dataset: Dataset<Row>;
  readonly type: "stacked" | "grouped" | "line";
  readonly series: (rows: readonly Row[]) => ChartSeries[];
  readonly formatValue: (value: number) => string;
  readonly integer?: boolean;
  readonly context: Context;
}

function ChartSection<Row extends { t: string }>(props: ChartSectionProps<Row>) {
  const { dataset, context } = props;
  const { t, granularity, language } = context;
  let body: ReactNode;
  if (isUnavailable(dataset)) {
    body = unavailableNotice(dataset.unavailable, t);
  } else {
    const series = props.series(dataset);
    const chart = {
      categories: dataset.map((row) =>
        granularity === "month" ? formatMonth(row.t, language) : formatShortDay(row.t, language),
      ),
      series,
      formatValue: props.formatValue,
      integer: props.integer,
    };
    body = (
      <>
        {props.type === "line" ? (
          <LineChart {...chart} />
        ) : (
          <BarChart {...chart} stacked={props.type === "stacked"} />
        )}
        <Legend entries={series.map(({ label, color }) => ({ label, color }))} />
      </>
    );
  }
  return (
    <Section
      title={t(`stats.section.${props.name}.title`)}
      description={t(`stats.section.${props.name}.description`)}
      keepTogether
    >
      {body}
    </Section>
  );
}

function Charts({ stats, context }: { stats: StatsDto; context: Context }) {
  const { t, bytes, count, duration } = context;
  const { series } = stats;
  const line = (label: string, color: string, values: number[]): ChartSeries => ({
    label: t(`stats.series.${label}`),
    color,
    values,
  });
  return (
    <>
      <ChartSection
        name="backups"
        dataset={series.backups}
        type="stacked"
        integer
        formatValue={count}
        context={context}
        series={(rows) => [
          line(
            "succeeded",
            colors.success,
            rows.map((row) => row.succeeded),
          ),
          line(
            "failed",
            colors.destructive,
            rows.map((row) => row.failed),
          ),
          line(
            "cancelled",
            colors.neutral,
            rows.map((row) => row.cancelled),
          ),
        ]}
      />
      <ChartSection
        name="volume"
        dataset={series.volume}
        type="grouped"
        formatValue={bytes}
        context={context}
        series={(rows) => [
          line(
            "logicalBytes",
            colors.chart[0],
            rows.map((row) => row.logicalBytes),
          ),
          line(
            "physicalBytes",
            colors.chart[1],
            rows.map((row) => row.physicalBytes),
          ),
        ]}
      />
      <ChartSection
        name="storage"
        dataset={series.storage}
        type="line"
        formatValue={bytes}
        context={context}
        series={(rows) => [
          line(
            "bytes",
            colors.chart[0],
            rows.map((row) => row.bytes),
          ),
        ]}
      />
      <ChartSection
        name="restores"
        dataset={series.restores}
        type="stacked"
        integer
        formatValue={count}
        context={context}
        series={(rows) => [
          line(
            "completed",
            colors.success,
            rows.map((row) => row.completed),
          ),
          line(
            "failed",
            colors.destructive,
            rows.map((row) => row.failed),
          ),
        ]}
      />
      <ChartSection
        name="readiness"
        dataset={series.readiness}
        type="stacked"
        integer
        formatValue={count}
        context={context}
        series={(rows) => [
          line(
            "green",
            colors.success,
            rows.map((row) => row.green),
          ),
          line(
            "yellow",
            colors.warning,
            rows.map((row) => row.yellow),
          ),
          line(
            "red",
            colors.destructive,
            rows.map((row) => row.red),
          ),
          line(
            "unverified",
            colors.neutral,
            rows.map((row) => row.unverified),
          ),
        ]}
      />
      <ChartSection
        name="throttling"
        dataset={series.throttling}
        type="grouped"
        formatValue={duration}
        context={context}
        series={(rows) => [
          line(
            "waitSeconds",
            colors.chart[1],
            rows.map((row) => row.waitSeconds),
          ),
        ]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

// Derived from the shared queue list so a new queue is never missed here.
const JOB_KINDS = new Set<string>(JOB_QUEUES);

const STATE_TONE: Record<ObjectState, Tone> = {
  green: "success",
  yellow: "warning",
  red: "destructive",
  unverified: "warning",
  no_backup: "neutral",
};

const READINESS_TONE: Record<NonNullable<TenantRowDto["readiness"]>, Tone> = {
  green: "success",
  yellow: "warning",
  red: "destructive",
};

type TableName = "jobDurations" | "failuresByCause" | "largestObjects" | "tenants";

interface TableSectionProps<Row> {
  readonly name: TableName;
  readonly dataset: Dataset<Row>;
  readonly columns: readonly TableColumn<Row>[];
  readonly rowKey: (row: Row, index: number) => string;
  readonly empty: string;
  readonly t: Translate;
}

function TableSection<Row>(props: TableSectionProps<Row>) {
  const { t, dataset } = props;
  return (
    <Section
      title={t(`stats.section.${props.name}.title`)}
      description={t(`stats.section.${props.name}.description`)}
    >
      {isUnavailable(dataset) ? (
        unavailableNotice(dataset.unavailable, t)
      ) : (
        <ReportTable
          rows={dataset}
          columns={props.columns}
          rowKey={props.rowKey}
          empty={props.empty}
        />
      )}
    </Section>
  );
}

function durationColumns(context: Context): TableColumn<JobDurationDto>[] {
  const { t, count, duration } = context;
  return [
    {
      header: t("stats.column.kind"),
      weight: 3,
      cell: (row) => (JOB_KINDS.has(row.kind) ? t(`stats.jobKind.${row.kind}`) : row.kind),
    },
    { header: t("stats.column.count"), weight: 1, align: "right", cell: (row) => count(row.count) },
    {
      header: t("stats.column.p50"),
      weight: 2,
      align: "right",
      cell: (row) => duration(row.p50Seconds),
    },
    {
      header: t("stats.column.p95"),
      weight: 2,
      align: "right",
      cell: (row) => duration(row.p95Seconds),
    },
  ];
}

function causeColumns(context: Context): TableColumn<FailureCauseDto>[] {
  const { t, count, language } = context;
  return [
    { header: t("stats.column.cause"), weight: 6, cell: (row) => row.cause },
    {
      header: t("stats.column.failures"),
      weight: 1,
      align: "right",
      cell: (row) => count(row.count),
    },
    {
      header: t("stats.column.lastAt"),
      weight: 2,
      align: "right",
      cell: (row) => formatDay(row.lastAt, language),
    },
  ];
}

function largestColumns(context: Context, provider: boolean): TableColumn<LargestObjectDto>[] {
  const { t, bytes, language } = context;
  const tenant: TableColumn<LargestObjectDto>[] = provider
    ? [{ header: t("stats.column.tenant"), weight: 3, cell: (row) => row.tenant?.name ?? "" }]
    : [];
  return [
    { header: t("stats.column.name"), weight: 4, cell: (row) => row.name },
    {
      header: t("stats.column.objectKind"),
      weight: 2,
      cell: (row) => t(`stats.objectKind.${row.kind}`),
    },
    ...tenant,
    {
      header: t("stats.column.logicalBytes"),
      weight: 2,
      align: "right",
      cell: (row) => bytes(row.logicalBytes),
    },
    {
      header: t("stats.column.lastBackupAt"),
      weight: 2,
      align: "right",
      cell: (row) => formatDay(row.lastBackupAt, language),
    },
    {
      header: t("stats.column.state"),
      weight: 3,
      cell: (row): TableCell => ({
        text: t(`stats.state.${row.state}`),
        tone: STATE_TONE[row.state],
      }),
    },
  ];
}

function tenantColumns(context: Context): TableColumn<TenantRowDto>[] {
  const { t, bytes, count, language } = context;
  return [
    { header: t("stats.column.name"), weight: 4, cell: (row) => row.name },
    {
      header: t("stats.column.objects"),
      weight: 2,
      align: "right",
      cell: (row) => count(row.objects),
    },
    {
      header: t("stats.column.successRate"),
      weight: 2,
      align: "right",
      cell: (row) =>
        row.successRate === null ? t("document.noValue") : formatPercent(row.successRate, language),
    },
    {
      header: t("stats.column.protectedBytes"),
      weight: 2,
      align: "right",
      cell: (row) => bytes(row.logicalBytes),
    },
    {
      header: t("stats.column.physicalBytes"),
      weight: 2,
      align: "right",
      cell: (row) => bytes(row.physicalBytes),
    },
    {
      header: t("stats.column.state"),
      weight: 3,
      cell: (row): TableCell =>
        row.readiness === null
          ? { text: t("stats.readiness.none") }
          : { text: t(`stats.readiness.${row.readiness}`), tone: READINESS_TONE[row.readiness] },
    },
    {
      header: t("stats.column.failedItems"),
      weight: 2,
      align: "right",
      cell: (row) => count(row.failures),
    },
  ];
}

function Tables({ stats, context }: { stats: StatsDto; context: Context }) {
  const { t } = context;
  const { tables } = stats;
  const provider = stats.scope === "provider";
  return (
    <>
      <TableSection
        name="jobDurations"
        dataset={stats.series.jobDurations}
        columns={durationColumns(context)}
        rowKey={(row) => row.kind}
        empty={t("stats.section.jobDurations.empty")}
        t={t}
      />
      <TableSection
        name="failuresByCause"
        dataset={tables.failuresByCause}
        columns={causeColumns(context)}
        rowKey={(row) => row.cause}
        empty={t("stats.section.failuresByCause.empty")}
        t={t}
      />
      <TableSection
        name="largestObjects"
        dataset={tables.largestObjects}
        columns={largestColumns(context, provider)}
        rowKey={(row) => row.id}
        empty={t("unavailable.no_backups_yet")}
        t={t}
      />
      {provider && tables.tenants ? (
        <TableSection
          name="tenants"
          dataset={tables.tenants}
          columns={tenantColumns(context)}
          rowKey={(row) => row.id}
          empty={t("stats.section.tenants.empty")}
          t={t}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const METHOD_NOTES = ["successRate", "volume", "dedup", "readiness", "status", "throttling"];

export function StatsReport(props: StatsReportProps) {
  const { stats, language } = props;
  const t = reportTranslator(language);
  const context: Context = {
    t,
    language,
    granularity: stats.period.granularity,
    bytes: (value) => formatBytes(value, language),
    count: (value) => formatInteger(value, language),
    duration: (value) => formatDuration(value, language),
  };
  const generated = formatDateTime(stats.generatedAt, language);
  const title = t("stats.title");
  const subtitle =
    props.subject.kind === "tenant"
      ? t("stats.subtitle.tenant", { name: props.subject.name })
      : t("stats.subtitle.provider", { count: props.subject.tenantCount });
  const generatedLine = t("document.generatedAt", { date: generated });

  return (
    <ReportDocument
      title={`${title} - ${subtitle}`}
      author={t("document.author")}
      subject={subtitle}
      language={language}
      createdAt={new Date(stats.generatedAt)}
    >
      <ReportPage
        footer={`${t("document.product")} - ${title} - ${generatedLine}`}
        pageLabel={(page, total) => t("document.page", { page, total })}
      >
        <ReportHeader
          eyebrow={t("document.product")}
          title={title}
          subtitle={subtitle}
          meta={[
            t("stats.period", {
              from: formatDay(stats.period.from, language),
              to: formatDay(stats.period.to, language),
              granularity: t(`stats.granularity.${stats.period.granularity}`),
            }),
            t("stats.previous", {
              from: formatDay(stats.previous.from, language),
              to: formatDay(stats.previous.to, language),
            }),
            generatedLine,
          ]}
        />
        <Section title={t("stats.section.overview")}>
          <KpiGrid tiles={KPI_NAMES.map((name) => kpiTile(name, stats.kpis[name], context))} />
        </Section>
        <Charts stats={stats} context={context} />
        <Tables stats={stats} context={context} />
        <Notes
          title={t("stats.method.title")}
          items={METHOD_NOTES.map((key) => t(`stats.method.${key}`))}
        />
      </ReportPage>
    </ReportDocument>
  );
}

/** Render the statistics report to PDF bytes. */
export async function renderStatsReport(props: StatsReportProps): Promise<Buffer> {
  return renderPdf(<StatsReport {...props} />);
}
