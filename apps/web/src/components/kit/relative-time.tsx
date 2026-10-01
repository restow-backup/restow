import { formatDistanceStrict, isValid, parseISO } from "date-fns";
import { de, enUS } from "date-fns/locale";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import { HintTooltip } from "./hint-tooltip.js";
import { UI_NAMESPACE } from "./i18n.js";

const MINUTE_MS = 60_000;
/** Closer than this to now reads "just now" instead of "30 seconds ago". */
const JUST_NOW_MS = 45_000;

/*
 * One shared minute clock for every RelativeTime on the page: a single timer
 * fires just after each full minute while at least one is mounted. The
 * snapshot is the minute number, which is stable within a minute (as
 * useSyncExternalStore requires) and always current, even after the timer
 * was stopped for a while.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleTick(): void {
  timer = setTimeout(
    () => {
      timer = null;
      for (const listener of listeners) {
        listener();
      }
      // Listeners may (un)subscribe during the tick; keep exactly one timer while any remain.
      if (listeners.size > 0 && timer === null) {
        scheduleTick();
      }
    },
    MINUTE_MS - (Date.now() % MINUTE_MS) + 50,
  );
}

/** Call `listener` just after every full minute; returns the unsubscribe function. */
export function subscribeMinuteClock(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    scheduleTick();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

function currentMinute(): number {
  return Math.floor(Date.now() / MINUTE_MS);
}

/** Re-renders the caller once a minute; returns the current minute number. */
export function useMinuteClock(): number {
  return React.useSyncExternalStore(subscribeMinuteClock, currentMinute, currentMinute);
}

/** A Date from an ISO string or Date; `null` when missing or invalid. */
export function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = value instanceof Date ? value : parseISO(value);
  return isValid(date) ? date : null;
}

function dateLocale(language: string) {
  return language.startsWith("de") ? de : enUS;
}

/**
 * "3 hours ago" / "vor 3 Stunden" (or "in 2 days" for future times);
 * `null` within 45 seconds of `now`, which the caller shows as "just now".
 */
export function relativeLabel(date: Date, now: number, language: string): string | null {
  if (Math.abs(now - date.getTime()) < JUST_NOW_MS) {
    return null;
  }
  return formatDistanceStrict(date, now, { addSuffix: true, locale: dateLocale(language) });
}

/** Absolute date and time with seconds, in the UI language. */
export function absoluteLabel(date: Date, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "medium" }).format(
    date,
  );
}

export interface RelativeTimeProps {
  /** ISO timestamp from the API, or a Date. */
  value: string | Date | null | undefined;
  /** Shown when there is no timestamp; defaults to "Never". */
  fallback?: string;
  /**
   * Whether the time is a tab stop, so keyboard users can open the tooltip
   * (default true). Dense tables whose rows are interactive can pass false
   * to spare one tab stop per row: the tooltip then opens on hover, and the
   * absolute time is part of the text read by screen readers.
   */
  focusable?: boolean;
  className?: string;
}

/**
 * A relative time ("3 hours ago") in a `<time dateTime>` element with the
 * absolute, localised date and time in a tooltip. It refreshes every minute.
 * A missing timestamp reads "Never"; an unparseable one reads "Unknown".
 */
export function RelativeTime({ value, fallback, focusable = true, className }: RelativeTimeProps) {
  const { t, i18n } = useTranslation(UI_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  useMinuteClock();

  if (value === null || value === undefined || value === "") {
    return (
      <span className={cn("text-muted-foreground", className)}>{fallback ?? t("time.never")}</span>
    );
  }
  const date = toDate(value);
  if (!date) {
    return <span className={cn("text-muted-foreground", className)}>{t("time.unknown")}</span>;
  }

  const absolute = absoluteLabel(date, language);
  return (
    <HintTooltip content={absolute}>
      <time
        dateTime={date.toISOString()}
        // A tab stop by default, so keyboard users reach the absolute time.
        tabIndex={focusable ? 0 : undefined}
        className={cn(
          "cursor-default whitespace-nowrap rounded-sm underline decoration-muted-foreground/40 decoration-dotted underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          className,
        )}
      >
        {relativeLabel(date, Date.now(), language) ?? t("time.justNow")}
        {focusable ? null : <span className="sr-only"> ({absolute})</span>}
      </time>
    </HintTooltip>
  );
}
