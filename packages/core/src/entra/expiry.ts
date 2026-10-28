/**
 * When a Microsoft 365 app credential runs out, and which reminder is due
 * (docs/ENTRA-SETUP.md, "Expiry"). One set of stages for every place that
 * looks at it: the badge in the web, the central app's check in the API
 * (features/updates/secret-watch.ts) and the per-source check in the worker's
 * monitor pass (source-app-expiry.ts).
 *
 * The date is the secret's expiry an admin noted from the Entra portal, or a
 * certificate's `notAfter`; Graph cannot tell it without Application.Read.All,
 * which the product deliberately does not request (permissions.ts).
 *
 * Reminders go out once per stage and date: 30 days before (`soon30`), 7 days
 * before (`soon7`) and once it has run out (`expired`). A check that first
 * sees the date late raises only the stage it is in (no catch-up of the
 * earlier ones), and a new date (rotation, edit, new certificate) starts over.
 */

/** The stages a reminder is raised for, in order of urgency. */
export const SECRET_EXPIRY_STAGES = ["soon30", "soon7", "expired"] as const;

export type SecretExpiryAlertStage = (typeof SECRET_EXPIRY_STAGES)[number];

/** A stage, or `ok` while the end is further away than {@link SECRET_WARNING_DAYS}. */
export type SecretExpiryStage = "ok" | SecretExpiryAlertStage;

/** At most this many whole days left: the first reminder (and the badge turns amber). */
export const SECRET_WARNING_DAYS = 30;
/** At most this many whole days left: the second reminder (and the badge turns red). */
export const SECRET_URGENT_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/;

function endOf(expiresAt: string | null | undefined): number | null {
  if (typeof expiresAt !== "string" || expiresAt.length === 0) {
    return null;
  }
  const end = Date.parse(expiresAt);
  return Number.isNaN(end) ? null : end;
}

function nowMs(now: Date | number): number {
  return typeof now === "number" ? now : now.getTime();
}

/** Midnight UTC of the day `ms` falls on. */
function startOfUtcDay(ms: number): number {
  return ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);
}

/**
 * Calendar days from today (UTC) to the day of `end`: 1 on the day before a date noted as
 * 2026-12-01, 0 on that day. Counted from the start of the current day, so the number next to
 * the printed date matches it at any hour.
 */
function calendarDays(end: number, at: number): number {
  return Math.floor((end - startOfUtcDay(at)) / DAY_MS);
}

/**
 * Whole calendar days left until `expiresAt` (UTC, as the badge counts): 0 on its day,
 * negative once that day is past; null when the date is missing or unreadable.
 */
export function daysLeft(
  expiresAt: string | null | undefined,
  now: Date | number = Date.now(),
): number | null {
  const end = endOf(expiresAt);
  return end === null ? null : calendarDays(end, nowMs(now));
}

/**
 * The stage of a credential that ends at `expiresAt`: `expired` from that instant on, `soon7`
 * with at most {@link SECRET_URGENT_DAYS} calendar days left, `soon30` with at most
 * {@link SECRET_WARNING_DAYS}, else `ok`. Null when the date is unknown or unreadable (nothing
 * to warn about, the web shows "unknown").
 */
export function secretExpiryStage(
  expiresAt: string | null | undefined,
  now: Date | number = Date.now(),
): SecretExpiryStage | null {
  const end = endOf(expiresAt);
  if (end === null) {
    return null;
  }
  const at = nowMs(now);
  if (end <= at) {
    return "expired";
  }
  const days = calendarDays(end, at);
  if (days <= SECRET_URGENT_DAYS) {
    return "soon7";
  }
  return days <= SECRET_WARNING_DAYS ? "soon30" : "ok";
}

/** Order of urgency: `ok` 0, `soon30` 1, `soon7` 2, `expired` 3; anything else (or none) 0. */
export function stageRank(stage: string | null | undefined): number {
  const index = (SECRET_EXPIRY_STAGES as readonly string[]).indexOf(stage ?? "");
  return index + 1;
}

export function isSecretExpiryAlertStage(value: unknown): value is SecretExpiryAlertStage {
  return typeof value === "string" && (SECRET_EXPIRY_STAGES as readonly string[]).includes(value);
}

/** The reminder already sent for one credential: for which date, which stage, when. */
export interface SecretExpiryAlertMark {
  expiresAt: string;
  stage: SecretExpiryAlertStage;
  /** ISO 8601. */
  at: string;
}

/**
 * The stage to raise now, or null when nothing is due: the current stage is a reminder stage
 * and ranks above the one already sent for the same date. A mark for another date counts as
 * none, so a new date starts over. The caller stores `{ expiresAt, stage, at }` after raising.
 */
export function secretExpiryAlertDue(
  expiresAt: string | null | undefined,
  mark: { expiresAt?: unknown; stage?: unknown } | null | undefined,
  now: Date | number = Date.now(),
): SecretExpiryAlertStage | null {
  const stage = secretExpiryStage(expiresAt, now);
  if (stage === null || stage === "ok") {
    return null;
  }
  const sent = mark && sameInstant(mark.expiresAt, expiresAt) ? stageRank(String(mark.stage)) : 0;
  return stageRank(stage) > sent ? stage : null;
}

/** Two dates name the same instant (`2027-03-01` and `2027-03-01T00:00:00.000Z` do). */
function sameInstant(a: unknown, b: string | null | undefined): boolean {
  if (typeof a !== "string") {
    return false;
  }
  const left = endOf(a);
  return left !== null && left === endOf(b);
}

/**
 * A calendar date (`2027-03-01`, a time after it ignored) as midnight UTC in ISO 8601; null
 * when it is no valid date. The form of every stored expiry date (the API's forms, the
 * optional ENTRA_CLIENT_SECRET_EXPIRES_AT).
 */
export function parseExpiryDate(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  if (!DATE.test(text)) {
    return null;
  }
  const day = text.slice(0, 10);
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day
    ? null
    : date.toISOString();
}
