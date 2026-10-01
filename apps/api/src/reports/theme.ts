/**
 * The look of every PDF report: one palette, one type scale, one spacing
 * grid. The colours are the web app's light theme tokens (apps/web/src/
 * index.css, converted from OKLCH), so a report reads like the page it was
 * exported from; a PDF has no dark mode, it is printed on white.
 *
 * Fonts are the PDF standard fonts only: nothing is downloaded or embedded.
 */

export const colors = {
  text: "#18181b",
  muted: "#71717a",
  subtle: "#a1a1aa",
  border: "#e4e4e7",
  surface: "#f4f4f5",
  background: "#ffffff",
  accent: "#0650ad",
  success: "#16a34a",
  successText: "#027133",
  warning: "#f59e09",
  warningText: "#9f4500",
  destructive: "#e7000b",
  destructiveText: "#b7000f",
  neutral: "#a1a1aa",
  /** Categorical chart palette (--chart-1 .. --chart-5). */
  chart: ["#0650ad", "#ef6505", "#a23070", "#9874ff", "#089883"] as const,
} as const;

export const fonts = {
  regular: "Helvetica",
  bold: "Helvetica-Bold",
} as const;

/** Type scale in points. */
export const fontSize = {
  caption: 7,
  small: 8,
  body: 9,
  lead: 10,
  heading: 12,
  title: 18,
} as const;

/** The 4-point spacing grid: `space(2)` is 8 pt. */
export function space(steps: number): number {
  return steps * 4;
}

/** A4 portrait in points, and the page margins every report uses. */
export const page = {
  width: 595.28,
  height: 841.89,
  marginX: space(10),
  marginTop: space(10),
  /** Room kept free at the bottom for the running footer. */
  marginBottom: space(14),
} as const;

/** Width available to content between the margins. */
export const contentWidth = page.width - 2 * page.marginX;

/** Tones a figure or a badge can carry. */
export type Tone = "neutral" | "success" | "warning" | "destructive";

export const toneColor: Record<Tone, string> = {
  neutral: colors.muted,
  success: colors.successText,
  warning: colors.warningText,
  destructive: colors.destructiveText,
};
