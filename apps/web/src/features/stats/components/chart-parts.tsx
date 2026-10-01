import { Download, FileSpreadsheet, LoaderCircle, type LucideIcon } from "lucide-react";
import * as React from "react";

import { VALUE_AXIS_INTERVAL } from "@/components/kit/chart-grid";
import { Button } from "@/components/ui/button";
import type { ChartConfig } from "@/components/ui/chart";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { Dataset, StatsDataset } from "../api.js";
import type { Granularity } from "../period.js";
import { type StatsFormat, useStatsFormat } from "../use-stats-format.js";

/**
 * Parts every statistics chart shares: the export context the menus call,
 * the dataset menu itself, the tooltip rows with formatted values and the
 * ChartCard state of a dataset.
 */

export interface StatsExports {
  /** Start the CSV download of one dataset. */
  csv: (dataset: StatsDataset) => void;
  /** Whether that download is running. */
  csvPending: (dataset: StatsDataset) => boolean;
}

const ExportsContext = React.createContext<StatsExports | null>(null);

export const StatsExportsProvider = ExportsContext.Provider;

export function useStatsExports(): StatsExports {
  const context = React.useContext(ExportsContext);
  if (!context) {
    throw new Error("useStatsExports must be used within a StatsExportsProvider");
  }
  return context;
}

interface DatasetMenuProps {
  dataset: StatsDataset;
  /** The chart or table title, for the trigger's accessible name. */
  title: string;
}

/**
 * An icon that turns into a spinner while its download runs. The button
 * around it stays enabled, so keyboard focus is not lost; the download
 * itself ignores repeat clicks and reports through toasts.
 */
export function DownloadIcon({
  pending,
  icon: Icon = Download,
}: {
  pending: boolean;
  icon?: LucideIcon;
}) {
  return pending ? (
    <LoaderCircle aria-hidden="true" className="animate-spin" />
  ) : (
    <Icon aria-hidden="true" />
  );
}

/** The export menu in a chart card's header: the dataset as CSV. */
export function DatasetMenu({ dataset, title }: DatasetMenuProps) {
  const { t } = useStatsFormat();
  const exports = useStatsExports();
  const pending = exports.csvPending(dataset);
  return (
    // Not modal: focus returns to the trigger and the page stays scrollable.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("actions.exportMenu", { chart: title })}
          aria-busy={pending || undefined}
        >
          <DownloadIcon pending={pending} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel>{t("actions.exportLabel")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={pending} onSelect={() => exports.csv(dataset)}>
          <FileSpreadsheet aria-hidden="true" />
          {t("actions.exportCsv")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The ChartCard props that follow from a dataset (undefined while loading). */
export function datasetState<T>(
  dataset: Dataset<T> | undefined,
  format: StatsFormat,
  isEmpty: (rows: readonly T[]) => boolean,
): { rows: T[]; loading: boolean; unavailable: string | null; empty: boolean } {
  if (dataset === undefined) {
    return { rows: [], loading: true, unavailable: null, empty: false };
  }
  if (dataset.status === "unavailable") {
    return { rows: [], loading: false, unavailable: format.reason(dataset.reason), empty: false };
  }
  return {
    rows: dataset.rows,
    loading: false,
    unavailable: null,
    empty: isEmpty(dataset.rows),
  };
}

/** Props of every time-series chart card. */
export interface SeriesChartProps<T> {
  /** Undefined while the figures load. */
  data: Dataset<T> | undefined;
  granularity: Granularity;
}

/**
 * A tooltip `formatter` that keeps the default row (colour mark, series
 * label) but formats the value: bytes, durations or counts instead of raw
 * numbers.
 */
export function tooltipRow(
  config: ChartConfig,
  formatValue: (value: number, key: string) => string,
) {
  return (value: unknown, name: unknown, item: { color?: string }) => {
    const key = String(name);
    const numeric = typeof value === "number" ? value : Number(value);
    return (
      <div className="flex w-full items-center gap-2">
        <div
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-[2px] bg-(--color-bg)"
          style={{ "--color-bg": item.color } as React.CSSProperties}
        />
        <div className="flex flex-1 items-center justify-between gap-4 leading-none">
          <span className="text-muted-foreground">{config[key]?.label ?? key}</span>
          <span className="font-mono font-medium text-foreground tabular-nums">
            {Number.isFinite(numeric) ? formatValue(numeric, key) : String(value)}
          </span>
        </div>
      </div>
    );
  };
}

/**
 * Legend and tooltip order: the order the series are drawn in. Recharts
 * sorts alphabetically by default, which would list "cancelled" before
 * "succeeded" and differ from one language to the next.
 */
export function seriesOrder(keys: readonly string[]) {
  return (item: { dataKey?: unknown }): number => {
    const index = keys.indexOf(String(item.dataKey));
    return index < 0 ? keys.length : index;
  };
}

/**
 * Series draw at once: the skeleton turning into the chart is the change a
 * reader follows, a grow-in animation on top would only delay the numbers.
 */
export const STATIC_SERIES = { isAnimationActive: false } as const;

/** Shared axis props: quiet lines, readable ticks. */
export const AXIS_PROPS = {
  tickLine: false,
  axisLine: false,
  tickMargin: 8,
} as const;

/**
 * A value axis on round ticks from zero to just above `ticks`' last value,
 * labelled by `format` (counts, bytes, durations). Every tick shows, so the
 * grid that follows it needs no label measuring (components/kit/chart-grid.ts).
 */
export function valueAxis(ticks: readonly number[], format: (value: number) => string) {
  return {
    ...AXIS_PROPS,
    interval: VALUE_AXIS_INTERVAL,
    ticks: [...ticks],
    domain: [0, ticks.at(-1) ?? 0] as [number, number],
    tickFormatter: format,
  };
}
