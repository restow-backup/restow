import { BadgeCheck, HardDrive, TrendingUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  type LegendPayload,
  Line,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartCard,
  HORIZONTAL_GRID,
  KpiTile,
  RelativeTime,
  STATUS_CHART_COLOR,
  VALUE_AXIS_INTERVAL,
} from "@/components/kit";
import {
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatBytes, formatInteger, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

import type {
  BackupTrendWidget as BackupTrendData,
  StorageCapacity,
  StorageGrowthWidget as StorageGrowthData,
  VerificationHistoryWidget as VerificationData,
} from "../api.js";
import { LinkButton } from "../components/link-button.js";
import { RangeToggle, StorageRangeToggle } from "../components/range-toggle.js";
import { TileWidget, type WidgetStateProps } from "../components/widget-frame.js";
import { PATHS, to } from "../paths.js";
import {
  byteTicks,
  dayLabel,
  lastDays,
  monthLabel,
  previousDays,
  storageChartMax,
  storageChartRows,
  storageHorizonDays,
  successRate,
  successRateDelta,
  type WidgetView,
} from "../presenters.js";
import type { StorageRange } from "../ranges.js";

/** The trend windows the page offers. */
export const TREND_WINDOWS = [14, 30] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];

function useLanguage(): string {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage ?? i18n.language;
}

/** ChartCard's props for a widget's view state. */
function chartState<T>(view: WidgetView<T>) {
  return {
    loading: view.kind === "loading",
    error: view.kind === "error" ? view.error : undefined,
  };
}

const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 12 };

/** Legend entries in the order of the chart config, not alphabetically. */
function inConfigOrder(config: ChartConfig) {
  const keys = Object.keys(config);
  return (item: LegendPayload) => keys.indexOf(String(item.dataKey));
}

// ---------------------------------------------------------------------------
// Backup success (tile)
// ---------------------------------------------------------------------------

/**
 * Share of backup runs that succeeded completely in the chosen window, with
 * the change against the window before. Runs that left items behind count
 * as not successful.
 */
export function BackupSuccessTile({
  days,
  ...props
}: WidgetStateProps<BackupTrendData> & { days: TrendWindow }) {
  const { t } = useTranslation("dashboard");
  const language = useLanguage();
  return (
    <TileWidget
      id="backupSuccess"
      {...props}
      label={t("backupSuccess.title", { days })}
      icon={TrendingUp}
      empty={(data) =>
        successRate(lastDays(data.series, days)).runs === 0
          ? {
              icon: TrendingUp,
              title: t("backupSuccess.empty.title"),
              description: t("backupSuccess.empty.description", { days }),
            }
          : null
      }
    >
      {(data) => {
        const current = successRate(lastDays(data.series, days));
        const previous = successRate(previousDays(data.series, days));
        const delta = successRateDelta(current, previous);
        return (
          <KpiTile
            label={t("backupSuccess.title", { days })}
            icon={TrendingUp}
            value={formatPercent(current.rate ?? 0, language)}
            delta={
              delta === null
                ? null
                : {
                    value: delta,
                    format: (points) =>
                      t("backupSuccess.points", {
                        points: new Intl.NumberFormat(language, {
                          maximumFractionDigits: 1,
                        }).format(points),
                      }),
                    period: t("backupSuccess.period", { days }),
                  }
            }
            hint={t("backupSuccess.hint", {
              succeeded: formatInteger(current.succeeded, language),
              runs: formatInteger(current.runs, language),
            })}
          />
        );
      }}
    </TileWidget>
  );
}

// ---------------------------------------------------------------------------
// Backup outcomes (chart)
// ---------------------------------------------------------------------------

export function TrendWindowToggle({
  days,
  onChange,
}: {
  days: TrendWindow;
  onChange: (days: TrendWindow) => void;
}) {
  const { t } = useTranslation("dashboard");
  return (
    <RangeToggle
      value={String(days)}
      options={TREND_WINDOWS.map((window) => ({
        value: String(window),
        label: t("backupTrend.days", { days: window }),
      }))}
      label={t("backupTrend.window")}
      onChange={(value) => {
        const next = TREND_WINDOWS.find((window) => String(window) === value);
        if (next) {
          onChange(next);
        }
      }}
    />
  );
}

