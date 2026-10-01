import { type StatsDataset, type StatsParams, statsCsvPath, statsPdfPath } from "./api.js";
import type { DownloadRequest } from "./download.js";
import type { ResolvedPeriod } from "./period.js";

/**
 * The two kinds of stats downloads as requests for `downloadFile`: one CSV
 * per dataset and the PDF report of the whole view. The server names the
 * file (Content-Disposition); the fallback names say what and which period.
 */

function periodSuffix(period: ResolvedPeriod): string {
  return `${period.firstDay}_${period.lastDay}`;
}

function scopePart(params: StatsParams): string {
  return params.scope === "provider" ? "-provider" : "";
}

export function csvDownload(
  dataset: StatsDataset,
  params: StatsParams,
  period: ResolvedPeriod,
): DownloadRequest {
  return {
    path: statsCsvPath(dataset, params),
    accept: "text/csv",
    fallbackName: `restow-stats${scopePart(params)}-${dataset}-${periodSuffix(period)}.csv`,
  };
}

export function pdfDownload(
  params: StatsParams,
  period: ResolvedPeriod,
  language: string,
): DownloadRequest {
  return {
    path: statsPdfPath(params, language),
    accept: "application/pdf",
    fallbackName: `restow-stats${scopePart(params)}-report-${periodSuffix(period)}.pdf`,
  };
}
