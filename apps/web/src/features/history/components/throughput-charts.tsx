import * as React from "react";
import { useTranslation } from "react-i18next";

import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { SamplePoint } from "../api";
import {
  CHART_BOX,
  CHART_WINDOW_MS,
  type ChartBox,
  type ChartScale,
  type CrosshairMove,
  type RateStep,
  SMOOTHED_SERIES,
  type SeriesKey,
  TRANSFER_AVERAGE_MS,
  boxFor,
  chartSeries,
  formatClock,
  moveCrosshair,
  nearestStep,
  pathOf,
  scaleOf,
  summaryOf,
  tickCount,
  timeAtX,
  unitFor,
} from "../samples";

/**
 * The throughput of a run as two small charts on one time axis, instead of one chart with two
 * value axes: what was read and handled (in the range of hundreds of MB/s) and what was written
 * to the repository (a few MB/s) differ by orders of magnitude, and each is read against its own
 * scale. Each line is 2 px Lapis with a 10 % fill, its newest value written at its end, the grid
 * a hairline, every number in IBM Plex Mono.
 *
 * One crosshair serves both charts and a tooltip names the moment and both values. A pointer
 * moves it; so do the arrow keys (Home and End jump to the ends, Escape lets go), and the whole
 * group carries a text summary as its accessible name. A running run shows its last five
 * minutes; a finished one all of it.
 *
 * The transfer is drawn as an average over {@link TRANSFER_AVERAGE_MS}: data reaches the
 * repository in packs, so its raw speed is a square wave. The chart says so under its title, the
 * tooltip and the end label show the same averaged value, and so does the text summary ("average
 * over 15 s"). The processing line is as measured.
 */

export interface ThroughputChartsProps {
  points: readonly SamplePoint[];
  running: boolean;
  /** Draw the second chart: runs that write to the repository. */
  showTransferred: boolean;
  className?: string;
}

const GRID_STEPS = 2;
/** The padding and border of the group around the charts, which the plot does not use. */
const GROUP_PADDING_PX = 24;

interface ChartData {
  key: SeriesKey;
  steps: RateStep[];
  scale: ChartScale;
  unit: ReturnType<typeof unitFor>;
}

function chartOf(
  steps: RateStep[],
  key: SeriesKey,
  from: number,
  to: number,
  box: ChartBox,
): ChartData {
  const peak = Math.max(0, ...steps.map((step) => step[key]));
  const scale = scaleOf(from, to, peak, box);
  return { key, steps, scale, unit: unitFor(scale.max) };
}

