import { CalendarSearch } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { UI_NAMESPACE } from "./i18n.js";
import { useMinuteClock } from "./relative-time.js";
import {
  type TimelineDay,
  dayAtOrBefore,
  dayRelation,
  groupByLocalDay,
  localDayKey,
} from "./restore-timeline-model.js";

export interface RestoreTimelineProps<T> {
  /** The restore points, in any order; the timeline sorts them newest first. */
  items: readonly T[];
  idOf: (item: T) => string;
  /** The moment a restore point stands for (ISO); one without a time is left out. */
  timeOf: (item: T) => string | null | undefined;
  selectedId: string | null;
  onSelect: (item: T) => void;
  /** What a restore point shows below its time: ids, sizes, badges, flags. */
  renderDetails?: (item: T) => React.ReactNode;
  /** Accessible name of the whole timeline, e.g. "Restore points of web-01". */
  label: string;
  /** `data-slot` of the root, for pages and tests that look for it. */
  slot?: string;
  /** Classes of the scrolling part, e.g. its maximum height. */
  className?: string;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/**
 * Restore points on one vertical timeline, the same for machines and
 * mailboxes: newest first, grouped by the local day they were taken on under
 * a separator that stays at the top while its day scrolls by ("Today",
 * "Yesterday", else the weekday and date). Each restore point shows its time
 * (HH:mm) and whatever the page adds below it (badges, flags, sizes).
 *
 * Keyboard: the list is one Tab stop (the selected restore point, else the
 * newest); the arrow keys, Home and End move between restore points, Enter or
 * Space picks one. "Jump to date" opens a calendar with the days that have
 * restore points marked; picking a date scrolls to that day, or to the
 * nearest earlier one, moves focus there and says where it landed.
 */
export function RestoreTimeline<T>({
  items,
  idOf,
  timeOf,
  selectedId,
  onSelect,
  renderDetails,
  label,
  slot = "restore-timeline",
  className,
}: RestoreTimelineProps<T>) {
  const { t, i18n } = useTranslation(UI_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  // "Today" turns into "Yesterday" at midnight without a reload.
  useMinuteClock();
  const now = new Date();
  const baseId = React.useId();
  const scroller = React.useRef<HTMLElement>(null);
  const buttons = React.useRef(new Map<string, HTMLButtonElement>()).current;
  const [focused, setFocused] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState("");
  const [calendarOpen, setCalendarOpen] = React.useState(false);

  const days = React.useMemo(() => groupByLocalDay(items, timeOf), [items, timeOf]);
  const order = React.useMemo(
    () => days.flatMap((day) => day.items.map((item) => idOf(item))),
    [days, idOf],
  );
  const formats = React.useMemo(
    () => ({
      time: new Intl.DateTimeFormat(language, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
      day: new Intl.DateTimeFormat(language, { weekday: "long", day: "numeric", month: "long" }),
      dayWithYear: new Intl.DateTimeFormat(language, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    }),
    [language],
  );

  const tabStop =
    (focused !== null && order.includes(focused) ? focused : null) ??
    (selectedId !== null && order.includes(selectedId) ? selectedId : null) ??
    order[0] ??
    null;

  const dateLabel = (date: Date) =>
    (date.getFullYear() === now.getFullYear() ? formats.day : formats.dayWithYear).format(date);
  const dayTitle = (day: TimelineDay<T>) => {
    const relation = dayRelation(day.date, now);
    if (relation === "today") {
      return t("timeline.today");
    }
    return relation === "yesterday" ? t("timeline.yesterday") : dateLabel(day.date);
  };

  const focusEntry = (id: string | undefined) => {
    const button = id === undefined ? undefined : buttons.get(id);
    if (!button || id === undefined) {
      return;
    }
    setFocused(id);
    button.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const current = order.indexOf(tabStop ?? "");
    const target =
      event.key === "ArrowDown"
        ? order[Math.min(current + 1, order.length - 1)]
        : event.key === "ArrowUp"
          ? order[Math.max(current - 1, 0)]
          : event.key === "Home"
            ? order[0]
            : event.key === "End"
              ? order[order.length - 1]
              : undefined;
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    focusEntry(target);
  };

  const jumpTo = (date: Date | undefined) => {
    setCalendarOpen(false);
    if (!date) {
      return;
    }
    const day = dayAtOrBefore(days, date);
    if (!day) {
      return;
    }
    const section = document.getElementById(`${baseId}-day-${day.key}`);
    const list = scroller.current;
    if (section && list) {
      list.scrollTo?.({
        top: section.offsetTop,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    }
    const first = day.items[0];
    if (first !== undefined) {
      const id = idOf(first);
      setFocused(id);
      // After the popover has closed and handed focus back to its trigger.
      requestAnimationFrame(() => buttons.get(id)?.focus({ preventScroll: true }));
    }
    setAnnouncement(
      day.key === localDayKey(date)
        ? t("timeline.jumped", { day: dateLabel(day.date) })
        : t("timeline.jumpedEarlier", { date: dateLabel(date), day: dateLabel(day.date) }),
    );
  };

  const newest = days[0]?.date;
  const oldest = days[days.length - 1]?.date;

  return (
    <div className="flex min-h-0 flex-col" data-slot={slot}>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <span className="text-xs text-muted-foreground">
          {t("timeline.count", { count: order.length })}
        </span>
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" disabled={days.length === 0}>
              <CalendarSearch aria-hidden="true" />
              {t("timeline.jump")}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-0" data-slot="timeline-calendar">
            <p className="border-b px-4 py-3 text-xs text-muted-foreground">
              {t("timeline.jumpHint")}
            </p>
            <Calendar
              mode="single"
              selected={undefined}
              onSelect={jumpTo}
              defaultMonth={newest}
              startMonth={oldest}
              endMonth={newest}
              modifiers={{ hasRestorePoint: days.map((day) => day.date) }}
              modifiersClassNames={{
                hasRestorePoint: "[&>button]:font-semibold [&>button]:text-primary",
              }}
              autoFocus
            />
          </PopoverContent>
        </Popover>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {/* The arrow keys bubble up here from the restore point buttons inside. */}
      <section
        ref={scroller}
        aria-label={label}
        onKeyDown={onKeyDown}
        className={cn("relative max-h-80 overflow-y-auto lg:max-h-[34rem]", className)}
      >
        {days.map((day) => {
          const headingId = `${baseId}-heading-${day.key}`;
          const relation = dayRelation(day.date, now);
          return (
            <section
              key={day.key}
              id={`${baseId}-day-${day.key}`}
              aria-labelledby={headingId}
              data-day={day.key}
            >
              <h3
                id={headingId}
                className="sticky top-0 z-10 flex items-baseline justify-between gap-2 border-b bg-muted/95 px-4 py-1.5 text-xs font-medium backdrop-blur supports-[backdrop-filter]:bg-muted/80"
                data-slot="timeline-day"
              >
                <span>
                  {dayTitle(day)}
                  {relation === "other" ? null : (
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {dateLabel(day.date)}
                    </span>
                  )}
                </span>
                <span className="font-normal text-muted-foreground">
                  {t("timeline.count", { count: day.items.length })}
                </span>
              </h3>
              <ul className="divide-y">
                {day.items.map((item) => {
                  const id = idOf(item);
                  const selected = id === selectedId;
                  const time = timeOf(item);
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        ref={(node) => {
                          if (node) {
                            buttons.set(id, node);
                          } else {
                            buttons.delete(id);
                          }
                        }}
                        tabIndex={id === tabStop ? 0 : -1}
                        onFocus={() => setFocused(id)}
                        onClick={() => onSelect(item)}
                        aria-current={selected ? "true" : undefined}
                        data-selected={selected || undefined}
                        className={cn(
                          "flex w-full gap-3 border-l-2 border-transparent px-4 py-3 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
                          selected && "border-primary bg-accent",
                        )}
                      >
                        <time
                          dateTime={time ?? undefined}
                          className="shrink-0 font-medium tabular-nums"
                          data-slot="timeline-time"
                        >
                          {time ? formats.time.format(new Date(time)) : null}
                        </time>
                        {renderDetails ? (
                          <span className="flex min-w-0 flex-1 flex-col gap-1">
                            {renderDetails(item)}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </section>
    </div>
  );
}
