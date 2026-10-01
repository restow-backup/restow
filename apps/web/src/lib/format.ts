import { formatDistanceToNowStrict, isValid, parseISO } from "date-fns";
import { de, enUS } from "date-fns/locale";

/**
 * Locale-aware formatting helpers. They take the i18n language code so the
 * output follows the UI language, not the browser default.
 */

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte", "petabyte"] as const;

export function formatBytes(bytes: number, language: string): string {
  const safe = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  let value = safe;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: BYTE_UNITS[unitIndex],
    unitDisplay: "short",
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * A share (0..1) as a percentage with at most `fractionDigits` decimals.
 *
 * A share below 1 never reads as "100 %". Ordinary rounding would show 199 of
 * 200 successful runs as "100 %" and hide the failed one, so such a value
 * shows the largest step below 100 at this precision instead ("99 %",
 * "99.9 %"). Only a complete share reads as "100 %".
 */
export function formatPercent(ratio: number, language: string, fractionDigits = 0): string {
  const safe = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const digits = Math.max(0, Math.min(3, Math.trunc(fractionDigits)));
  const shown = safe < 1 ? Math.min(safe, 1 - 10 ** -(digits + 2)) : safe;
  return new Intl.NumberFormat(language, {
    style: "percent",
    maximumFractionDigits: digits,
  }).format(shown);
}

export function formatInteger(value: number, language: string): string {
  return new Intl.NumberFormat(language).format(Number.isFinite(value) ? value : 0);
}

function dateLocale(language: string) {
  return language.startsWith("de") ? de : enUS;
}

/** Parse an ISO timestamp from the API; `null` for missing or invalid input. */
export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : null;
}

/** "vor 3 Stunden" / "3 hours ago"; `null` when the timestamp is unusable. */
export function formatRelative(value: string | null | undefined, language: string): string | null {
  const date = parseTimestamp(value);
  if (!date) {
    return null;
  }
  return formatDistanceToNowStrict(date, { addSuffix: true, locale: dateLocale(language) });
}

/** Absolute date and time in the UI language, for tooltips and tables. */
export function formatDateTime(value: string | null | undefined, language: string): string | null {
  const date = parseTimestamp(value);
  if (!date) {
    return null;
  }
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

/** Share of logical data that deduplication did not have to store. */
export function dedupSavings(logicalBytes: number, physicalBytes: number): number {
  if (!(logicalBytes > 0) || !(physicalBytes >= 0)) {
    return 0;
  }
  return Math.max(0, 1 - physicalBytes / logicalBytes);
}

/** Initials for an avatar fallback: "Lucas Flores" -> "LF", "root" -> "R". */
export function initialsOf(name: string | null | undefined, fallback = "?"): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return fallback;
  }
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}
