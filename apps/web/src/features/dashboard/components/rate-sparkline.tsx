import { type RatePoint, RUNNING_WINDOW_MS, sparkPath } from "../running-model.js";

/**
 * The small line of one run's speed over the last minutes ("Running now" on the start page, the
 * running guests in a Proxmox VE job's detail panel). Kept apart from the widget so a page that
 * shows it does not load the charts library with it.
 */

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 24;

/** A run's speed over the last minutes, in Lapis like every running operation; decoration only. */
export function RateSparkline({ points, now }: { points: readonly RatePoint[]; now: number }) {
  const path = sparkPath(points, SPARK_WIDTH, SPARK_HEIGHT, now - RUNNING_WINDOW_MS, now);
  if (!path.last) {
    // The same width, so a row does not jump when the first figures arrive.
    return (
      <span
        aria-hidden="true"
        className="inline-block shrink-0"
        style={{ width: SPARK_WIDTH, height: SPARK_HEIGHT }}
      />
    );
  }
  return (
    <svg
      aria-hidden="true"
      data-slot="sparkline"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      className="shrink-0 overflow-visible"
    >
      <polygon points={path.area} fill="var(--chart-info)" fillOpacity={0.1} />
      <polyline
        points={path.line}
        fill="none"
        stroke="var(--chart-info)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={path.last.x} cy={path.last.y} r={2.5} fill="var(--chart-info)" />
    </svg>
  );
}