export function ThroughputCharts({
  points,
  running,
  showTransferred,
  className,
}: ThroughputChartsProps) {
  const { t, i18n } = useTranslation("history");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const tooltipId = React.useId();
  const [active, setActive] = React.useState<number | null>(null);

  // The plot is drawn at the pixels it has, so its numbers keep their size on a phone.
  const group = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState<number>(CHART_BOX.width);
  React.useLayoutEffect(() => {
    const node = group.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const read = () => {
      const inner = node.clientWidth - GROUP_PADDING_PX;
      if (inner > 0) {
        setWidth(inner);
      }
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const box = React.useMemo(() => boxFor(width), [width]);

  const { steps, from, to } = React.useMemo(
    () => chartSeries(points, running ? CHART_WINDOW_MS : null),
    [points, running],
  );
  const averageSeconds = Math.round(TRANSFER_AVERAGE_MS / 1000);

  const charts = React.useMemo(() => {
    const processed = chartOf(steps, "processed", from, to, box);
    return showTransferred
      ? [processed, chartOf(steps, "transferred", from, to, box)]
      : [processed];
  }, [steps, from, to, showTransferred, box]);

  // New measurements move under a held crosshair; one past the end falls back to the newest.
  const index = active === null ? null : Math.min(active, steps.length - 1);
  const step = index === null ? null : (steps[index] ?? null);

  const number = React.useMemo(
    () => new Intl.NumberFormat(language, { maximumFractionDigits: 1 }),
    [language],
  );
  const rate = (value: number) => t("units.perSecond", { value: formatBytes(value, language) });
  const axisValue = (chart: ChartData, value: number) => number.format(value / chart.unit.divisor);

  const timeLabel = (at: number): string =>
    running
      ? at >= to - 500
        ? t("chart.now")
        : t("chart.ago", { time: formatClock((to - at) / 1000) })
      : t("chart.elapsed", { time: formatClock((at - from) / 1000) });

  const summary = [
    t("chart.summary.intro", {
      scope: running ? t("chart.summary.recent") : t("chart.summary.whole"),
    }),
    ...charts.map((chart) => {
      const numbers = summaryOf(steps, chart.key);
      return t(`chart.summary.${chart.key}`, {
        current: rate(numbers.current),
        average: rate(numbers.average),
        peak: rate(numbers.peak),
        seconds: averageSeconds,
      });
    }),
    t("chart.summary.keys"),
  ].join(" ");

  const press = (move: CrosshairMove) => setActive(moveCrosshair(index, move, steps.length));
  const onKeyDown = (event: React.KeyboardEvent) => {
    const moves: Record<string, CrosshairMove> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      Home: "start",
      End: "end",
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      press(move);
    } else if (event.key === "Escape" && index !== null) {
      // Let go of the crosshair first; the next Escape closes whatever the charts sit in.
      event.preventDefault();
      event.stopPropagation();
      setActive(null);
    }
  };

  const tooltipText = step
    ? [
        timeLabel(step.at),
        ...charts.map(
          (chart) =>
            `${t(`chart.${chart.key}.title`)}${
              SMOOTHED_SERIES[chart.key]
                ? ` (${t("chart.averageOver", { seconds: averageSeconds })})`
                : ""
            }: ${rate(step[chart.key])}`,
        ),
      ].join(". ")
    : "";

  const crosshairPercent = step ? ((charts[0]?.scale.x(step.at) ?? 0) / box.width) * 100 : 0;

  return (
    <div
      ref={group}
      // Focusable on purpose: the arrow keys move the crosshair through the measurements.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a group that takes arrow keys
      // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls, this is a chart
      tabIndex={0}
      role="group"
      aria-label={summary}
      aria-describedby={tooltipId}
      data-slot="throughput-charts"
      onKeyDown={onKeyDown}
      onBlur={() => setActive(null)}
      className={cn(
        "relative space-y-3 rounded-lg border border-border px-3 pt-3 pb-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
    >
      {charts.map((chart, position) => (
        <Chart
          key={chart.key}
          chart={chart}
          title={t(`chart.${chart.key}.title`)}
          hint={t(`chart.${chart.key}.hint`, {
            unit: `${chart.unit.unit}/s`,
            seconds: averageSeconds,
          })}
          active={index}
          onActive={setActive}
          axisValue={axisValue}
          endLabel={rate}
          timeLabel={position === charts.length - 1 ? timeLabel : null}
        />
      ))}
      {step ? (
        <div
          data-slot="chart-tooltip"
          className="pointer-events-none absolute top-9 z-10 min-w-44 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          style={{
            left: `${crosshairPercent}%`,
            transform:
              crosshairPercent > 60 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
          }}
        >
          <div className="mb-1 text-muted-foreground">{timeLabel(step.at)}</div>
          {charts.map((chart) => (
            <div key={chart.key} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-0.5 w-3 rounded-full"
                style={{ background: "var(--chart-info)" }}
              />
              <b className="font-mono font-medium tabular-nums">{rate(step[chart.key])}</b>
              <span className="text-muted-foreground">{t(`chart.${chart.key}.title`)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {/* What the crosshair is on, read out when the arrow keys move it. */}
      <output id={tooltipId} aria-live="polite" className="sr-only">
        {tooltipText}
      </output>
    </div>
  );
}

function Chart({
  chart,
  title,
  hint,
  active,
  onActive,
  axisValue,
  endLabel,
  timeLabel,
}: {
  chart: ChartData;
  title: string;
  hint: string;
  active: number | null;
  onActive: (index: number | null) => void;
  axisValue: (chart: ChartData, value: number) => string;
  endLabel: (value: number) => string;
  /** Draws the shared time axis under this chart; null for the others. */
  timeLabel: ((at: number) => string) | null;
}) {
  const { scale, steps, key } = chart;
  const { box } = scale;
  const path = pathOf(steps, key, scale);
  const plotHeight = box.height - box.top - box.bottom;
  const step = active === null ? null : (steps[active] ?? null);
  const lastValue = steps[steps.length - 1]?.[key] ?? 0;
  const grid = Array.from({ length: GRID_STEPS + 1 }, (_, i) => (scale.max * i) / GRID_STEPS);
  const ticks = tickCount(box);

  const onPointer = (event: React.PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!(rect.width > 0)) {
      return;
    }
    const x =
      box.left + ((event.clientX - rect.left) / rect.width) * (box.width - box.left - box.right);
    onActive(nearestStep(steps, timeAtX(scale, x)));
  };

  return (
    <div data-chart={key}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h4 className="text-[12.5px] font-semibold">{title}</h4>
        <span className="text-[11.5px] text-muted-foreground">{hint}</span>
      </div>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${box.width} ${box.height}`}
        className="block h-auto w-full overflow-visible"
      >
        {grid.map((value) => {
          const y = scale.y(value);
          return (
            <g key={value}>
              <line
                x1={box.left}
                x2={box.width - box.right}
                y1={y}
                y2={y}
                className="stroke-border"
                strokeWidth={1}
              />
              <text
                x={box.left - 8}
                y={y + 3.5}
                textAnchor="end"
                className="fill-muted-foreground font-mono text-[10.5px]"
              >
                {axisValue(chart, value)}
              </text>
            </g>
          );
        })}
        {timeLabel
          ? Array.from({ length: ticks }, (_, i) => {
              const at = scale.from + ((scale.to - scale.from) * i) / (ticks - 1);
              return (
                <text
                  key={at}
                  x={scale.x(at)}
                  y={box.height - 5}
                  textAnchor={i === 0 ? "start" : i === ticks - 1 ? "end" : "middle"}
                  className="fill-muted-foreground font-mono text-[10.5px]"
                >
                  {timeLabel(at)}
                </text>
              );
            })
          : null}
        {path.last ? (
          <>
            <polygon points={path.area} fill="var(--chart-info)" fillOpacity={0.1} />
            <polyline
              points={path.line}
              fill="none"
              stroke="var(--chart-info)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <circle
              cx={path.last.x}
              cy={path.last.y}
              r={4}
              fill="var(--chart-info)"
              className="stroke-background"
              strokeWidth={2}
            />
            <text
              x={path.last.x + 9}
              y={path.last.y + 4}
              className="fill-foreground font-mono text-[11px] font-medium"
            >
              {endLabel(lastValue)}
            </text>
          </>
        ) : null}
        {step ? (
          <>
            <line
              data-slot="crosshair"
              x1={scale.x(step.at)}
              x2={scale.x(step.at)}
              y1={box.top}
              y2={box.top + plotHeight}
              className="stroke-muted-foreground"
              strokeWidth={1}
              opacity={0.55}
            />
            <circle
              cx={scale.x(step.at)}
              cy={scale.y(step[key])}
              r={4}
              fill="var(--chart-info)"
              className="stroke-background"
              strokeWidth={2}
            />
          </>
        ) : null}
        <rect
          x={box.left}
          y={box.top}
          width={box.width - box.left - box.right}
          height={plotHeight}
          fill="transparent"
          className="cursor-crosshair"
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => onActive(null)}
        />
      </svg>
    </div>
  );
}
