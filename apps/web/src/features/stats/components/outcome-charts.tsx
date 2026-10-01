import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartCard, HORIZONTAL_GRID, STATUS_CHART_COLOR } from "@/components/kit";
import {
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

import type { BackupPoint, ReadinessPoint, RestorePoint } from "../api.js";
import { countTicks, isEmptySeries, maxStacked, sumOf } from "../presenters.js";
import { useStatsFormat } from "../use-stats-format.js";
import {
  AXIS_PROPS,
  DatasetMenu,
  STATIC_SERIES,
  type SeriesChartProps,
  datasetState,
  seriesOrder,
  valueAxis,
} from "./chart-parts.js";

/**
 * Outcome charts: backup runs and restores by result, and recovery
 * readiness over time. Outcomes are states, so they wear the status chart
 * colours the dashboard uses for them too. Green (success) means proof: a
 * restore that completed and a rating of Ready. A backup run that completed is
 * info (Lapis): nothing has read it back yet. Warning for Attention,
 * destructive for failures and Not restorable, muted for cancelled and
 * unverified.
 */

const BACKUP_KEYS = ["succeeded", "failed", "cancelled"] as const;

export function BackupsChart({ data, granularity }: SeriesChartProps<BackupPoint>) {
  const format = useStatsFormat();
  const { t } = format;
  const title = t("charts.backups.title");
  const config = {
    // Completed, not checked: Lapis, never the green of a passed restore check.
    succeeded: { label: t("charts.backups.series.succeeded"), color: STATUS_CHART_COLOR.info },
    failed: { label: t("charts.backups.series.failed"), color: STATUS_CHART_COLOR.destructive },
    cancelled: { label: t("charts.backups.series.cancelled"), color: STATUS_CHART_COLOR.muted },
  } satisfies ChartConfig;
  const order = seriesOrder(Object.keys(config));
  const state = datasetState(data, format, (rows) => isEmptySeries(rows, BACKUP_KEYS));
  const ticks = countTicks(maxStacked(state.rows, BACKUP_KEYS));

  return (
    <ChartCard
      title={title}
      description={t("charts.backups.description", {
        granularity: format.granularity(granularity),
      })}
      menu={data?.status === "ok" ? <DatasetMenu dataset="backups" title={title} /> : null}
      config={config}
      loading={state.loading}
      unavailable={state.unavailable}
      empty={state.empty}
      emptyTitle={t("charts.backups.empty.title")}
      emptyDescription={t("charts.backups.empty.description")}
      summary={t("charts.backups.summary", {
        succeeded: format.integer(sumOf(state.rows, "succeeded")),
        failed: format.integer(sumOf(state.rows, "failed")),
        cancelled: format.integer(sumOf(state.rows, "cancelled")),
      })}
    >
      <BarChart data={state.rows} accessibilityLayer margin={{ left: 4, right: 4 }}>
        <CartesianGrid {...HORIZONTAL_GRID} />
        <XAxis
          dataKey="t"
          {...AXIS_PROPS}
          minTickGap={24}
          tickFormatter={(value) => format.axis(String(value), granularity)}
        />
        <YAxis {...valueAxis(ticks, format.integer)} width={40} />
        <ChartTooltip
          itemSorter={order}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => format.bucket(String(value), granularity)}
            />
          }
        />
        <ChartLegend itemSorter={order} content={<ChartLegendContent />} />
        <Bar {...STATIC_SERIES} dataKey="succeeded" stackId="runs" fill="var(--color-succeeded)" />
        <Bar {...STATIC_SERIES} dataKey="failed" stackId="runs" fill="var(--color-failed)" />
        <Bar
          {...STATIC_SERIES}
          dataKey="cancelled"
          stackId="runs"
          fill="var(--color-cancelled)"
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ChartCard>
  );
}

const RESTORE_KEYS = ["completed", "failed"] as const;

