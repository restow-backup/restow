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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatBytes, formatInteger, formatPercent } from "@/lib/format";

import type {
  BackupTrendWidget as BackupTrendData,
  StorageGrowthWidget as StorageGrowthData,
  VerificationHistoryWidget as VerificationData,
} from "../api.js";
import { LinkButton } from "../components/link-button.js";
import { TileWidget, type WidgetStateProps } from "../components/widget-frame.js";
import { PATHS, to } from "../paths.js";
import {
  type WidgetView,
  byteTicks,
  dayLabel,
  lastDays,
  previousDays,
  storageChartRows,
  successRate,
  successRateDelta,
} from "../presenters.js";

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
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={String(days)}
      aria-label={t("backupTrend.window")}
      onValueChange={(value) => {
        const next = TREND_WINDOWS.find((window) => String(window) === value);
        if (next) {
          onChange(next);
        }
      }}
    >
      {TREND_WINDOWS.map((window) => (
        <ToggleGroupItem key={window} value={String(window)} className="px-3 tabular-nums">
          {t("backupTrend.days", { days: window })}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
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
 * Legend markers drawn like the lines they stand for: solid for the measured
 * data, dashed for the estimate, so the legend tells the two apart without
 * relying on colour. The colours are the chart's own series variables.
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

/**
 * Stored bytes per day and, dashed and labelled as such, a straight-line
 * estimate of the next 30 days. The estimate is never presented as a fact.
 */
export function StorageGrowthWidget({
  view,
  onRetry,
  retrying,
}: WidgetStateProps<StorageGrowthData>) {
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
  } satisfies ChartConfig;
  const data = view.kind === "ready" ? view.data : null;
  const rows = data ? storageChartRows(data) : [];
  const empty = data?.series.every((point) => point.bytes === 0) ?? false;
  const last = data?.series.at(-1)?.bytes ?? 0;
  const projected = data?.forecast?.points.at(-1)?.bytes ?? null;
  const ticks = byteTicks(
    Math.max(0, ...rows.map((row) => Math.max(row.stored ?? 0, row.forecast ?? 0))),
  );

  return (
    <div data-widget="storageGrowth" data-state={empty ? "empty" : view.kind}>
      <ChartCard
        title={t("storageGrowth.title")}
        description={t("storageGrowth.description", { days: data?.days ?? 30 })}
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
              {data.forecast && projected !== null ? (
                <span>
                  {t("storageGrowth.estimate", {
                    bytes: formatBytes(projected, language),
                    days: data.forecast.points.length,
                    basisDays: data.forecast.basisDays,
                  })}
                </span>
              ) : (
                <span>{t("storageGrowth.noEstimate")}</span>
              )}
            </span>
          ) : undefined
        }
        className="h-full"
      >
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...HORIZONTAL_GRID} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            minTickGap={32}
            tick={AXIS_TICK}
            tickFormatter={(date: string) => dayLabel(date, language)}
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
                      {name === "forecast" ? config.forecast.label : config.stored.label}
                    </span>
                    <span className="font-medium tabular-nums">
                      {formatBytes(Number(value), language)}
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
        </ComposedChart>
      </ChartCard>
    </div>
  );
}
