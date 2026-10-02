import type { SamplePoint } from "./api";

/**
 * The maths behind the sparkline of a row and the two charts of the run drawer: from the
 * cumulative measurements of a run (`[time, processed bytes, transferred bytes]`) to rates, to
 * the pixels of a small chart, to the point under a crosshair. Pure functions, so the
 * charts' behaviour is tested without a DOM.
 */

/** How much of a running run the drawer's charts show. */
export const CHART_WINDOW_MS = 5 * 60_000;

export type SeriesKey = "processed" | "transferred";

/** The rate over one step between two neighbouring measurements. */
export interface RateStep {
  /** The later measurement's time (epoch ms). */
  at: number;
  /** Bytes per second. */
  processed: number;
  transferred: number;
}

/**
 * The speed of every step. A counter that went back (a run that was restarted) counts as
 * standing still, never as a negative speed; two measurements at the same moment make no step.
 */
export function rateSteps(points: readonly SamplePoint[]): RateStep[] {
  const steps: RateStep[] = [];
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1] as SamplePoint;
    const to = points[index] as SamplePoint;
    const seconds = (to[0] - from[0]) / 1000;
    if (seconds <= 0) {
      continue;
    }
    steps.push({
      at: to[0],
      processed: Math.max(0, to[1] - from[1]) / seconds,
      transferred: Math.max(0, to[2] - from[2]) / seconds,
    });
  }
  return steps;
}

/**
 * How long the transfer to the repository is averaged over. Data does not reach the repository
 * evenly: the agent writes it in packs, so the repository grows in steps, and the speed between
 * two neighbouring measurements jumps between nothing and a burst (a square wave) although the
 * connection is steady. Every point of the transfer chart is therefore the average over this long
 * (at the start of a run, over what there is). The processing series is not averaged: bytes read
 * move evenly.
 */
export const TRANSFER_AVERAGE_MS = 15_000;

/** Which series are drawn as an average over {@link TRANSFER_AVERAGE_MS}. */
export const SMOOTHED_SERIES: Readonly<Record<SeriesKey, boolean>> = {
  processed: false,
  transferred: true,
};

/** A counter that only ever grows: a step back (a restarted run) counts as standing still. */
function growing(points: readonly SamplePoint[], column: 1 | 2): number[] {
  const values: number[] = [];
  let total = 0;
  for (const [index, point] of points.entries()) {
    const before = points[index - 1];
    total += before ? Math.max(0, point[column] - before[column]) : 0;
    values.push(total);
  }
  return values;
}

/** The value of a counter at a moment between two measurements, on the straight line between them. */
function valueAt(times: readonly number[], values: readonly number[], at: number): number {
  const first = times[0] ?? 0;
  if (at <= first) {
    return values[0] ?? 0;
  }
  for (let index = times.length - 1; index >= 0; index--) {
    const time = times[index] as number;
    if (time <= at) {
      const next = times[index + 1];
      if (next === undefined || next <= time) {
        return values[index] as number;
      }
      const share = (at - time) / (next - time);
      const low = values[index] as number;
      return low + share * ((values[index + 1] as number) - low);
    }
  }
  return values[0] ?? 0;
}

/**
 * The speed at every step as an average over the trailing `windowMs`: the growth of the counter
 * over the last `windowMs` (between the measurements it grows evenly, as `rateSteps` assumes),
 * divided by that time. Shorter at the start of a run, where there is no more history. There is
 * one entry per step of {@link rateSteps} of the same points, at the same moments, so the two can
 * be put side by side; the total of what moved is the same, only spread out.
 */
export function smoothedRateSteps(
  points: readonly SamplePoint[],
  windowMs: number = TRANSFER_AVERAGE_MS,
): RateStep[] {
  const times = points.map((point) => point[0]);
  const processed = growing(points, 1);
  const transferred = growing(points, 2);
  const first = times[0] ?? 0;
  const steps: RateStep[] = [];
  for (let index = 1; index < points.length; index++) {
    const at = times[index] as number;
    if (at - (times[index - 1] as number) <= 0) {
      continue;
    }
    const from = Math.max(first, at - windowMs);
    const seconds = (at - from) / 1000;
    steps.push({
      at,
      processed: ((processed[index] as number) - valueAt(times, processed, from)) / seconds,
      transferred: ((transferred[index] as number) - valueAt(times, transferred, from)) / seconds,
    });
  }
  return steps;
}