/**
 * Finished backup runs per day by outcome. Outcomes are states, so they wear
 * the status chart colours (info, warning, destructive) that every page uses
 * for them, with a legend and the labels in the tooltip; colour never carries
 * the meaning alone. A run that completed is Lapis, never green: green means a
 * passed restore check (brand guide, section 4).
 */
export function BackupTrendWidget({
  days,
  onDaysChange,
  canAdminister,
  view,
  onRetry,
  retrying,
}: WidgetStateProps<BackupTrendData> & {
  days: TrendWindow;
  onDaysChange: (days: TrendWindow) => void;
  canAdminister: boolean;
}) {
  const { t } = useTranslation("dashboard");
  const language = useLanguage();
  const config = {
    // Completed, not checked: Lapis, never the green of a passed restore check.
    succeeded: { label: t("backupTrend.series.succeeded"), color: STATUS_CHART_COLOR.info },
    withItemFailures: {
      label: t("backupTrend.series.withItemFailures"),
      color: STATUS_CHART_COLOR.warning,
    },
    failed: { label: t("backupTrend.series.failed"), color: STATUS_CHART_COLOR.destructive },
  } satisfies ChartConfig;
  const rows = view.kind === "ready" ? lastDays(view.data.series, days) : [];
  const rate = successRate(rows);

  return (
    <div
      data-widget="backupTrend"
      data-state={view.kind === "ready" && rate.runs === 0 ? "empty" : view.kind}
    >
      <ChartCard
        title={t("backupTrend.title")}
        description={t("backupTrend.description", { days })}
        menu={<TrendWindowToggle days={days} onChange={onDaysChange} />}
        config={config}
        {...chartState(view)}
        onRetry={onRetry}
        retrying={retrying}
        empty={view.kind === "ready" && rate.runs === 0}
        emptyTitle={t("backupTrend.empty.title")}
        emptyDescription={t("backupTrend.empty.description", { days })}
        emptyAction={
          canAdminister ? (
            <LinkButton to={to(PATHS.backup)}>{t("backupTrend.empty.action")}</LinkButton>
          ) : undefined
        }
        summary={t("backupTrend.summary", {
          days,
          runs: rate.runs,
          succeeded: rate.succeeded,
        })}
        className="h-full"
      >
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...HORIZONTAL_GRID} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            minTickGap={24}
            tick={AXIS_TICK}
            tickFormatter={(date: string) => dayLabel(date, language)}
          />
          <YAxis
            allowDecimals={false}
            interval={VALUE_AXIS_INTERVAL}
            width={32}
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
          />
          <ChartTooltip
            cursor={{ fill: "var(--muted)" }}
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) =>
                  dayLabel(String(payload[0]?.payload?.date ?? ""), language, "long")
                }
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} itemSorter={inConfigOrder(config)} />
          <Bar
            dataKey="succeeded"
            stackId="runs"
            fill="var(--color-succeeded)"
            isAnimationActive={false}
          />
          <Bar
            dataKey="withItemFailures"
            stackId="runs"
            fill="var(--color-withItemFailures)"
            isAnimationActive={false}
          />
          <Bar
            dataKey="failed"
            stackId="runs"
            fill="var(--color-failed)"
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verification history (chart)
// ---------------------------------------------------------------------------

/**
 * Restore checks per day by rating, and when the latest ran. Ratings wear the
 * same status chart colours as the readiness chart on the Statistics page.
 */
