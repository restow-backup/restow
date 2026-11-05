import {
  aggregateReadiness,
  JOB_STATUS_META,
  type JobStatusKey,
  jobStatusTone,
  type StatusTone,
  toneOf,
} from "@/components/kit";

import type {
  BackupDay,
  BackupTrendWidget,
  EndpointsWidget,
  Readiness,
  RecentJob,
  StorageGrowthWidget,
  VerificationHistoryWidget,
  WidgetId,
  WidgetResult,
} from "./api.js";

/**
 * Pure presentation rules of the dashboard: how a widget's result maps to a
 * view state, success rates and their change, the tone of every status, and
 * the chart rows. Kept free of React so the rules are tested directly. Where
 * each widget sits is the registry's business (widget-registry.tsx).
 */

// ---------------------------------------------------------------------------
// Widgets and their states
// ---------------------------------------------------------------------------

/** Widgets only tenant admins and provider admins get (mirrors the server's audience). */
export const ADMIN_WIDGETS: ReadonlySet<WidgetId> = new Set([
  "running",
  "mailboxUsage",
  "endpoints",
  "recentJobs",
]);

export type WidgetView<T> =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; data: T };

/** The server reported the widget as failed; the cause is in the server log. */
export class WidgetUnavailableError extends Error {
  constructor() {
    super("The server could not load this part of the overview.");
    this.name = "WidgetUnavailableError";
  }
}

/** How one widget renders: still loading, failed (on the server), or with its data. */
export function widgetView<T>(
  result: WidgetResult<T> | undefined,
  loading: boolean,
): WidgetView<T> {
  if (!result) {
    return loading ? { kind: "loading" } : { kind: "error", error: new WidgetUnavailableError() };
  }
  return result.state === "ok"
    ? { kind: "ready", data: result.data }
    : { kind: "error", error: new WidgetUnavailableError() };
}

/**
 * The most columns of a row of tiles: as many as there are tiles, at most four, so the row has
 * no empty cell on a wide page (kit/card-flow.tsx, layout `tiles`).
 */
export function tileColumns(count: number): 2 | 3 | 4 {
  if (count >= 4) {
    return 4;
  }
  return count === 3 ? 3 : 2;
}

/**
 * Whether a chart has anything to draw: while loading and on an error it has (a skeleton, the
 * failure with a retry); once its data is there, only when the data holds a value. A chart with
 * nothing to draw is left out of the page (no empty card), and the cards around it close up.
 */
function charted<T>(view: WidgetView<T>, hasData: (data: T) => boolean): boolean {
  return view.kind !== "ready" || hasData(view.data);
}

/**
 * Backup runs: any run in the whole series the server sent, not only in the window chosen, so a
 * window without runs keeps its card and the toggle that leads back to the wider one.
 */
export function chartsBackupRuns(view: WidgetView<BackupTrendWidget>): boolean {
  return charted(view, (data) =>
    data.series.some((day) => day.succeeded + day.withItemFailures + day.failed > 0),
  );
}

/** Restore checks: any check in the series. */
export function chartsRestoreChecks(view: WidgetView<VerificationHistoryWidget>): boolean {
  return charted(view, (data) => data.series.some((day) => day.green + day.yellow + day.red > 0));
}

/** Storage growth: any stored bytes in the series. */
export function chartsStorageGrowth(view: WidgetView<StorageGrowthWidget>): boolean {
  return charted(view, (data) => data.series.some((point) => point.bytes > 0));
}

// ---------------------------------------------------------------------------
// Backup success
// ---------------------------------------------------------------------------

export interface SuccessRate {
  runs: number;
  succeeded: number;
  /** Share of runs that succeeded completely; null without runs. */
  rate: number | null;
}

/** The last `days` entries of a series (oldest first). */
export function lastDays<T>(series: readonly T[], days: number): T[] {
  return series.slice(Math.max(0, series.length - days));
}

/** The `days` entries before the last `days`. */
export function previousDays<T>(series: readonly T[], days: number): T[] {
  const end = Math.max(0, series.length - days);
  return series.slice(Math.max(0, end - days), end);
}

/** Runs that left failed items are not successes. */
export function successRate(days: readonly BackupDay[]): SuccessRate {
  let runs = 0;
  let succeeded = 0;
  for (const day of days) {
    runs += day.succeeded + day.withItemFailures + day.failed;
    succeeded += day.succeeded;
  }
  return { runs, succeeded, rate: runs === 0 ? null : succeeded / runs };
}

