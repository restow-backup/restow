import type { StatusTone } from "./status-badge.js";

/**
 * The status tones a chart series can carry. `neutral` is a badge outline and
 * cannot be drawn as a bar next to the muted grey; a run that completed but
 * that no restore check proved is `info` (Lapis) in a chart.
 */
export type ChartStatusTone = Exclude<StatusTone, "neutral">;

/**
 * The series colour of each status tone. Every status-coded series (backup
 * and restore outcomes, recovery readiness) takes its colour from here, on
 * every page, so a state wears the same colour wherever it is plotted: the
 * proven outcomes (a restore that completed, Ready) are success (green, which
 * means proof and nothing else), a backup that merely completed is info
 * (Lapis, never green: no restore check has read it back), Attention and runs
 * with failed items warning, failed and Not restorable destructive, cancelled
 * and unverified muted.
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
