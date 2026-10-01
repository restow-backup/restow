import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartCard, HORIZONTAL_GRID } from "@/components/kit";
import {
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

import type { StoragePoint, VolumePoint } from "../api.js";
import { type DedupFigures, byteTicks, isEmptySeries, maxOf } from "../presenters.js";
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
 * Volume charts: what is protected (logical) against what it takes in the
 * chunk store (physical), and how the store grows.
 */

const VOLUME_KEYS = ["logicalBytes", "physicalBytes"] as const;

interface VolumeChartProps extends SeriesChartProps<VolumePoint> {
  /** Savings over the whole period, from the key figures; null when unknown. */
  dedup: DedupFigures | null;
}

export function VolumeChart({ data, granularity, dedup }: VolumeChartProps) {
  const format = useStatsFormat();
  const { t } = format;
  const title = t("charts.volume.title");
  const config = {
    logicalBytes: { label: t("charts.volume.series.logical"), color: "var(--chart-1)" },
    physicalBytes: { label: t("charts.volume.series.physical"), color: "var(--chart-5)" },
  } satisfies ChartConfig;
  const order = seriesOrder(Object.keys(config));
  const state = datasetState(data, format, (rows) => isEmptySeries(rows, VOLUME_KEYS));
  const ticks = byteTicks(maxOf(state.rows, VOLUME_KEYS));
  const last = state.rows.at(-1);

  const footer =
    dedup?.savings !== null && dedup?.savings !== undefined
      ? dedup.factor !== null
        ? t("charts.volume.dedup", {
            savings: format.share(dedup.savings),
            factor: format.decimal(dedup.factor),
          })
        : t("charts.volume.dedupShare", { savings: format.share(dedup.savings) })
      : null;

  return (
    <ChartCard
      title={title}
      description={t("charts.volume.description", {
        granularity: format.granularity(granularity),
      })}
      menu={data?.status === "ok" ? <DatasetMenu dataset="volume" title={title} /> : null}
      config={config}
      loading={state.loading}
      unavailable={state.unavailable}
      empty={state.empty}
      emptyTitle={t("charts.volume.empty.title")}
      emptyDescription={t("charts.volume.empty.description")}
      footer={state.loading || state.unavailable || state.empty ? null : footer}
      summary={
        last
          ? t("charts.volume.summary", {
              logical: format.bytes(last.logicalBytes),
              physical: format.bytes(last.physicalBytes),
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
        <YAxis {...valueAxis(ticks, format.bytes)} width={64} />
        <ChartTooltip
          itemSorter={order}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => format.bucket(String(value), granularity)}
              formatter={tooltipRow(config, (value) => format.bytes(value))}
            />
          }
        />
        <ChartLegend itemSorter={order} content={<ChartLegendContent />} />
        <Area
          {...STATIC_SERIES}
          dataKey="logicalBytes"
          type="linear"
          stroke="var(--color-logicalBytes)"
          fill="var(--color-logicalBytes)"
          fillOpacity={0.15}
          strokeWidth={2}
        />
        <Area
          {...STATIC_SERIES}
          dataKey="physicalBytes"
          type="linear"
          stroke="var(--color-physicalBytes)"
          fill="var(--color-physicalBytes)"
          fillOpacity={0.35}
          strokeWidth={2}
        />
      </AreaChart>
    </ChartCard>
  );
}

export function StorageChart({ data, granularity }: SeriesChartProps<StoragePoint>) {
  const format = useStatsFormat();
  const { t } = format;
  const title = t("charts.storage.title");
  const config = {
    bytes: { label: t("charts.storage.series.bytes"), color: "var(--chart-1)" },
  } satisfies ChartConfig;
  const order = seriesOrder(Object.keys(config));
  const state = datasetState(data, format, (rows) => isEmptySeries(rows, ["bytes"]));
  const ticks = byteTicks(maxOf(state.rows, ["bytes"]));
  const first = state.rows[0];
  const last = state.rows.at(-1);

  return (
    <ChartCard
      title={title}
      description={t("charts.storage.description", {
        granularity: format.granularity(granularity),
      })}
      menu={data?.status === "ok" ? <DatasetMenu dataset="storage" title={title} /> : null}
      config={config}
      loading={state.loading}
      unavailable={state.unavailable}
      empty={state.empty}
      emptyTitle={t("charts.storage.empty.title")}
      emptyDescription={t("charts.storage.empty.description")}
      summary={
        first && last
          ? t("charts.storage.summary", {
              first: format.bytes(first.bytes),
              last: format.bytes(last.bytes),
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
        <YAxis {...valueAxis(ticks, format.bytes)} width={64} />
        <ChartTooltip
          itemSorter={order}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => format.bucket(String(value), granularity)}
              formatter={tooltipRow(config, (value) => format.bytes(value))}
            />
          }
        />
        <Area
          {...STATIC_SERIES}
          dataKey="bytes"
          type="linear"
          stroke="var(--color-bytes)"
          fill="var(--color-bytes)"
          fillOpacity={0.2}
          strokeWidth={2}
        />
      </AreaChart>
    </ChartCard>
  );
}
