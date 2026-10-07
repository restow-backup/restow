import type { StatusTone } from "@/components/kit";

import type {
  BackupDay,
  EndpointsWidget,
  Readiness,
  ReadinessWidget,
  RecentJob,
  StorageGrowthWidget,
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

/** Columns of a row of tiles: as many as there are tiles, at most four. */
export function tileColumns(count: number): string {
  if (count >= 4) {
    return "sm:grid-cols-2 xl:grid-cols-4";
  }
  if (count === 3) {
    return "sm:grid-cols-2 xl:grid-cols-3";
  }
  return count === 2 ? "sm:grid-cols-2" : "";
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

export const READINESS_TONE: Readonly<Record<Readiness, StatusTone>> = {
  green: "success",
  yellow: "warning",
  red: "destructive",
};

export function readinessTone(readiness: Readiness | null): StatusTone {
  return readiness ? READINESS_TONE[readiness] : "muted";
}

export type ReadinessSegmentKey = "green" | "yellow" | "red" | "unverified" | "noBackup";

export interface ReadinessSegment {
  key: ReadinessSegmentKey;
  count: number;
  tone: StatusTone;
}

/**
 * The objects by state, worst first. Unverified backups and objects without a
 * backup are never rated fine: they carry the warning and destructive tones.
 */
export function readinessSegments(
  widget: Pick<ReadinessWidget, "green" | "yellow" | "red" | "unverified" | "noBackup">,
): ReadinessSegment[] {
  const segments: ReadinessSegment[] = [
    { key: "red", count: widget.red, tone: "destructive" },
    { key: "noBackup", count: widget.noBackup, tone: "destructive" },
    { key: "unverified", count: widget.unverified, tone: "warning" },
    { key: "yellow", count: widget.yellow, tone: "warning" },
    { key: "green", count: widget.green, tone: "success" },
  ];
  return segments.filter((segment) => segment.count > 0);
}

/** Sort rank for readiness: the worst first, unknown last. */
export function readinessRank(readiness: Readiness | null): number {
  return readiness === "red" ? 0 : readiness === "yellow" ? 1 : readiness === "green" ? 2 : 3;
}

export type JobStatusKey =
  | "queued"
  | "active"
  | "throttled"
  | "completed"
  | "completedWithFailures"
  | "failed"
  | "cancelled";

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
  switch (job.status) {
    case "queued":
      return { key: "queued", tone: "muted", live: false };
    case "active":
      return job.throttledUntil
        ? { key: "throttled", tone: "warning", live: true }
        : { key: "active", tone: "info", live: true };
    case "completed":
      return (job.progress?.failed ?? 0) > 0
        ? { key: "completedWithFailures", tone: "warning", live: false }
        : { key: "completed", tone: job.queue === "restore" ? "success" : "neutral", live: false };
    case "failed":
      return { key: "failed", tone: "destructive", live: false };
    case "cancelled":
      return { key: "cancelled", tone: "muted", live: false };
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
 * The machines' overall standing, by the rules of the readiness card: red when
 * any machine is not proven restorable (a failed restore test, a backup no
 * restore test has read back, no backup yet), otherwise yellow when something
 * needs attention (a backup proven with gaps, a failed last backup, a silent
 * server, a client without a recent backup, a machine in no backup job),
 * otherwise green. Null without machines.
 */
export function endpointsOverall(widget: EndpointsWidget): Readiness | null {
  if (widget.machines === 0) {
    return null;
  }
  if (widget.notReady > 0) {
    return "red";
  }
  if (
    widget.readiness.yellow > 0 ||
    widget.failedLastBackup > 0 ||
    widget.needingAttention > 0 ||
    widget.withoutJob > 0
  ) {
    return "yellow";
  }
  return "green";
}

export type EndpointFindingKey = "notReady" | "failedLastBackup" | "withoutJob" | "attention";

export interface EndpointFinding {
  key: EndpointFindingKey;
  count: number;
  tone: StatusTone;
}

/**
 * What the admin has to look at, worst first; a finding with no machine is
 * left out. Not proven restorable and a failed last backup are failures, the
 * rest (a silent server, a client without a recent backup) asks for a look.
 */
export function endpointFindings(widget: EndpointsWidget): EndpointFinding[] {
  const findings: EndpointFinding[] = [
    { key: "notReady", count: widget.notReady, tone: "destructive" },
    { key: "failedLastBackup", count: widget.failedLastBackup, tone: "destructive" },
    // Nothing backs these up: not protected, whatever an old backup of them scores.
    { key: "withoutJob", count: widget.withoutJob, tone: "warning" },
    // The other reasons to look at a machine; one in no job is already counted above.
    { key: "attention", count: widget.otherAttention, tone: "warning" },
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
  /** Projected bytes; present on the last measured day too, so the two lines join. */
  forecast?: number;
}

/** Measured days followed by the forecast, as one row list for one chart. */
export function storageChartRows(widget: StorageGrowthWidget): StorageChartRow[] {
  const rows: StorageChartRow[] = widget.series.map((point) => ({
    date: point.date,
    stored: point.bytes,
  }));
  const last = rows.at(-1);
  if (!widget.forecast || !last) {
    return rows;
  }
  last.forecast = last.stored;
  return [
    ...rows,
    ...widget.forecast.points.map((point) => ({ date: point.date, forecast: point.bytes })),
  ];
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