export function VerificationHistoryWidget({
  canAdminister,
  view,
  onRetry,
  retrying,
}: WidgetStateProps<VerificationData> & { canAdminister: boolean }) {
  const { t } = useTranslation("dashboard");
  const language = useLanguage();
  const config = {
    green: { label: t("verificationHistory.series.green"), color: STATUS_CHART_COLOR.success },
    yellow: { label: t("verificationHistory.series.yellow"), color: STATUS_CHART_COLOR.warning },
    red: { label: t("verificationHistory.series.red"), color: STATUS_CHART_COLOR.destructive },
  } satisfies ChartConfig;
  const rows = view.kind === "ready" ? view.data.series : [];
  const checks = rows.reduce((sum, day) => sum + day.green + day.yellow + day.red, 0);
  const empty = view.kind === "ready" && checks === 0;
  const days = view.kind === "ready" ? view.data.days : 30;

  return (
    <div data-widget="verificationHistory" data-state={empty ? "empty" : view.kind}>
      <ChartCard
        title={t("verificationHistory.title")}
        description={t("verificationHistory.description", { days })}
        config={config}
        {...chartState(view)}
        onRetry={onRetry}
        retrying={retrying}
        empty={empty}
        emptyTitle={t("verificationHistory.empty.title")}
        emptyDescription={t("verificationHistory.empty.description")}
        emptyAction={
          canAdminister ? (
            <LinkButton to={to(PATHS.verify)}>{t("verificationHistory.empty.action")}</LinkButton>
          ) : undefined
        }
        summary={t("verificationHistory.summary", { days, checks })}
        footer={
          view.kind === "ready" && !empty ? (
            <span className="flex items-center gap-1.5">
              <BadgeCheck className="size-4" aria-hidden="true" />
              {view.data.lastCheckedAt ? (
                <>
                  {t("verificationHistory.lastCheck")}{" "}
                  <RelativeTime value={view.data.lastCheckedAt} />
                </>
              ) : (
                t("verificationHistory.never")
              )}
            </span>
          ) : undefined
        }
        className="h-full"
      >
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...HORIZONTAL_GRID} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            minTickGap={24}
            tick={AXIS_TICK}
            tickFormatter={(date: string) => dayLabel(date, language)}
          />
          <YAxis
            allowDecimals={false}
            interval={VALUE_AXIS_INTERVAL}
            width={32}
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
          />
          <ChartTooltip
            cursor={{ fill: "var(--muted)" }}
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) =>
                  dayLabel(String(payload[0]?.payload?.date ?? ""), language, "long")
                }
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} itemSorter={inConfigOrder(config)} />
          <Bar
            dataKey="green"
            stackId="checks"
            fill="var(--color-green)"
            isAnimationActive={false}
          />
          <Bar
            dataKey="yellow"
            stackId="checks"
            fill="var(--color-yellow)"
            isAnimationActive={false}
          />
          <Bar
            dataKey="red"
            stackId="checks"
            fill="var(--color-red)"
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Storage growth (chart)
// ---------------------------------------------------------------------------

/**
 * Legend markers drawn like the marks they stand for: solid for the measured
 * data, dashed for the estimate, a dashed outline around a light fill for the
 * estimate's range, so the legend tells them apart without relying on colour.
 * The colours are the chart's own series variables.
 */
function LineSwatch({ series, dashed }: { series: "stored" | "forecast"; dashed: boolean }) {
  return (
    <span className="inline-flex" data-swatch={series}>
      <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden="true">
        <line
          x1="0"
          y1="4"
          x2="16"
          y2="4"
          stroke={`var(--color-${series})`}
          strokeWidth="2"
          strokeDasharray={dashed ? "4 3" : undefined}
        />
      </svg>
    </span>
  );
}

export const StoredSwatch = () => <LineSwatch series="stored" dashed={false} />;
export const EstimateSwatch = () => <LineSwatch series="forecast" dashed />;
export const RangeSwatch = () => (
  <span className="inline-flex" data-swatch="band">
    <svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="14"
        height="8"
        rx="1"
        fill="var(--color-band)"
        fillOpacity="0.18"
        stroke="var(--color-band)"
        strokeWidth="1.5"
        strokeDasharray="3 2"
      />
    </svg>
  </span>
);

/** A `YYYY-MM-DD` day in full ("23 September 2026"). */
const longDay = (date: string, language: string) => dayLabel(date, language, "long");