/** What a chart draws: the steps of the shown stretch, and the time axis of it. */
export interface ChartSeries {
  steps: RateStep[];
  /** Start and end of the time axis (epoch ms). */
  from: number;
  to: number;
}

/**
 * The steps of the newest `windowMs` of a history (all of it for null), with the transfer
 * averaged over {@link TRANSFER_AVERAGE_MS} on the whole history, so the first points of a
 * window have the history behind them and are not cut short at its edge.
 */
export function chartSeries(points: readonly SamplePoint[], windowMs: number | null): ChartSeries {
  const windowed = windowOf(points, windowMs);
  const from = windowed[0]?.[0] ?? 0;
  const to = Math.max(from + 1, windowed[windowed.length - 1]?.[0] ?? from + 1);
  const raw = rateSteps(points);
  const smooth = smoothedRateSteps(points);
  const steps = raw.flatMap((step, index): RateStep[] =>
    step.at > from ? [{ ...step, transferred: (smooth[index] as RateStep).transferred }] : [],
  );
  return { steps, from, to };
}

/**
 * The newest `windowMs` of a history (one measurement older than that stays, so the first
 * step of the window has a start); the whole history when `windowMs` is null.
 */
export function windowOf(points: readonly SamplePoint[], windowMs: number | null): SamplePoint[] {
  const last = points[points.length - 1];
  if (windowMs === null || !last) {
    return [...points];
  }
  const from = last[0] - windowMs;
  const first = points.findIndex((point) => point[0] >= from);
  if (first === -1) {
    return [last];
  }
  return points.slice(Math.max(0, first - 1));
}

/** A round upper bound for an axis: 1, 2, 5 or 10 times a power of ten, at least `value`. */
export function niceMax(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) {
    return 1;
  }
  const power = 10 ** Math.floor(Math.log10(value));
  const mantissa = value / power;
  const step = mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10;
  return step * power;
}

/** The unit an axis is drawn in: all its labels share it, so they read at a glance. */
export const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
export type ByteUnit = (typeof BYTE_UNITS)[number];

export function unitFor(maxBytesPerSecond: number): { unit: ByteUnit; divisor: number } {
  let index = 0;
  let divisor = 1;
  while (index < BYTE_UNITS.length - 1 && maxBytesPerSecond / divisor >= 1024) {
    divisor *= 1024;
    index++;
  }
  return { unit: BYTE_UNITS[index] as ByteUnit, divisor };
}

/** The geometry of one small chart: where the plot lies inside its SVG. */
export interface ChartBox {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const CHART_BOX: ChartBox = {
  width: 700,
  height: 124,
  left: 48,
  right: 84,
  top: 10,
  bottom: 22,
};

/** Below this width of the plot's container the chart gets tighter margins and fewer time labels. */
export const NARROW_CHART_PX = 480;
/** The widest the plot's own coordinate system grows; beyond it the drawing scales up a little. */
export const MAX_CHART_PX = 900;

/**
 * The geometry for a container this many pixels wide. The SVG's coordinates are the pixels it is
 * drawn at, so its numbers stay at their size on a phone instead of shrinking with the width.
 */
export function boxFor(containerWidth: number): ChartBox {
  const width = Math.min(MAX_CHART_PX, Math.max(240, Math.round(containerWidth)));
  return width < NARROW_CHART_PX
    ? { ...CHART_BOX, width, left: 40, right: 70 }
    : { ...CHART_BOX, width };
}

/** How many time labels fit under the axis. */
export function tickCount(box: ChartBox): number {
  return box.width < NARROW_CHART_PX ? 3 : 5;
}

export interface ChartScale {
  box: ChartBox;
  /** Start and end of the time axis (epoch ms). */
  from: number;
  to: number;
  /** The axis' upper bound in bytes per second. */
  max: number;
  x(at: number): number;
  y(value: number): number;
}

export function scaleOf(
  from: number,
  to: number,
  maxValue: number,
  box: ChartBox = CHART_BOX,
): ChartScale {
  const max = niceMax(maxValue * 1.15);
  const innerWidth = box.width - box.left - box.right;
  const innerHeight = box.height - box.top - box.bottom;
  const span = Math.max(1, to - from);
  return {
    box,
    from,
    to,
    max,
    x: (at) => box.left + ((at - from) / span) * innerWidth,
    y: (value) => box.top + innerHeight - (Math.max(0, value) / max) * innerHeight,
  };
}

export interface ChartPath {
  /** `x,y x,y ...` for a polyline. */
  line: string;
  /** The same closed down to the axis, for the fill. */
  area: string;
  last: { x: number; y: number } | null;
}

const fixed = (value: number) => Number(value.toFixed(1));

export function pathOf(steps: readonly RateStep[], key: SeriesKey, scale: ChartScale): ChartPath {
  if (steps.length === 0) {
    return { line: "", area: "", last: null };
  }
  const coordinates = steps.map((step) => ({
    x: fixed(scale.x(step.at)),
    y: fixed(scale.y(step[key])),
  }));
  const line = coordinates.map(({ x, y }) => `${x},${y}`).join(" ");
  const floor = fixed(scale.y(0));
  const first = coordinates[0] as { x: number; y: number };
  const last = coordinates[coordinates.length - 1] as { x: number; y: number };
  return { line, area: `${first.x},${floor} ${line} ${last.x},${floor}`, last };
}

/** Which of `count` steps lies under a pointer at `fraction` (0 to 1) of the plot's width. */
export function indexAtFraction(fraction: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(count - 1, Math.round(fraction * (count - 1))));
}

