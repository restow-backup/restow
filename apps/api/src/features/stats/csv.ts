import {
  type DatasetName,
  KPI_NAMES,
  type StatsDto,
  type UnavailableReason,
  isUnavailable,
} from "./dto.js";

/**
 * CSV export of one statistics dataset (pure).
 *
 * The file follows RFC 4180: comma separated, CRLF line ends, a header row,
 * and a field in double quotes (quotes doubled) when it holds a comma, a
 * quote or a line break. It starts with a UTF-8 byte order mark, so
 * spreadsheet programs read umlauts correctly.
 *
 * Spreadsheets execute a cell that starts with `=`, `+`, `-` or `@` as a
 * formula (CSV injection). Text cells that start with one of these, or with
 * a tab or carriage return, are prefixed with an apostrophe, which shows the
 * text as typed. Numbers are written as numbers and never altered, so a
 * figure stays a figure.
 *
 * Headers are the field names of the JSON contract, the same in every
 * language, so scripts can rely on them.
 */

export type CsvValue = string | number | boolean | null | undefined;

export const CSV_BOM = "﻿";
const LINE_END = "\r\n";
const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** A text cell as the spreadsheet should show it: formula triggers neutralised. */
export function neutralise(text: string): string {
  return text.length > 0 && FORMULA_TRIGGERS.has(text[0] as string) ? `'${text}` : text;
}

/** One field, quoted when RFC 4180 requires it. */
export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = typeof value === "string" ? neutralise(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A complete CSV document: BOM, header row, data rows, CRLF after every record. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const records = [header, ...rows].map((record) => record.map(csvField).join(","));
  return `${CSV_BOM}${records.join(LINE_END)}${LINE_END}`;
}

export interface CsvTable {
  header: string[];
  rows: CsvValue[][];
}

/**
 * The table behind a dataset, why the dataset has none, or null when the
 * dataset is not part of the scope (the tenant table outside the provider scope).
 */
export function datasetTable(
  stats: StatsDto,
  dataset: DatasetName,
): CsvTable | { unavailable: UnavailableReason } | null {
  const { series, tables } = stats;
  switch (dataset) {
    case "kpis":
      return {
        header: ["metric", "value", "previous"],
        rows: KPI_NAMES.map((name) => [name, stats.kpis[name].value, stats.kpis[name].previous]),
      };
    case "backups":
      return isUnavailable(series.backups)
        ? series.backups
        : {
            header: ["t", "succeeded", "failed", "cancelled"],
            rows: series.backups.map((p) => [p.t, p.succeeded, p.failed, p.cancelled]),
          };
    case "volume":
      return isUnavailable(series.volume)
        ? series.volume
        : {
            header: ["t", "logicalBytes", "physicalBytes"],
            rows: series.volume.map((p) => [p.t, p.logicalBytes, p.physicalBytes]),
          };
    case "storage":
      return isUnavailable(series.storage)
        ? series.storage
        : { header: ["t", "bytes"], rows: series.storage.map((p) => [p.t, p.bytes]) };
    case "jobDurations":
      return isUnavailable(series.jobDurations)
        ? series.jobDurations
        : {
            header: ["kind", "p50Seconds", "p95Seconds", "count"],
            rows: series.jobDurations.map((d) => [d.kind, d.p50Seconds, d.p95Seconds, d.count]),
          };
    case "throttling":
      return isUnavailable(series.throttling)
        ? series.throttling
        : {
            header: ["t", "waitSeconds", "events"],
            rows: series.throttling.map((p) => [p.t, p.waitSeconds, p.events]),
          };
    case "restores":
      return isUnavailable(series.restores)
        ? series.restores
        : {
            header: ["t", "completed", "failed"],
            rows: series.restores.map((p) => [p.t, p.completed, p.failed]),
          };
    case "readiness":
      return isUnavailable(series.readiness)
        ? series.readiness
        : {
            header: ["t", "green", "yellow", "red", "unverified"],
            rows: series.readiness.map((p) => [p.t, p.green, p.yellow, p.red, p.unverified]),
          };
    case "failuresByCause":
      return isUnavailable(tables.failuresByCause)
        ? tables.failuresByCause
        : {
            header: ["cause", "count", "lastAt"],
            rows: tables.failuresByCause.map((f) => [f.cause, f.count, f.lastAt]),
          };
    case "largestObjects": {
      if (isUnavailable(tables.largestObjects)) {
        return tables.largestObjects;
      }
      const withTenant = stats.scope === "provider";
      return {
        header: [
          "id",
          "name",
          "kind",
          "logicalBytes",
          "lastBackupAt",
          "state",
          ...(withTenant ? ["tenantId", "tenantName"] : []),
        ],
        rows: tables.largestObjects.map((o) => [
          o.id,
          o.name,
          o.kind,
          o.logicalBytes,
          o.lastBackupAt,
          o.state,
          ...(withTenant ? [o.tenant?.id, o.tenant?.name] : []),
        ]),
      };
    }
    case "tenants": {
      const tenants = tables.tenants;
      if (!tenants) {
        return null;
      }
      return isUnavailable(tenants)
        ? tenants
        : {
            header: [
              "id",
              "name",
              "objects",
              "successRate",
              "logicalBytes",
              "physicalBytes",
              "readiness",
              "failures",
            ],
            rows: tenants.map((row) => [
              row.id,
              row.name,
              row.objects,
              row.successRate,
              row.logicalBytes,
              row.physicalBytes,
              row.readiness,
              row.failures,
            ]),
          };
    }
  }
}
