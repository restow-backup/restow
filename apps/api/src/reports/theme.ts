/**
 * The look of every PDF report: one palette, one type scale, one spacing
 * grid. The colours are the web app's light theme tokens (apps/web/src/
 * index.css, converted from OKLCH to hex): Nile text, Silt secondary text,
 * Lapis accent, the brand green, amber and red, so a report reads like the
 * page it was exported from; a PDF has no dark mode, it is printed on white,
 * and it always uses the brand colour scheme (the web app's Neutral scheme is
 * a screen setting of one browser).
 *
 * Green means proof (brand guide, section 4), here as in the app: a restore
 * that completed, a rating of Ready, a restore check that passed. A backup
 * run that merely completed is Lapis (`accent`) in a chart, and a figure that
 * moved the right way is plain text (`positive`), never green.
 *
 * Fonts are the PDF standard fonts only: nothing is downloaded or embedded.
 * The web app's Inter Tight and IBM Plex Mono are not used here. Embedding
 * them would make the api depend on the font packages, ship their files in
 * the image and need a fallback for the characters their latin subsets lack
 * (text.ts maps every string to what Helvetica can show today), which is more
 * than a palette change. Helvetica stands in for Inter Tight and Courier for
 * IBM Plex Mono.
 */

export const colors = {
  /** Nile (--foreground). */
  text: "#0f1b2d",
  /** Silt, one step darker (--muted-foreground): 5.2:1 on white. */
  muted: "#646d7e",
  /** A lighter Silt for muted figures and the chart baseline. */
  subtle: "#8a93a3",
  /** --border. */
  border: "#e3e6ec",
  /** --muted: table headers and figure tiles. */
  surface: "#edeff3",
  background: "#ffffff",
  /** Lapis (--primary): also the colour of backup runs that completed, which no restore check has read yet. */
  accent: "#2b4c9b",
  /** Green, proof only (--success). */
  success: "#2da37a",
  successText: "#007152",
  warning: "#d69e2e",
  warningText: "#825700",
  /** The brand red one step darker (--destructive). */
  destructive: "#c63437",
  destructiveText: "#ad2e30",
  neutral: "#8a93a3",
  /** Categorical chart palette (--chart-1 .. --chart-5). */
  chart: ["#0650ad", "#ef6505", "#a23070", "#9874ff", "#089883"] as const,
} as const;

export const fonts = {
  regular: "Helvetica",
  bold: "Helvetica-Bold",
  /** The mono face of the wordmark's second part. */
  mono: "Courier",
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

/**
 * Tones a figure or a badge can carry. `success` is green and means proof
 * only; `positive` is good news in plain text colour.
 */
export type Tone = "neutral" | "positive" | "success" | "warning" | "destructive";

export const toneColor: Record<Tone, string> = {
  neutral: colors.muted,
  positive: colors.text,
  success: colors.successText,
  warning: colors.warningText,
  destructive: colors.destructiveText,
};