export function RestoresChart({ data, granularity }: SeriesChartProps<RestorePoint>) {
  const format = useStatsFormat();
  const { t } = format;
  const title = t("charts.restores.title");
  const config = {
    completed: { label: t("charts.restores.series.completed"), color: STATUS_CHART_COLOR.success },
    failed: { label: t("charts.restores.series.failed"), color: STATUS_CHART_COLOR.destructive },
  } satisfies ChartConfig;
  const order = seriesOrder(Object.keys(config));
  const state = datasetState(data, format, (rows) => isEmptySeries(rows, RESTORE_KEYS));
  const ticks = countTicks(maxStacked(state.rows, RESTORE_KEYS));

  return (
    <ChartCard
      title={title}
      description={t("charts.restores.description", {
        granularity: format.granularity(granularity),
      })}
      menu={data?.status === "ok" ? <DatasetMenu dataset="restores" title={title} /> : null}
      config={config}
      loading={state.loading}
      unavailable={state.unavailable}
      empty={state.empty}
      emptyTitle={t("charts.restores.empty.title")}
      emptyDescription={t("charts.restores.empty.description")}
      summary={t("charts.restores.summary", {
        completed: format.integer(sumOf(state.rows, "completed")),
        failed: format.integer(sumOf(state.rows, "failed")),
      })}
    >
      <BarChart data={state.rows} accessibilityLayer margin={{ left: 4, right: 4 }}>
        <CartesianGrid {...HORIZONTAL_GRID} />
        <XAxis
          dataKey="t"
          {...AXIS_PROPS}
          minTickGap={24}
          tickFormatter={(value) => format.axis(String(value), granularity)}
        />
        <YAxis {...valueAxis(ticks, format.integer)} width={40} />
        <ChartTooltip
          itemSorter={order}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => format.bucket(String(value), granularity)}
            />
          }
        />
        <ChartLegend itemSorter={order} content={<ChartLegendContent />} />
        <Bar
          {...STATIC_SERIES}
          dataKey="completed"
          stackId="restores"
          fill="var(--color-completed)"
        />
        <Bar
          {...STATIC_SERIES}
          dataKey="failed"
          stackId="restores"
          fill="var(--color-failed)"
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ChartCard>
  );
}

const READINESS_KEYS = ["green", "yellow", "red", "unverified"] as const;

export function ReadinessChart({ data, granularity }: SeriesChartProps<ReadinessPoint>) {
  const format = useStatsFormat();
  const { t } = format;
  const title = t("charts.readiness.title");
  const config = {
    green: { label: t("readiness.green"), color: STATUS_CHART_COLOR.success },
    yellow: { label: t("readiness.yellow"), color: STATUS_CHART_COLOR.warning },
    red: { label: t("readiness.red"), color: STATUS_CHART_COLOR.destructive },
    unverified: { label: t("readiness.unverified"), color: STATUS_CHART_COLOR.muted },
  } satisfies ChartConfig;
  const order = seriesOrder(Object.keys(config));
  const state = datasetState(data, format, (rows) => isEmptySeries(rows, READINESS_KEYS));
  const ticks = countTicks(maxStacked(state.rows, READINESS_KEYS));
  const last = state.rows.at(-1);

  return (
    <ChartCard
      title={title}
      description={t("charts.readiness.description", {
        granularity: format.granularity(granularity),
      })}
      menu={data?.status === "ok" ? <DatasetMenu dataset="readiness" title={title} /> : null}
      config={config}
      loading={state.loading}
      unavailable={state.unavailable}
      empty={state.empty}
      emptyTitle={t("charts.readiness.empty.title")}
      emptyDescription={t("charts.readiness.empty.description")}
      summary={
        last
          ? t("charts.readiness.summary", {
              green: format.integer(last.green),
              yellow: format.integer(last.yellow),
              red: format.integer(last.red),
              unverified: format.integer(last.unverified),
            })
          : undefined
      }
    >
      <AreaChart data={state.rows} accessibilityLayer margin={{ left: 4, right: 4 }}>
        <CartesianGrid {...HORIZONTAL_GRID} />
        <XAxis
          dataKey="t"
          {...AXIS_PROPS}
          minTickGap={24}
          tickFormatter={(value) => format.axis(String(value), granularity)}
        />
        <YAxis {...valueAxis(ticks, format.integer)} width={40} />
        <ChartTooltip
          itemSorter={order}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => format.bucket(String(value), granularity)}
            />
          }
        />
        <ChartLegend itemSorter={order} content={<ChartLegendContent />} />
        {READINESS_KEYS.map((key) => (
          <Area
            {...STATIC_SERIES}
            key={key}
            dataKey={key}
            type="linear"
            stackId="objects"
            stroke={`var(--color-${key})`}
            fill={`var(--color-${key})`}
            fillOpacity={0.35}
            strokeWidth={2}
          />
        ))}
      </AreaChart>
    </ChartCard>
  );
}
