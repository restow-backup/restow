import { Bar, BarChart, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";

import { ChartCard, HORIZONTAL_GRID, VERTICAL_GRID } from "@/components/kit";
import {
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

import type { Dataset, JobDurationRow, ThrottlingPoint } from "../api.js";
import { countTicks, durationTicks, isEmptySeries, maxOf, sumOf } from "../presenters.js";
import { useStatsFormat } from "../use-stats-format.js";
import {
  AXIS_PROPS,
  DatasetMenu,
  STATIC_SERIES,
  type SeriesChartProps,
  datasetState,
  seriesOrder,
  tooltipRow,
  valueAxis,
} from "./chart-parts.js";

/**
 * Operations charts: how long jobs take (median and the slow tail) and how
 * long Microsoft 365 throttling held Restow back. Waits are shown plainly;
 * they explain slow runs and are never hidden.
 */

interface DurationDatum extends JobDurationRow {
  label: string;
}

export function JobDurationsChart({ data }: { data: Dataset<JobDurationRow> | undefined }) {
  const format = useStatsFormat();
  const { t } = format;
  const title = t("charts.jobDurations.title");
  const config = {
    p50Seconds: { label: t("charts.jobDurations.series.p50"), color: "var(--chart-1)" },
    p95Seconds: { label: t("charts.jobDurations.series.p95"), color: "var(--chart-4)" },
  } satisfies ChartConfig;
  const order = seriesOrder(Object.keys(config));
  const state = datasetState(data, format, (rows) => isEmptySeries(rows, ["count"]));
  const rows: DurationDatum[] = state.rows
    .filter((row) => row.count > 0)
    .map((row) => ({ ...row, label: format.jobKind(row.kind) }));
  const ticks = durationTicks(maxOf(rows, ["p50Seconds", "p95Seconds"]));
  const slowest = rows.reduce<DurationDatum | null>(
    (current, row) => (current === null || row.p95Seconds > current.p95Seconds ? row : current),
    null,
  );

  return (
    <ChartCard
      title={title}
      description={t("charts.jobDurations.description")}
      menu={data?.status === "ok" ? <DatasetMenu dataset="jobDurations" title={title} /> : null}
      config={config}
      loading={state.loading}
      unavailable={state.unavailable}
      empty={state.empty}
      emptyTitle={t("charts.jobDurations.empty.title")}
      emptyDescription={t("charts.jobDurations.empty.description")}
      summary={
        slowest
          ? t("charts.jobDurations.summary", {
              kind: slowest.label,
              p50: format.duration(slowest.p50Seconds),
              p95: format.duration(slowest.p95Seconds),
            })
          : undefined
      }
    >
      <BarChart
        data={rows}
        layout="vertical"
        accessibilityLayer
        margin={{ left: 4, right: 16 }}
        barGap={2}
      >
        <CartesianGrid {...VERTICAL_GRID} />
        <XAxis type="number" {...valueAxis(ticks, format.duration)} />
        <YAxis type="category" dataKey="label" {...AXIS_PROPS} width={112} />
        <ChartTooltip
          itemSorter={order}
          content={
            <ChartTooltipContent
              labelFormatter={(label, payload) => {
                const count = Number(payload?.[0]?.payload?.count ?? 0);
                return t("charts.jobDurations.tooltipLabel", {
                  kind: String(label),
                  runs: t("charts.jobDurations.runs", { count }),
                });
              }}
              formatter={tooltipRow(config, (value) => format.duration(value))}
            />
          }
        />
        <ChartLegend itemSorter={order} content={<ChartLegendContent />} />
        <Bar
          {...STATIC_SERIES}
          dataKey="p50Seconds"
          fill="var(--color-p50Seconds)"
          radius={[0, 4, 4, 0]}
        />
        <Bar
          {...STATIC_SERIES}
          dataKey="p95Seconds"
          fill="var(--color-p95Seconds)"
          radius={[0, 4, 4, 0]}
        />
      </BarChart>
    </ChartCard>
  );
}

const THROTTLING_KEYS = ["waitSeconds", "events"] as const;

export function ThrottlingChart({ data, granularity }: SeriesChartProps<ThrottlingPoint>) {
  const format = useStatsFormat();
  const { t } = format;
  const title = t("charts.throttling.title");
  const config = {
    waitSeconds: { label: t("charts.throttling.series.wait"), color: "var(--chart-3)" },
    events: { label: t("charts.throttling.series.events"), color: "var(--chart-5)" },
  } satisfies ChartConfig;
  const order = seriesOrder(Object.keys(config));
  const state = datasetState(data, format, (rows) => isEmptySeries(rows, THROTTLING_KEYS));
  const ticks = durationTicks(maxOf(state.rows, ["waitSeconds"]));
  const eventTicks = countTicks(maxOf(state.rows, ["events"]));

  return (
    <ChartCard
      title={title}
      description={t("charts.throttling.description", {
        granularity: format.granularity(granularity),
      })}
      menu={data?.status === "ok" ? <DatasetMenu dataset="throttling" title={title} /> : null}
      config={config}
      loading={state.loading}
      unavailable={state.unavailable}
      empty={state.empty}
      emptyTitle={t("charts.throttling.empty.title")}
      emptyDescription={t("charts.throttling.empty.description")}
      summary={t("charts.throttling.summary", {
        wait: format.duration(sumOf(state.rows, "waitSeconds")),
        events: format.integer(sumOf(state.rows, "events")),
      })}
    >
      <ComposedChart data={state.rows} accessibilityLayer margin={{ left: 4, right: 4 }}>
        <CartesianGrid {...HORIZONTAL_GRID} />
        <XAxis
          dataKey="t"
          {...AXIS_PROPS}
          minTickGap={24}
          tickFormatter={(value) => format.axis(String(value), granularity)}
        />
        <YAxis yAxisId="wait" {...valueAxis(ticks, format.duration)} width={72} />
        <YAxis
          yAxisId="events"
          orientation="right"
          {...valueAxis(eventTicks, format.integer)}
          width={40}
        />
        <ChartTooltip
          itemSorter={order}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => format.bucket(String(value), granularity)}
              formatter={tooltipRow(config, (value, key) =>
                key === "waitSeconds" ? format.duration(value) : format.integer(value),
              )}
            />
          }
        />
        <ChartLegend itemSorter={order} content={<ChartLegendContent />} />
        <Bar
          {...STATIC_SERIES}
          yAxisId="wait"
          dataKey="waitSeconds"
          fill="var(--color-waitSeconds)"
          radius={[4, 4, 0, 0]}
        />
        <Line
          {...STATIC_SERIES}
          yAxisId="events"
          dataKey="events"
          type="linear"
          stroke="var(--color-events)"
          strokeWidth={2}
          dot={state.rows.length <= 16}
        />
      </ComposedChart>
    </ChartCard>
  );
}
