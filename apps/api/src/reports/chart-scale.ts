/**
 * Axis arithmetic for the report charts (pure): a value axis with round tick
 * values, and which category labels fit under a chart without overlapping.
 */

export interface Scale {
  /** Top of the axis; at least the largest value. */
  readonly max: number;
  /** Tick values from 0 to `max`, evenly spaced. */
  readonly ticks: readonly number[];
}

/**
 * A value axis from 0 to a round number at or above `maxValue`, with about
 * `targetTicks` intervals of 1, 2, 2.5 or 5 times a power of ten. With
 * `integer` the step is never below 1 (counts of runs, objects, items).
 */
export function niceScale(maxValue: number, targetTicks = 4, integer = false): Scale {
  const top = Number.isFinite(maxValue) && maxValue > 0 ? maxValue : 0;
  if (top === 0) {
    return { max: 1, ticks: [0, 1] };
  }
  const rough = top / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const factor = residual > 5 ? 10 : residual > 2.5 ? 5 : residual > 2 ? 2.5 : residual > 1 ? 2 : 1;
  let step = factor * magnitude;
  if (integer) {
    step = Math.max(1, Math.ceil(step));
  }
  const max = Math.ceil(top / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let tick = 0; tick <= max + step / 2; tick += step) {
    ticks.push(Number(tick.toPrecision(12)));
  }
  return { max: ticks[ticks.length - 1] as number, ticks };
}

/**
 * Indices of the categories to label when at most `maxLabels` fit: the first
 * and the last always, the rest evenly spaced in between.
 */
export function labelIndices(count: number, maxLabels: number): number[] {
  if (count <= 0) {
    return [];
  }
  if (count <= maxLabels) {
    return Array.from({ length: count }, (_, index) => index);
  }
  if (maxLabels <= 1) {
    return [0];
  }
  const step = (count - 1) / (maxLabels - 1);
  const indices = new Set<number>();
  for (let position = 0; position < maxLabels; position += 1) {
    indices.add(Math.round(position * step));
  }
  return [...indices].sort((a, b) => a - b);
}