/** What the repository's capacity says: its free space and, where it can be named, the day it runs full. */
function capacityLines(
  capacity: StorageCapacity,
  banded: boolean,
  language: string,
  t: (key: string, values?: Record<string, unknown>) => string,
): string[] {
  const lines = [
    t("storageGrowth.capacity.free", {
      free: formatBytes(capacity.freeBytes, language),
      total: formatBytes(capacity.totalBytes, language),
    }),
  ];
  const full = capacity.runsFull;
  if (!full) {
    lines.push(t("storageGrowth.capacity.otherData"));
  } else if (banded && full.earliest && full.latest) {
    lines.push(
      t("storageGrowth.capacity.fullBetween", {
        earliest: longDay(full.earliest, language),
        latest: longDay(full.latest, language),
      }),
    );
  } else if (banded && full.earliest) {
    lines.push(t("storageGrowth.capacity.fullFrom", { date: longDay(full.earliest, language) }));
  } else if (!banded && full.estimate) {
    lines.push(t("storageGrowth.capacity.fullAround", { date: longDay(full.estimate, language) }));
  } else {
    lines.push(t("storageGrowth.capacity.notFull"));
  }
  return lines;
}

/**
 * Stored bytes over the chosen window (a week, a month, three months or a
 * year; the server sums long windows up per week or month) and, dashed and
 * labelled as such, an estimate as far ahead. From three months on the
 * estimate is the range between the slowest and the fastest growth of the
 * history, never one line. Where the repository's free space is known it
 * says when that runs out. The estimate is never presented as a fact, and it
 * never wears green: green is proof (components/kit/chart-colors.ts).
 */
