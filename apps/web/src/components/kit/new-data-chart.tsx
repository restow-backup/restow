import type * as React from "react";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, formatDateTime } from "@/lib/format";

import { ChartCard } from "./chart-card.js";
import { byteAxisTicks, HORIZONTAL_GRID, VALUE_AXIS_INTERVAL } from "./chart-grid.js";
import { UI_NAMESPACE } from "./i18n.js";

/**
 * How a backup came about: the first (full) one, an incremental one, or a VM whose disks were
 * read in full again (its dirty bitmap was lost). Without a type (a machine's restore points)
 * a bar is just "Backup".
 */
export type NewDataType = "first" | "incremental" | "full_read";

/** One backup in the "new data per backup" chart. */
export interface NewDataPoint {
  id: string;
  /** When the backup ran (ISO). */
  at: string;
  /** What it added to the repository after deduplication, in bytes. */
  added: number;
  type?: NewDataType;
}

/** The series of the chart, in drawing and legend order. */
const SERIES = ["first", "fullRead", "incremental", "backup"] as const;
type Series = (typeof SERIES)[number];

/**
 * Series colours from the categorical chart palette. Size is no proof of anything, so never
 * the success series and never a UI tone; teal (`--chart-5`) is left out as well, it reads
 * as green next to the others.
 */
const SERIES_COLOR: Readonly<Record<Series, string>> = {
  first: "var(--chart-4)",
  fullRead: "var(--chart-3)",
  incremental: "var(--chart-1)",
  backup: "var(--chart-1)",
};

function seriesOf(point: NewDataPoint): Series {
  switch (point.type) {
    case "first":
      return "first";
    case "full_read":
      return "fullRead";
    case "incremental":
      return "incremental";
    default:
      return "backup";
  }
}

/**
 * A full backup stores (nearly) everything and can be a thousand times larger than what a
 * follow-up adds; drawn to one scale, the follow-ups would be invisible. When a full backup is
 * more than this many times the largest follow-up, the axis follows the follow-ups and the full
 * one is cut at its top (and named as such below the chart).
 */
export const NEW_DATA_CAP_FACTOR = 4;

export interface NewDataRow {
  key: string;
  id: string;
  at: string;
  series: Series;
  /** What the backup added (the real value, also when its bar is cut). */
  bytes: number;
  /** The bar is cut at the top of the axis. */
  cut: boolean;
  first?: number;
  fullRead?: number;
  incremental?: number;
  backup?: number;
}

/**
 * The backups without a type (a machine's restore points) that stand far above the rest, like
 * the first backup of a machine: sorted by size, everything above the first step where one
 * backup is more than {@link NEW_DATA_CAP_FACTOR} times the next. At least two backups stay
 * below the step, as for typed ones. Without a type it is not known which backup was the full
 * one (retention may have removed it), so they are found by size and not named "First backup".
 */
function untypedOutliers(points: readonly NewDataPoint[]): Set<NewDataPoint> {
  const sorted = points
    .filter((point) => point.type === undefined)
    .sort((a, b) => b.added - a.added);
  for (let index = 0; index + 2 < sorted.length; index += 1) {
    const next = sorted[index + 1]?.added ?? 0;
    if (next > 0 && (sorted[index]?.added ?? 0) > next * NEW_DATA_CAP_FACTOR) {
      return new Set(sorted.slice(0, index + 1));
    }
  }
  return new Set();
}

/**
 * The chart's rows and its axis: each backup with the height of its bar (cut at the axis top
 * when it is a full backup far above the follow-ups, or for a machine's untyped backups one far
 * above the rest), and the ticks of the byte axis.
 */
export function newDataRows(points: readonly NewDataPoint[]): {
  rows: NewDataRow[];
  ticks: number[];
} {
  const outliers = untypedOutliers(points);
  const isFull = (point: NewDataPoint) =>
    point.type === "first" || point.type === "full_read" || outliers.has(point);
  const followUps = points.filter((point) => !isFull(point));
  const followUpMax = Math.max(0, ...followUps.map((point) => point.added));
  const fullMax = Math.max(0, ...points.filter(isFull).map((point) => point.added));
  const capped =
    followUps.length >= 2 && followUpMax > 0 && fullMax > followUpMax * NEW_DATA_CAP_FACTOR;
  const ticks = byteAxisTicks(capped ? followUpMax : Math.max(0, ...points.map((p) => p.added)));
  const top = ticks.at(-1) ?? 0;
  const rows = points.map((point, index): NewDataRow => {
    const series = seriesOf(point);
    const cut = capped && point.added > top;
    return {
      key: String(index),
      id: point.id,
      at: point.at,
      series,
      bytes: point.added,
      cut,
      [series]: cut ? top : point.added,
    };
  });
  return { rows, ticks };
}

