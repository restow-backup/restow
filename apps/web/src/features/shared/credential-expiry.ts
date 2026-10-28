/**
 * When a Microsoft 365 app credential (the central app of Settings → Microsoft 365, or a
 * source's own app) runs out, as the badge and the warnings read it. Mirrors the stages of
 * packages/core/src/entra/expiry.ts, which the API's SecretWatch and the worker's
 * source-app-expiry pass alert on: amber from {@link SECRET_WARNING_DAYS} whole days left (the
 * first reminder), red from {@link SECRET_URGENT_DAYS} (the second), red once expired (the
 * third). Kept here because the browser bundle does not depend on @restow/core; both copies
 * are held to the same boundaries in their tests (docs/ENTRA-SETUP.md, "Expiry").
 */

/** At most this many whole days left: the first reminder, the badge turns amber. */
export const SECRET_WARNING_DAYS = 30;
/** At most this many whole days left: the second reminder, the badge turns red. */
export const SECRET_URGENT_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ExpiryState =
  | { kind: "unknown" }
  | { kind: "expired" }
  /** `urgent`: at most {@link SECRET_URGENT_DAYS} whole days left. */
  | { kind: "soon"; days: number; urgent: boolean }
  | { kind: "valid"; date: string };

/**
 * How the credential's end of validity reads right now. Days are calendar days (UTC) from the
 * start of today, as core counts them: 1 on the day before a date noted as 2026-12-01, 0 on it.
 */
export function expiryState(
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): ExpiryState {
  if (!expiresAt) {
    return { kind: "unknown" };
  }
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) {
    return { kind: "unknown" };
  }
  if (end <= now) {
    return { kind: "expired" };
  }
  const today = now - (((now % DAY_MS) + DAY_MS) % DAY_MS);
  const days = Math.floor((end - today) / DAY_MS);
  return days <= SECRET_WARNING_DAYS
    ? { kind: "soon", days, urgent: days <= SECRET_URGENT_DAYS }
    : { kind: "valid", date: expiresAt };
}

/** The state asks for action: expired, or within the reminder window. */
export function expiryNeedsAction(state: ExpiryState): boolean {
  return state.kind === "expired" || state.kind === "soon";
}

/**
 * A calendar date as `<input type="date">` gives it (`2027-03-01`), checked the way the API's
 * expiryDateField does (apps/api/src/lib/expiry-date.ts): a real day, not 2027-02-30.
 */
export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** A stored expiry (midnight UTC, ISO 8601) as the value of a date input; empty when none. */
export function dateInputValue(expiresAt: string | null | undefined): string {
  return expiresAt && DATE.test(expiresAt.slice(0, 10)) ? expiresAt.slice(0, 10) : "";
}

/** A calendar date in the UI language (expiry dates are whole days in UTC). */
export function formatDay(iso: string, language: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(date);
}