export function StorageGrowthWidget({
  view,
  onRetry,
  retrying,
  range,
  onRangeChange,
  updating = false,
}: WidgetStateProps<StorageGrowthData> & {
  /** The chosen window; without it the chart offers no choice. */
  range?: StorageRange;
  onRangeChange?: (range: StorageRange) => void;
  /** Another window was chosen and its answer is on the way: the chart shows the old one meanwhile. */
  updating?: boolean;
}) {
  const { t } = useTranslation("dashboard");
  const language = useLanguage();
  const config = {
    stored: {
      label: t("storageGrowth.series.stored"),
      color: "var(--chart-1)",
      icon: StoredSwatch,
    },
    forecast: {
      label: t("storageGrowth.series.forecast"),
      color: "var(--chart-1)",
      icon: EstimateSwatch,
    },
    band: {
      label: t("storageGrowth.series.band"),
      color: "var(--chart-1)",
      icon: RangeSwatch,
    },
  } satisfies ChartConfig;
  const data = view.kind === "ready" ? view.data : null;
  const rows = data ? storageChartRows(data) : [];
  const empty = data?.series.every((point) => point.bytes === 0) ?? false;
  const last = data?.series.at(-1)?.bytes ?? 0;
  const forecast = data?.forecast ?? null;
  const band = forecast?.band ?? null;
  const projected = forecast?.points.at(-1)?.bytes ?? null;
  const bandEnd = band?.points.at(-1) ?? null;
  const granularity = data?.granularity ?? "day";
  const ticks = byteTicks(storageChartMax(rows));
  const requested = data?.requestedDays ?? data?.days ?? 30;
  const horizon = data ? storageHorizonDays(data) : 0;

  return (
    <div
      data-widget="storageGrowth"
      data-state={empty ? "empty" : view.kind}
      aria-busy={updating || undefined}
    >
      <ChartCard
        title={t("storageGrowth.title")}
        description={t("storageGrowth.description", { days: data?.days ?? 30, granularity })}
        menu={
          range && onRangeChange ? (
            <StorageRangeToggle value={range} onChange={onRangeChange} />
          ) : undefined
        }
        config={config}
        {...chartState(view)}
        onRetry={onRetry}
        retrying={retrying}
        empty={empty}
        emptyTitle={t("storageGrowth.empty.title")}
        emptyDescription={t("storageGrowth.empty.description")}
        summary={t("storageGrowth.summary", {
          stored: formatBytes(last, language),
          growth: formatBytes(data?.growthBytes ?? 0, language),
        })}
        footer={
          data && !empty ? (
            <span className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5">
                <HardDrive className="size-4" aria-hidden="true" />
                {t("storageGrowth.growth", {
                  growth: formatBytes(data.growthBytes, language),
                  days: data.days,
                })}
              </span>
              {data.days < requested && data.series[0] ? (
                <span>
                  {t("storageGrowth.clamped", {
                    date: longDay(firstDay(data), language),
                    days: data.days,
                    requested,
                  })}
                </span>
              ) : null}
              {forecast && band && bandEnd ? (
                <span>
                  {t("storageGrowth.estimateRange", {
                    low: formatBytes(bandEnd.low, language),
                    high: formatBytes(bandEnd.high, language),
                    days: horizon,
                    granularity,
                    basisDays: forecast.basisDays,
                  })}
                </span>
              ) : forecast && projected !== null ? (
                <span>
                  {t("storageGrowth.estimate", {
                    bytes: formatBytes(projected, language),
                    days: horizon,
                    basisDays: forecast.basisDays,
                  })}
                </span>
              ) : (
                <span>{t("storageGrowth.noEstimate")}</span>
              )}
              {data.capacity
                ? capacityLines(data.capacity, band !== null, language, t).map((line) => (
                    <span key={line}>{line}</span>
                  ))
                : null}
            </span>
          ) : undefined
        }
        className={cn("h-full", updating && "motion-safe:transition-opacity opacity-70")}
      >
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...HORIZONTAL_GRID} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            minTickGap={32}
            tick={AXIS_TICK}
            tickFormatter={(date: string) =>
              granularity === "month" ? monthLabel(date, language) : dayLabel(date, language)
            }
          />
          <YAxis
            width={72}
            interval={VALUE_AXIS_INTERVAL}
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
            ticks={ticks}
            domain={[0, ticks.at(-1) ?? 0]}
            tickFormatter={(bytes: number) => (bytes === 0 ? "0" : formatBytes(bytes, language))}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) =>
                  dayLabel(String(payload[0]?.payload?.date ?? ""), language, "long")
                }
                formatter={(value, name) => (
                  <span className="flex w-full justify-between gap-3">
                    <span className="text-muted-foreground">
                      {name === "band"
                        ? config.band.label
                        : name === "forecast"
                          ? config.forecast.label
                          : config.stored.label}
                    </span>
                    <span className="font-medium tabular-nums">
                      {Array.isArray(value)
                        ? t("storageGrowth.between", {
                            low: formatBytes(Number(value[0]), language),
                            high: formatBytes(Number(value[1]), language),
                          })
                        : formatBytes(Number(value), language)}
                    </span>
                  </span>
                )}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} itemSorter={inConfigOrder(config)} />
          <Area
            dataKey="stored"
            type="monotone"
            stroke="var(--color-stored)"
            strokeWidth={2}
            fill="var(--color-stored)"
            fillOpacity={0.12}
            dot={false}
            isAnimationActive={false}
          />
          {band ? (
            <Area
              dataKey="band"
              type="linear"
              stroke="var(--color-band)"
              strokeWidth={1.5}
              strokeDasharray="6 4"
              strokeOpacity={0.7}
              fill="var(--color-band)"
              fillOpacity={0.15}
              dot={false}
              isAnimationActive={false}
            />
          ) : (
            <Line
              dataKey="forecast"
              type="linear"
              stroke="var(--color-forecast)"
              strokeWidth={2}
              strokeDasharray="6 4"
              strokeOpacity={0.7}
              dot={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ChartCard>
    </div>
  );
}

/** The first day the chart covers: its window ends today and is `days` long. */
function firstDay(data: StorageGrowthData): string {
  const last = data.series.at(-1)?.date ?? "";
  const end = Date.parse(`${last}T00:00:00.000Z`);
  return Number.isNaN(end)
    ? (data.series[0]?.date ?? "")
    : new Date(end - (data.days - 1) * 86_400_000).toISOString().slice(0, 10);
}