export interface NewDataChartProps {
  /** The backups, oldest first; the chart shows them all (callers pass the newest 30). */
  points: readonly NewDataPoint[];
  title?: string;
  description?: string;
  className?: string;
}

const AXIS = { tickLine: false, axisLine: false, tickMargin: 8 } as const;

/**
 * What each backup added to the repository (#58), as a bar chart: one bar per backup, oldest
 * left, coloured by its type (first backup, incremental, full read). It has a text alternative
 * for screen readers (how many backups, the range, the newest), a table of every bar behind
 * "Show as table", and names the bars a full backup cut at the top of the axis. Fewer than
 * two backups draw no chart.
 */
export function NewDataChart({ points, title, description, className }: NewDataChartProps) {
  const { t, i18n } = useTranslation(UI_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  if (points.length < 2) {
    return null;
  }
  const bytes = (value: number) => formatBytes(value, language);
  const day = (value: string) =>
    new Intl.DateTimeFormat(language, { day: "numeric", month: "short" }).format(new Date(value));
  const { rows, ticks } = newDataRows(points);
  const present = SERIES.filter((series) => rows.some((row) => row.series === series));
  const config = Object.fromEntries(
    present.map((series) => [
      series,
      { label: t(`newData.series.${series}`), color: SERIES_COLOR[series] },
    ]),
  ) satisfies ChartConfig;
  const values = points.map((point) => point.added);
  const newest = points.at(-1);
  const cut = rows.filter((row) => row.cut);
  const typeLabel = (series: Series) => t(`newData.series.${series}`);
  const footer = (
    <div className="w-full space-y-2" data-slot="new-data-footer">
      {cut.length > 0 ? (
        <p data-slot="new-data-cut">
          {t("newData.cut", {
            points: cut
              .map((row) =>
                t("newData.cutPoint", {
                  date: day(row.at),
                  size: bytes(row.bytes),
                  type: typeLabel(row.series),
                }),
              )
              .join(", "),
          })}
        </p>
      ) : null}
      <details data-slot="new-data-table">
        <summary className="cursor-pointer text-foreground underline-offset-4 hover:underline">
          {t("newData.table.show")}
        </summary>
        <Table className="mt-2">
          <TableHeader>
            <TableRow>
              <TableHead>{t("newData.table.date")}</TableHead>
              <TableHead>{t("newData.table.type")}</TableHead>
              <TableHead className="text-right">{t("newData.table.added")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{formatDateTime(row.at, language)}</TableCell>
                <TableCell>{typeLabel(row.series)}</TableCell>
                <TableCell className="text-right tabular-nums">{bytes(row.bytes)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </details>
    </div>
  );
  return (
    <ChartCard
      title={title ?? t("newData.title")}
      description={description ?? t("newData.description", { count: points.length })}
      config={config}
      chartClassName="h-48"
      className={className}
      summary={t("newData.summary", {
        count: points.length,
        min: bytes(Math.min(...values)),
        max: bytes(Math.max(...values)),
        last: bytes(newest?.added ?? 0),
      })}
      footer={footer}
    >
      <BarChart data={rows} accessibilityLayer margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
        <CartesianGrid {...HORIZONTAL_GRID} stroke="var(--border)" />
        <XAxis
          dataKey="key"
          {...AXIS}
          minTickGap={16}
          tickFormatter={(key) => {
            const row = rows[Number(key)];
            return row ? day(row.at) : "";
          }}
        />
        <YAxis
          {...AXIS}
          interval={VALUE_AXIS_INTERVAL}
          ticks={ticks}
          domain={[0, ticks.at(-1) ?? 0]}
          allowDataOverflow
          tickFormatter={(value: number) => bytes(value)}
          width={64}
        />
        <ChartTooltip
          cursor={{ fill: "var(--muted)" }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const row = payload[0]?.payload as NewDataRow | undefined;
                return row ? (formatDateTime(row.at, language) ?? "") : "";
              }}
              formatter={(_value, _name, item) => {
                const row = item.payload as NewDataRow;
                return (
                  <div className="flex w-full items-center gap-2">
                    <div
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-[2px] bg-(--color-bg)"
                      style={{ "--color-bg": SERIES_COLOR[row.series] } as React.CSSProperties}
                    />
                    <div className="flex flex-1 items-center justify-between gap-4 leading-none">
                      <span className="text-muted-foreground">{typeLabel(row.series)}</span>
                      <span className="font-mono font-medium text-foreground tabular-nums">
                        +{bytes(row.bytes)}
                      </span>
                    </div>
                  </div>
                );
              }}
            />
          }
        />
        {present.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
        {present.map((series) => (
          <Bar
            key={series}
            dataKey={series}
            stackId="added"
            fill={`var(--color-${series})`}
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartCard>
  );
}