/**
 * Change of the success rate against the period before, in percentage
 * points; null when either period had no runs (there is nothing to compare).
 */
export function successRateDelta(current: SuccessRate, previous: SuccessRate): number | null {
  if (current.rate === null || previous.rate === null) {
    return null;
  }
  return Math.round((current.rate - previous.rate) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------

/** The legend rows and bar segments of a readiness breakdown (the counts' field names). */
export type ReadinessSegmentKey = "green" | "yellow" | "red" | "unverified" | "noBackup" | "empty";

export type { JobStatusKey };

/**
 * A job's status for the badge. A run that completed with failed items is
 * never shown as a plain success, and a wait imposed by Microsoft is shown.
 * A run that completed is neutral, not green: green means proof (brand guide,
 * section 4) and a backup that merely completed has not been read back; only a
 * restore that completed is a success.
 */
export function jobStatusView(job: RecentJob): {
  key: JobStatusKey;
  tone: StatusTone;
  live: boolean;
} {
  const view = (key: JobStatusKey) => {
    const meta = JOB_STATUS_META[key];
    return { key, tone: toneOf(meta), live: meta.live === true };
  };
  switch (job.status) {
    case "queued":
      return view("queued");
    case "active":
      return view(job.throttledUntil ? "throttled" : "active");
    case "completed":
      if ((job.progress?.failed ?? 0) > 0) {
        return view("completedWithFailures");
      }
      // A restore that completed brought the data back: the only completed job that is green.
      return { ...view("completed"), tone: jobStatusTone("completed", job.queue) };
    case "failed":
      // A backup a service held back is no failure: amber, the next scheduled run tries again.
      if (job.serviceLimited) {
        return view("limited");
      }
      // A disabled or unlicensed account: not backed up, neutral, no failure.
      return job.notBackedUp ? view(`notBackedUp_${job.notBackedUp}`) : view("failed");
    case "cancelled":
      return view("cancelled");
  }
}

/**
 * Without a bound from the schedules, no successful backup for this long reads as overdue. The
 * server sends the bound of each kind (`staleAfterHours`: twice the longest planned gap of the
 * tenant's jobs), and the provider view judges each tenant by its own.
 */
export const STALE_BACKUP_HOURS = 48;

export function isStale(iso: string | null, now: number, hours = STALE_BACKUP_HOURS): boolean {
  return iso !== null && now - Date.parse(iso) > hours * 3_600_000;
}

/** A bound in hours as the page words it: whole days from two days on. */
export function staleBound(hours: number): { unit: "hours" | "days"; count: number } {
  return hours >= 48
    ? { unit: "days", count: Math.round(hours / 24) }
    : { unit: "hours", count: hours };
}

// ---------------------------------------------------------------------------
// Servers and clients
// ---------------------------------------------------------------------------

/**
 * Whether the servers and clients card is on the page. The server answers
 * with zeros for a tenant without endpoints (a tenant whose machines are all in
 * no backup job still gets the card: it says they are not protected), and then the page shows nothing
 * rather than an empty card; while the answer is not in yet there is no way to
 * know, so nothing is shown (a skeleton would flash for most tenants). A
 * failed source does show its card, with the retry: the tenant may well have
 * machines.
 */
export function showEndpoints(view: WidgetView<EndpointsWidget>): boolean {
  switch (view.kind) {
    case "loading":
      return false;
    case "error":
      return true;
    case "ready":
      return view.data.machines > 0;
  }
}

/**
 * The machines' overall standing, by the rule of the readiness card (aggregateReadiness, UI
 * rework decision 1): red (Not restorable) when a machine's newest backup cannot be restored or
 * it has no backup yet, yellow (Not proven) when one needs attention or is unverified, otherwise
 * green. A failed last backup, a silent server and a machine in no backup job are findings of
 * their own (decision 2): they no longer turn the badge yellow. Null without machines, and
 * while no protected machine is rated.
 */
export function endpointsOverall(widget: EndpointsWidget): Readiness | null {
  if (widget.machines === 0) {
    return null;
  }
  const { green, yellow, red, unverified, noBackup } = widget.readiness;
  return aggregateReadiness(widget.readiness, green + yellow + red + unverified + noBackup);
}

export type EndpointFindingKey =
  | "notRestorable"
  | "unverified"
  | "failedLastBackup"
  | "withoutJob"
  | "attention";

export interface EndpointFinding {
  key: EndpointFindingKey;
  count: number;
  tone: StatusTone;
}

/**
 * What the admin has to look at, worst first; a finding with no machine is
 * left out. Not restorable (a failed restore test or no backup yet) and a
 * failed last backup are failures, a backup no restore test has read back is
 * not proven (warning), and the rest (a machine in no job, a silent server, a
 * client without a recent backup) asks for a look (attention).
 */
export function endpointFindings(widget: EndpointsWidget): EndpointFinding[] {
  const findings: EndpointFinding[] = [
    {
      key: "notRestorable",
      count: widget.readiness.red + widget.readiness.noBackup,
      tone: "destructive",
    },
    { key: "failedLastBackup", count: widget.failedLastBackup, tone: "destructive" },
    { key: "unverified", count: widget.readiness.unverified, tone: "warning" },
    // Nothing backs these up: not protected, whatever an old backup of them scores.
    { key: "withoutJob", count: widget.withoutJob, tone: "attention" },
    // The other reasons to look at a machine; one in no job is already counted above.
    { key: "attention", count: widget.otherAttention, tone: "attention" },
  ];
  return findings.filter((finding) => finding.count > 0);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Share of the logical bytes deduplication saved (0..1). */
export function dedupSaving(logicalBytes: number, physicalBytes: number): number {
  if (logicalBytes <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, 1 - physicalBytes / logicalBytes));
}

export interface StorageChartRow {
  date: string;
  /** Measured bytes; absent on forecast days. */
  stored?: number;
  /** Projected bytes (the line); present on the last measured day too, so the two join. */
  forecast?: number;
  /** The estimate's range, slowest to fastest growth; from the last measured day on, when there is one. */
  band?: [number, number];
}

/**
 * Measured buckets followed by the estimate, as one row list for one chart.
 * With a band the estimate is the band alone, never a line through it: a
 * straight line over months reads more exact than it is.
 */
export function storageChartRows(widget: StorageGrowthWidget): StorageChartRow[] {
  const rows: StorageChartRow[] = widget.series.map((point) => ({
    date: point.date,
    stored: point.bytes,
  }));
  const last = rows.at(-1);
  if (!widget.forecast || !last || last.stored === undefined) {
    return rows;
  }
  const band = widget.forecast.band;
  if (band) {
    last.band = [last.stored, last.stored];
    return [
      ...rows,
      ...band.points.map((point) => ({
        date: point.date,
        band: [point.low, point.high] as [number, number],
      })),
    ];
  }
  last.forecast = last.stored;
  return [
    ...rows,
    ...widget.forecast.points.map((point) => ({ date: point.date, forecast: point.bytes })),
  ];
}

/** The largest byte value a storage chart plots, for its axis. */
export function storageChartMax(rows: readonly StorageChartRow[]): number {
  return Math.max(
    0,
    ...rows.map((row) => Math.max(row.stored ?? 0, row.forecast ?? 0, row.band?.[1] ?? 0)),
  );
}

/** How far ahead the estimate reaches, in days (an older server sends no horizon: its points are days). */
export function storageHorizonDays(widget: StorageGrowthWidget): number {
  return widget.forecast?.horizonDays ?? widget.forecast?.points.length ?? 0;
}

const BYTE_STEPS = [1, 2, 2.5, 5, 10] as const;

/**
 * Axis ticks for a byte scale that read as round numbers in the unit the
 * labels use (binary: KB, MB, GB, ... as formatBytes prints them), from 0 to
 * at least `max`, about `count` steps.
 */
export function byteTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) {
    return [0];
  }
  let unit = 1;
  while (max / unit >= 1024) {
    unit *= 1024;
  }
  const raw = max / unit / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const factor = BYTE_STEPS.find((candidate) => candidate * magnitude >= raw) ?? 10;
  const step = factor * magnitude * unit;
  const steps = Math.ceil(max / step - 1e-9);
  return Array.from({ length: steps + 1 }, (_, index) => index * step);
}

/** A `YYYY-MM-DD` day as a short localised date ("23 Sep"), read as a UTC day. */
export function dayLabel(
  date: string,
  language: string,
  style: "short" | "long" = "short",
): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return new Intl.DateTimeFormat(language, {
    timeZone: "UTC",
    day: "numeric",
    month: style === "short" ? "short" : "long",
    ...(style === "long" ? { year: "numeric" } : {}),
  }).format(parsed);
}

/** The month of a `YYYY-MM-DD` day with its year ("Sep 2026"), read as a UTC day: the axis of a year. */
export function monthLabel(date: string, language: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return new Intl.DateTimeFormat(language, {
    timeZone: "UTC",
    month: "short",
    year: "numeric",
  }).format(parsed);
}
