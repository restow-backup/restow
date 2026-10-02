import type { SamplePoint } from "../api";
import { sparkline } from "../samples";

/**
 * The speed of a running run in a row, as a small line: 2 px, a 10 % fill and a dot on the
 * newest value, in Lapis (a running operation, brand guide). It says nothing the row's own text
 * does not ("412 MB/s"), so it is hidden from assistive technology.
 */
export function Sparkline({
  points,
  width = 112,
  height = 26,
}: {
  points: readonly SamplePoint[] | null | undefined;
  width?: number;
  height?: number;
}) {
  const path = sparkline(points ?? [], width, height);
  if (!path.last) {
    // The same width, so a row does not jump when the first measurements arrive.
    return <span aria-hidden="true" className="inline-block shrink-0" style={{ width, height }} />;
  }
  return (
    <svg
      aria-hidden="true"
      data-slot="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
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
