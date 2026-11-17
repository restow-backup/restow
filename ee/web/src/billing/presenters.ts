import type { BillingPeriod, BillingPeriodLine } from "./api";

/** The month `YYYY-MM` as the UI language names it, e.g. "Oktober 2026". */
export function formatPeriod(period: string, language: string): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) {
    return period;
  }
  return new Intl.DateTimeFormat(language, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** A day `YYYY-MM-DD` (a calendar date of the installation's zone) in the UI language. */
export function formatDay(day: string, language: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) {
    return day;
  }
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, date)),
  );
}

/** An amount in the month's currency. */
export function formatMoney(value: number, currency: string, language: string): string {
  return new Intl.NumberFormat(language, {
    style: "currency",
    currency,
    maximumFractionDigits: value !== 0 && Math.abs(value) < 0.1 ? 4 : 2,
  }).format(value);
}

/** A quantity: whole numbers from a hundred up, else up to two decimals. */
export function formatQuantity(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: value >= 100 ? 0 : 2 }).format(
    value,
  );
}

/** Whether some days of the month have no sample (the server was off, or the month began late). */
export function hasGaps(period: Pick<BillingPeriod, "days" | "sampledDays">): boolean {
  return period.sampledDays < period.days;
}

/** The i18n key of a line's name. */
export function lineKey(type: BillingPeriodLine["type"]): string {
  return `lines.${type}`;
}

/** The i18n key of a unit. */
export function unitKey(unit: BillingPeriodLine["unit"]): string {
  return unit === "GB" || unit === "TB" ? "units.bytes" : `units.${unit}`;
}

/** A correction amount as typed (comma or point); null when it is no number or zero. */
export function parseAmount(text: string): number | null {
  const normalised = text.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^[-+]?\d+(\.\d{1,4})?$/.test(normalised)) {
    return null;
  }
  const value = Number(normalised);
  return Number.isFinite(value) && value !== 0 ? value : null;
}
