import type { ExportProgress, MailExport } from "@/features/exports/api";

/**
 * Pure helpers for showing exports honestly: live or finished, how far
 * along, whether the file can still be downloaded and for how long.
 */

export function isLive(item: Pick<MailExport, "status">): boolean {
  return item.status === "queued" || item.status === "active";
}

export function isCancellable(item: Pick<MailExport, "status">): boolean {
  return isLive(item);
}

export type StatusTone = "muted" | "default" | "outline" | "destructive" | "secondary" | "warning";

/** How many messages could not be exported, from the final report or the live counter. */
export function failedCount(item: {
  progress: ExportProgress | null;
  report?: { failed: number } | null;
}): number {
  return item.report?.failed ?? item.progress?.failed ?? 0;
}

/**
 * Badge tone per status; a completed export with failed messages is a warning,
 * not a success, and a clean one is the neutral outline: an export is a copy
 * out, not a restore check that passed (brand guide, section 4).
 */
export function statusTone(
  item: Pick<MailExport, "status" | "progress"> & { report?: { failed: number } | null },
): StatusTone {
  switch (item.status) {
    case "queued":
      return "muted";
    case "active":
      return "default";
    case "completed":
      return failedCount(item) > 0 ? "warning" : "outline";
    case "failed":
      return "destructive";
    case "cancelled":
      return "secondary";
    default:
      return "muted";
  }
}

/** i18n key (namespace `exports`) of a status, including "completed with issues". */
export function statusKey(
  item: Pick<MailExport, "status" | "progress"> & { report?: { failed: number } | null },
): string {
  if (item.status === "completed" && statusTone(item) === "warning") {
    return "status.completedWithIssues";
  }
  return `status.${item.status}`;
}

/** The phases the API reports while an export runs; anything else is not shown. */
export const KNOWN_PHASES = ["preparing", "collecting", "writing", "finishing"] as const;
export type KnownPhase = (typeof KNOWN_PHASES)[number];

/** i18n key of the running phase, or null for a phase this version does not know. */
export function phaseKey(phase: string | null): string | null {
  return phase !== null && (KNOWN_PHASES as readonly string[]).includes(phase)
    ? `phase.${phase}`
    : null;
}

// --- Expiry -------------------------------------------------------------------

/** How long a download link still works, as the units the page shows. */
export type Expiry =
  | { kind: "none" }
  | { kind: "expired" }
  | { kind: "days"; days: number; hours: number }
  | { kind: "hours"; hours: number; minutes: number }
  | { kind: "minutes"; minutes: number }
  | { kind: "soon" };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Time left until `expiresAt`, rounded down to the minute. A link with less
 * than a minute left reads "soon", never "0 minutes". `none` for an export
 * that has no expiry time.
 */
export function expiryOf(expiresAt: string | null | undefined, now: number): Expiry {
  if (!expiresAt) {
    return { kind: "none" };
  }
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) {
    return { kind: "none" };
  }
  const left = at - now;
  if (left <= 0) {
    return { kind: "expired" };
  }
  if (left < MINUTE_MS) {
    return { kind: "soon" };
  }
  if (left >= 2 * DAY_MS) {
    return {
      kind: "days",
      days: Math.floor(left / DAY_MS),
      hours: Math.floor((left % DAY_MS) / HOUR_MS),
    };
  }
  if (left >= HOUR_MS) {
    return {
      kind: "hours",
      hours: Math.floor(left / HOUR_MS),
      minutes: Math.floor((left % HOUR_MS) / MINUTE_MS),
    };
  }
  return { kind: "minutes", minutes: Math.floor(left / MINUTE_MS) };
}

/**
 * Where the file of an export stands:
 * - `pending`: not finished, nothing to download yet;
 * - `ready`: completed and the link still works;
 * - `expired`: completed, but the link ran out (or the file is gone);
 * - `none`: failed or cancelled, there never is a file.
 */
export type DownloadState = "pending" | "ready" | "expired" | "none";

export function downloadState(
  item: Pick<MailExport, "status" | "available" | "expiresAt">,
  now: number,
): DownloadState {
  if (isLive(item)) {
    return "pending";
  }
  if (item.status !== "completed") {
    return "none";
  }
  if (!item.available || expiryOf(item.expiresAt, now).kind === "expired") {
    return "expired";
  }
  return "ready";
}

/** True while a clock is worth running: the link is ready and has an expiry to count down. */
export function needsClock(item: Pick<MailExport, "status" | "available" | "expiresAt">): boolean {
  return item.status === "completed" && item.available && Boolean(item.expiresAt);
}

/**
 * The i18n key and values of the countdown text for an expiry that is still
 * in the future: a full sentence for the export page (`expiry.*`), or a short
 * "in 3 h 5 min" for a table cell (`expiryShort.*`).
 */
export function expiryMessage(
  expiry: Expiry,
  variant: "sentence" | "short" = "sentence",
): { key: string; values: Record<string, number> } | null {
  const scope = variant === "short" ? "expiryShort" : "expiry";
  switch (expiry.kind) {
    case "days":
      return { key: `${scope}.days`, values: { days: expiry.days, hours: expiry.hours } };
    case "hours":
      return { key: `${scope}.hours`, values: { hours: expiry.hours, minutes: expiry.minutes } };
    case "minutes":
      return { key: `${scope}.minutes`, values: { minutes: expiry.minutes } };
    case "soon":
      return { key: `${scope}.soon`, values: {} };
    default:
      return null;
  }
}

/** What a skipped counter is called in the i18n keys (`skipped.<kind>`). */
export const SKIPPED_KINDS = ["calendar", "contacts", "other"] as const;
export type SkippedKind = (typeof SKIPPED_KINDS)[number];

/** The skipped counters that are above zero, in display order. */
export function skippedEntries(
  skipped: { calendar: number; contacts: number; other: number } | null | undefined,
): { kind: SkippedKind; count: number }[] {
  if (!skipped) {
    return [];
  }
  return SKIPPED_KINDS.filter((kind) => skipped[kind] > 0).map((kind) => ({
    kind,
    count: skipped[kind],
  }));
}

/** Failures to list: the final report's items when there is a report, else the live failures. */
export function failureRows(detail: {
  report: { items: { ref: string; reason: string }[] } | null;
  failures: { itemRef: string; reason: string }[];
}): { ref: string; reason: string }[] {
  if (detail.report && detail.report.items.length > 0) {
    return detail.report.items;
  }
  return detail.failures.map((failure) => ({ ref: failure.itemRef, reason: failure.reason }));
}
