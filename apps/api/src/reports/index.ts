/**
 * Reusable building blocks for the PDF reports the api renders with
 * @react-pdf/renderer (the statistics report today, the archive evidence
 * report next): the page frame with header and paginated footer, key-figure
 * tiles, data tables, static bar and line charts, notices, formatting, the
 * `reports` translations and text that the standard PDF fonts can show.
 */
export { Legend, Notes, Notice, Section } from "./blocks.js";
export type { LegendEntry } from "./blocks.js";
export { BarChart, LineChart } from "./charts.js";
export type { BarChartProps, ChartProps, ChartSeries } from "./charts.js";
export { labelIndices, niceScale } from "./chart-scale.js";
export { ReportDocument, ReportHeader, ReportPage } from "./document.js";
export * from "./format.js";
export { reportTranslator } from "./i18n.js";
export type { Translate } from "./i18n.js";
export { KpiGrid } from "./kpi.js";
export type { KpiTile } from "./kpi.js";
export { PDF_CONTENT_TYPE, renderPdf } from "./render.js";
export { ReportTable } from "./table.js";
export type { TableCell, TableColumn } from "./table.js";
export { pdfText } from "./text.js";
export { colors, contentWidth, fontSize, fonts, space } from "./theme.js";
export type { Tone } from "./theme.js";
