import type { StatusTone } from "./status-badge.js";

/**
 * The status tones a chart series can carry. `neutral` is a badge outline and
 * cannot be drawn as a bar next to the muted grey; a run that completed but
 * that no restore check proved is `info` (Lapis) in a chart. `attention` has no
 * chart token yet (a candidate that keeps 3:1 against the card does not stay
 * apart from --chart-destructive in light); `chartTone` draws it in the chart
 * warning orange until the theme rework adds --chart-attention.
 */
export type ChartStatusTone = Exclude<StatusTone, "neutral" | "attention">;

/**
 * The chart tone of a status tone: `neutral` is drawn muted, and `attention`
 * takes --chart-warning, the orange of the chart palette (hue 60), as the
 * stand-in until --chart-attention exists. A series that must stay apart from
 * a warning series next to it carries a pattern as well (see ChartHatchDefs).
 */
export function chartTone(tone: StatusTone): ChartStatusTone {
  switch (tone) {
    case "neutral":
      return "muted";
    case "attention":
      return "warning";
    default:
      return tone;
  }
}

/**
 * The series colour of each status tone. Every status-coded series (backup
 * and restore outcomes, recovery readiness) takes its colour from here, on
 * every page, so a state wears the same colour wherever it is plotted: the
 * proven outcomes (a restore that completed, Ready) are success (green, which
 * means proof and nothing else), a backup that merely completed is info
 * (Lapis, never green: no restore check has read it back), Needs attention,
 * Unverified (hatched) and runs with failed items warning, failed, Not
 * restorable and No backup yet (hatched) destructive, cancelled muted.
 *
 * These are chart tokens, not the UI tones (`--success`, `--warning`, ...):
 * each reaches 3:1 against `--card` in light and dark, and the five stay
 * apart for normal and colour-blind vision (components/ui/tokens.test.ts).
 * Categorical series (volumes, durations) keep `--chart-1` .. `--chart-5`.
 */
export const STATUS_CHART_COLOR: Readonly<Record<ChartStatusTone, string>> = {
  success: "var(--chart-success)",
  info: "var(--chart-info)",
  warning: "var(--chart-warning)",
  destructive: "var(--chart-destructive)",
  muted: "var(--chart-muted)",
};
