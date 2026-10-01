import { Line, Polyline, Rect, StyleSheet, Svg, Text, View } from "@react-pdf/renderer";
import { labelIndices, niceScale } from "./chart-scale.js";
import { pdfText } from "./text.js";
import { colors, contentWidth, fontSize, space } from "./theme.js";

/**
 * Static charts drawn as vector graphics: bars (stacked or grouped) and
 * lines over a sequence of categories. Axis and category labels are regular
 * text laid over the drawing, so they use the report font and can be read
 * back from the PDF.
 */

export interface ChartSeries {
  readonly label: string;
  readonly color: string;
  /** One value per category; must be as long as the category list. */
  readonly values: readonly number[];
}

export interface ChartProps {
  /** Category labels, already formatted (days, weeks, months). */
  readonly categories: readonly string[];
  readonly series: readonly ChartSeries[];
  /** Formats a value on the value axis. */
  readonly formatValue: (value: number) => string;
  /** Values are counts: ticks never fall between whole numbers. */
  readonly integer?: boolean;
  readonly width?: number;
  readonly height?: number;
}

const AXIS_WIDTH = space(14);
const LABEL_HEIGHT = space(4);
const TOP_PADDING = space(1);
/** Room one category label needs so neighbours do not overlap. */
const MIN_LABEL_WIDTH = space(12);

const styles = StyleSheet.create({
  frame: { position: "relative" },
  axisLabel: {
    position: "absolute",
    left: 0,
    width: AXIS_WIDTH - space(1),
    textAlign: "right",
    fontSize: fontSize.caption,
    color: colors.muted,
  },
  categoryLabel: {
    position: "absolute",
    width: MIN_LABEL_WIDTH * 2,
    textAlign: "center",
    fontSize: fontSize.caption,
    color: colors.muted,
  },
});

interface Plot {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly scaleMax: number;
  readonly ticks: readonly number[];
  /** Vertical position of a value. */
  y(value: number): number;
  /** Horizontal centre of a category. */
  x(index: number): number;
  readonly slot: number;
}

function plotOf(props: ChartProps, maxValue: number): Plot {
  const width = props.width ?? contentWidth;
  const height = props.height ?? space(32);
  const left = AXIS_WIDTH;
  const top = TOP_PADDING;
  const plotWidth = width - left;
  const plotHeight = height - top - LABEL_HEIGHT;
  const scale = niceScale(maxValue, 4, props.integer ?? false);
  const count = Math.max(1, props.categories.length);
  const slot = plotWidth / count;
  return {
    width,
    height,
    left,
    top,
    plotWidth,
    plotHeight,
    scaleMax: scale.max,
    ticks: scale.ticks,
    slot,
    y: (value) => top + plotHeight - (Math.max(0, value) / scale.max) * plotHeight,
    x: (index) => left + slot * (index + 0.5),
  };
}

/** Gridlines with value labels, and the category labels that fit. */
function Axes(props: { readonly plot: Plot; readonly chart: ChartProps }) {
  const { plot, chart } = props;
  const maxLabels = Math.max(1, Math.floor(plot.plotWidth / MIN_LABEL_WIDTH / 1.5));
  return (
    <>
      {plot.ticks.map((tick) => (
        <Text key={`tick-${tick}`} style={[styles.axisLabel, { top: plot.y(tick) - 4 }]}>
          {pdfText(chart.formatValue(tick))}
        </Text>
      ))}
      {labelIndices(chart.categories.length, maxLabels).map((index) => (
        <Text
          key={`category-${index}`}
          style={[
            styles.categoryLabel,
            // Centred under its category; the box is wider than the text, so
            // it may reach past the chart edge without the text doing so.
            { left: plot.x(index) - MIN_LABEL_WIDTH, top: plot.top + plot.plotHeight + 2 },
          ]}
        >
          {pdfText(chart.categories[index] ?? "")}
        </Text>
      ))}
    </>
  );
}

function Grid(props: { readonly plot: Plot }) {
  const { plot } = props;
  return (
    <>
      {plot.ticks.map((tick) => (
        <Line
          key={`grid-${tick}`}
          x1={plot.left}
          x2={plot.width}
          y1={plot.y(tick)}
          y2={plot.y(tick)}
          stroke={tick === 0 ? colors.subtle : colors.border}
          strokeWidth={tick === 0 ? 0.8 : 0.5}
        />
      ))}
    </>
  );
}

export interface BarChartProps extends ChartProps {
  /** Stack the series on top of each other instead of side by side. */
  readonly stacked?: boolean;
}

export function BarChart(props: BarChartProps) {
  const count = props.categories.length;
  const stacked = props.stacked ?? false;
  const maxValue = Math.max(
    0,
    ...Array.from({ length: count }, (_, index) =>
      stacked
        ? props.series.reduce((sum, series) => sum + Math.max(0, series.values[index] ?? 0), 0)
        : Math.max(0, ...props.series.map((series) => series.values[index] ?? 0)),
    ),
  );
  const plot = plotOf(props, maxValue);
  const groupWidth = Math.max(0.5, plot.slot * 0.72);
  const barWidth = stacked ? groupWidth : groupWidth / Math.max(1, props.series.length);

  const bars: { key: string; x: number; y: number; height: number; color: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    let base = 0;
    props.series.forEach((series, position) => {
      const value = Math.max(0, series.values[index] ?? 0);
      if (value === 0) {
        return;
      }
      const top = stacked ? base + value : value;
      const bottom = stacked ? base : 0;
      const x = stacked
        ? plot.x(index) - groupWidth / 2
        : plot.x(index) - groupWidth / 2 + position * barWidth;
      bars.push({
        key: `${index}-${position}`,
        x,
        y: plot.y(top),
        height: Math.max(0.3, plot.y(bottom) - plot.y(top)),
        color: series.color,
      });
      base += value;
    });
  }

  return (
    <View style={[styles.frame, { width: plot.width, height: plot.height }]}>
      <Svg width={plot.width} height={plot.height}>
        <Grid plot={plot} />
        {bars.map((bar) => (
          <Rect
            key={bar.key}
            x={bar.x}
            y={bar.y}
            width={barWidth}
            height={bar.height}
            fill={bar.color}
          />
        ))}
      </Svg>
      <Axes plot={plot} chart={props} />
    </View>
  );
}

export function LineChart(props: ChartProps) {
  const maxValue = Math.max(0, ...props.series.flatMap((series) => series.values));
  const plot = plotOf(props, maxValue);
  return (
    <View style={[styles.frame, { width: plot.width, height: plot.height }]}>
      <Svg width={plot.width} height={plot.height}>
        <Grid plot={plot} />
        {props.series.map((series) => (
          <Polyline
            key={series.label}
            points={series.values
              .map((value, index) => `${plot.x(index).toFixed(2)},${plot.y(value).toFixed(2)}`)
              .join(" ")}
            fill="none"
            stroke={series.color}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        ))}
        {/* A single point draws no line; mark it so the value is still visible. */}
        {props.categories.length === 1
          ? props.series.map((series) => (
              <Rect
                key={`point-${series.label}`}
                x={plot.x(0) - 2}
                y={plot.y(series.values[0] ?? 0) - 2}
                width={4}
                height={4}
                fill={series.color}
              />
            ))
          : null}
      </Svg>
      <Axes plot={plot} chart={props} />
    </View>
  );
}