/**
 * The step nearest to a moment: where a pointer over the plot points, with the steps spread
 * unevenly in time (older points are thinned). Null without steps.
 */
export function nearestStep(steps: readonly RateStep[], at: number): number | null {
  if (steps.length === 0) {
    return null;
  }
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (const [index, step] of steps.entries()) {
    const gap = Math.abs(step.at - at);
    if (gap < distance) {
      best = index;
      distance = gap;
    }
  }
  return best;
}

/** The moment a pointer at `x` (in the SVG's own units) is over, clamped to the plot. */
export function timeAtX(scale: ChartScale, x: number): number {
  const { left, width, right } = scale.box;
  const inner = width - left - right;
  const fraction = Math.max(0, Math.min(1, (x - left) / inner));
  return scale.from + fraction * (scale.to - scale.from);
}

export type CrosshairMove = "left" | "right" | "start" | "end";

/**
 * Where the crosshair goes on a key press. Without one yet, the arrows start at the newest step
 * (that is where the eye is on a running chart).
 */
export function moveCrosshair(current: number | null, move: CrosshairMove, count: number): number {
  const last = Math.max(0, count - 1);
  switch (move) {
    case "start":
      return 0;
    case "end":
      return last;
    case "left":
      return Math.max(0, (current ?? last) - 1);
    default:
      return Math.min(last, (current ?? last) + 1);
  }
}

export interface SeriesSummary {
  current: number;
  average: number;
  peak: number;
}

/** The numbers a text summary of a series names. Zeros for a series without steps. */
export function summaryOf(steps: readonly RateStep[], key: SeriesKey): SeriesSummary {
  if (steps.length === 0) {
    return { current: 0, average: 0, peak: 0 };
  }
  const values = steps.map((step) => step[key]);
  return {
    current: values[values.length - 1] as number,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    peak: Math.max(...values),
  };
}

/** The points of a sparkline in a box of `width` x `height`, and where its last point lies. */
export function sparkline(
  points: readonly SamplePoint[],
  width: number,
  height: number,
  key: SeriesKey = "processed",
): ChartPath {
  const steps = rateSteps(points);
  if (steps.length === 0) {
    return { line: "", area: "", last: null };
  }
  const peak = Math.max(...steps.map((step) => step[key]), 1);
  const max = peak * 1.1;
  const first = (steps[0] as RateStep).at;
  const span = Math.max(1, (steps[steps.length - 1] as RateStep).at - first);
  const pad = 2;
  const x = (at: number) =>
    (steps.length === 1 ? width : ((at - first) / span) * (width - pad)) +
    (steps.length === 1 ? 0 : pad / 2);
  const y = (value: number) => height - pad / 2 - (value / max) * (height - pad);
  const coordinates = steps.map((step) => ({ x: fixed(x(step.at)), y: fixed(y(step[key])) }));
  const line = coordinates.map((c) => `${c.x},${c.y}`).join(" ");
  const last = coordinates[coordinates.length - 1] as { x: number; y: number };
  const start = coordinates[0] as { x: number; y: number };
  return {
    line,
    area: `${start.x},${height} ${line} ${last.x},${height}`,
    last,
  };
}

/** A length of time as `m:ss`, or `h:mm:ss` from an hour on (whole seconds, never negative). */
export function formatClock(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pair = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pair(minutes)}:${pair(seconds)}` : `${minutes}:${pair(seconds)}`;
}
