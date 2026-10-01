/**
 * Number, size, duration and date formatting for reports, in the report's
 * language. Mirrors the web app's helpers (apps/web/src/lib/format.ts) so a
 * figure reads the same on screen and on paper. Dates are shown in UTC, the
 * time zone every statistics period is defined in.
 */

export type ReportLanguage = "de" | "en";

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte", "petabyte"] as const;

export function formatInteger(value: number, language: ReportLanguage): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value);
}

export function formatDecimal(value: number, language: ReportLanguage, digits = 1): string {
  return new Intl.NumberFormat(language, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Binary multiples with the short unit names, like the web app. */
export function formatBytes(bytes: number, language: ReportLanguage): string {
  let value = Number.isFinite(bytes) ? Math.abs(bytes) : 0;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const text = new Intl.NumberFormat(language, {
    style: "unit",
    unit: BYTE_UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: digits,
  }).format(value);
  return bytes < 0 ? `-${text}` : text;
}

/**
 * A 0..1 ratio as a percentage. A share below 1 never reads as "100 %"
 * (2499 of 2500 successful runs is "99.9 %", not "100 %"), like the web app's
 * `formatPercent`: rounding up would hide the failures.
 */
export function formatPercent(ratio: number, language: ReportLanguage, digits = 1): string {
  const fractionDigits = Math.max(0, Math.min(3, Math.trunc(digits)));
  const shown = ratio >= 0 && ratio < 1 ? Math.min(ratio, 1 - 10 ** -(fractionDigits + 2)) : ratio;
  return new Intl.NumberFormat(language, {
    style: "percent",
    maximumFractionDigits: fractionDigits,
  }).format(shown);
}

/** A duration: seconds below a minute, minutes below an hour, hours (and days) above. */
export function formatDuration(seconds: number, language: ReportLanguage): string {
  const abs = Math.abs(seconds);
  const [value, unit] =
    abs < 60
      ? [abs, "second"]
      : abs < 3600
        ? [abs / 60, "minute"]
        : abs < 172_800
          ? [abs / 3600, "hour"]
          : [abs / 86_400, "day"];
  const text = new Intl.NumberFormat(language, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(value);
  return seconds < 0 ? `-${text}` : text;
}

/** A calendar day (`YYYY-MM-DD` or an instant), e.g. "23 Sept 2026" / "23.09.2026". */
export function formatDay(value: string | Date, language: ReportLanguage): string {
  const date = typeof value === "string" ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : value;
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

/** A compact day for chart axes, e.g. "23 Sep" / "23.09.". */
export function formatShortDay(value: string, language: ReportLanguage): string {
  return new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: language === "de" ? "2-digit" : "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

/** A month for chart axes, e.g. "Sep 2026" / "Sep. 2026". */
export function formatMonth(value: string, language: ReportLanguage): string {
  return new Intl.DateTimeFormat(language, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

export function formatDateTime(value: string | Date, language: ReportLanguage): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

/** Prefix a formatted change with its sign; a negative value already carries one. */
export function signed(value: number, formatted: string): string {
  return value > 0 ? `+${formatted}` : formatted;
}
