import { CalendarDays, CalendarX, ChevronLeft, ChevronRight, Repeat } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { CalendarOccurrence, CalendarView, TreeEntry } from "@/features/restore/api";
import {
  dayLabel,
  eventWhen,
  monthLabel,
  monthWindow,
  occurrencesByDay,
  occurrenceTime,
  seriesWindow,
  shiftMonth,
} from "@/features/restore/lib/calendar";
import { parentPathOf } from "@/features/restore/lib/paths";
import { useCalendarView } from "@/features/restore/use-restore-data";
import { cn } from "@/lib/utils";

/**
 * The calendar of a mailbox restore point in the explorer: a month, day by day, with every
 * series expanded into its occurrences (the API's calendar view), and the occurrences of one
 * series under its row in the list. A click opens the event (the series, for an occurrence of
 * one) in the details, from where it is restored like any other item.
 */

/** The entry an occurrence comes from, as the details panel and a restore take it. */
export function occurrenceEntry(occurrence: CalendarOccurrence): TreeEntry {
  return {
    id: occurrence.entryId,
    kind: "event",
    name: occurrence.entryName,
    path: occurrence.entryPath,
    parentPath: parentPathOf(occurrence.entryPath),
    size: occurrence.size,
    mtime: null,
    itemId: occurrence.itemId,
    deleted: false,
    implicit: false,
    mail: null,
    event: null,
    contentType: "application/json",
  };
}

/** What a view could not show: more occurrences than one view lists, series it could not open. */
function ViewNotes({ view }: { view: CalendarView | undefined }) {
  const { t } = useTranslation("restore");
  if (!view || (!view.truncated && view.unexpandedSeries === 0)) {
    return null;
  }
  return (
    <div className="space-y-1 px-4 py-2 text-xs text-muted-foreground" data-slot="calendar-notes">
      {view.truncated ? <p>{t("explorer.calendar.truncated")}</p> : null}
      {view.unexpandedSeries > 0 ? (
        <p>{t("explorer.calendar.unexpanded", { count: view.unexpandedSeries })}</p>
      ) : null}
    </div>
  );
}

function OccurrenceLabel({ occurrence }: { occurrence: CalendarOccurrence }) {
  const { t } = useTranslation("restore");
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span
        className={cn(
          "min-w-0 truncate",
          occurrence.isCancelled && "text-muted-foreground line-through",
        )}
      >
        {occurrence.subject ?? t("explorer.calendar.noSubject")}
      </span>
      {occurrence.kind !== "single" ? (
        <Repeat
          className="size-3.5 shrink-0 text-muted-foreground"
          role="img"
          aria-label={t(
            occurrence.kind === "exception"
              ? "explorer.calendar.changedOccurrence"
              : "explorer.calendar.occurrence",
          )}
        />
      ) : null}
    </span>
  );
}

export function CalendarMonth({
  snapshotId,
  path,
  month,
  activePath,
  onMonthChange,
  onOpen,
}: {
  snapshotId: string;
  path: string;
  /** `YYYY-MM`. */
  month: string;
  activePath: string | null;
  onMonthChange: (month: string) => void;
  onOpen: (entry: TreeEntry) => void;
}) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const view = useCalendarView(snapshotId, { path, ...monthWindow(month) });
  const days = view.data ? occurrencesByDay(view.data.occurrences, month) : [];

  return (
    <div className="flex min-h-0 flex-col" data-slot="calendar-month">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onMonthChange(shiftMonth(month, -1))}
          aria-label={t("explorer.calendar.previousMonth")}
        >
          <ChevronLeft />
        </Button>
        <h3 className="min-w-0 flex-1 text-center text-sm font-semibold" aria-live="polite">
          {monthLabel(month, language)}
        </h3>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onMonthChange(shiftMonth(month, 1))}
          aria-label={t("explorer.calendar.nextMonth")}
        >
          <ChevronRight />
        </Button>
      </div>
      {view.isPending ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 4 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : view.isError ? (
        <div className="p-4">
          <ErrorState
            title={t("explorer.calendar.loadError")}
            error={view.error}
            onRetry={() => void view.refetch()}
            retrying={view.isFetching}
          />
        </div>
      ) : days.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={CalendarX}
            title={t("explorer.calendar.emptyMonth")}
            description={t("explorer.calendar.emptyMonthDescription")}
            variant="plain"
          />
        </div>
      ) : (
        <ol className="divide-y divide-border" aria-busy={view.isFetching}>
          {days.map((day) => (
            <li key={day.key} className="px-3 py-2" data-slot="calendar-day">
              <h4 className="mb-1 text-xs font-semibold text-muted-foreground">
                {dayLabel(day.key, language)}
              </h4>
              <ul className="space-y-0.5">
                {day.occurrences.map((occurrence) => (
                  <li key={`${occurrence.entryId}-${occurrence.start}`}>
                    <button
                      type="button"
                      onClick={() => onOpen(occurrenceEntry(occurrence))}
                      aria-current={activePath === occurrence.entryPath ? "true" : undefined}
                      className={cn(
                        "grid w-full grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm",
                        "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        activePath === occurrence.entryPath && "bg-accent/70",
                      )}
                      data-slot="calendar-occurrence"
                    >
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {occurrence.isAllDay
                          ? t("explorer.calendar.allDay")
                          : occurrenceTime(occurrence, language)}
                      </span>
                      <span className="min-w-0 space-y-0.5">
                        <OccurrenceLabel occurrence={occurrence} />
                        {occurrence.location || occurrence.calendarName ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {[occurrence.location, occurrence.calendarName]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      <ViewNotes view={view.data} />
    </div>
  );
}

/** The occurrences of one series, under its row in the list. */
export function SeriesOccurrences({
  snapshotId,
  entry,
  onOpen,
}: {
  snapshotId: string;
  entry: TreeEntry;
  onOpen: (entry: TreeEntry) => void;
}) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const window = entry.event ? seriesWindow(entry.event) : null;
  const view = useCalendarView(
    snapshotId,
    window ? { path: parentPathOf(entry.path), entryId: entry.id, ...window } : null,
  );

  if (view.isPending) {
    return <Skeleton className="m-3 h-6 w-2/3" />;
  }
  if (view.isError) {
    return <p className="px-4 py-2 text-xs text-destructive">{t("explorer.calendar.loadError")}</p>;
  }
  const occurrences = view.data.occurrences;
  return (
    <div data-slot="series-occurrences">
      <p className="flex items-center gap-1.5 px-4 pt-2 text-xs text-muted-foreground">
        <CalendarDays className="size-3.5" aria-hidden="true" />
        {t("explorer.calendar.occurrences", { count: occurrences.length })}
      </p>
      {occurrences.length === 0 ? null : (
        <ul className="max-h-72 overflow-y-auto px-2 py-1">
          {occurrences.map((occurrence) => (
            <li key={occurrence.start}>
              <button
                type="button"
                onClick={() => onOpen(occurrenceEntry(occurrence))}
                className="grid w-full grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-2 rounded px-2 py-0.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="truncate tabular-nums">
                  {eventWhen(occurrence, language) ?? "–"}
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <OccurrenceLabel occurrence={occurrence} />
                  {occurrence.kind === "exception" ? (
                    <Badge variant="muted" className="shrink-0">
                      {t("explorer.calendar.changed")}
                    </Badge>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ViewNotes view={view.data} />
    </div>
  );
}
