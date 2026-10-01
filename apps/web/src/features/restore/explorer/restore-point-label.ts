import * as React from "react";
import { useTranslation } from "react-i18next";

import { toDate } from "@/components/kit";
import type { Snapshot } from "@/features/restore/api";
import { formatDateTime } from "@/lib/format";

/** The moment a restore point stands for: when its backup finished, else when it was created. */
export function restorePointTime(
  restorePoint: Pick<Snapshot, "completedAt" | "createdAt">,
): string {
  return restorePoint.completedAt ?? restorePoint.createdAt;
}

/** "Restore point #12 · 23 Sep 2026, 14:30" — a restore point as one line. */
export function useSnapshotLabel(): (restorePoint: Snapshot) => string {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return React.useCallback(
    (restorePoint: Snapshot) =>
      t("explorer.restorePoint.item", {
        sequence: restorePoint.sequence,
        date: formatDateTime(restorePointTime(restorePoint), language) ?? "",
      }),
    [t, language],
  );
}

/**
 * The API lists restore points newest first; a timeline reads oldest to
 * newest, left to right. A plain reversal (not a re-sort) keeps "the latest"
 * the very same restore point the rest of the explorer means by it.
 */
export function chronological<T>(newestFirst: readonly T[]): T[] {
  return [...newestFirst].reverse();
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * The short label under each marker of the timeline, keyed by restore point
 * id. `points` must already be in timeline order (oldest first). The first
 * restore point of a day is labelled with its date ("23 Sep", plus the year
 * once it is not the current one); further restore points of the same day
 * with their time ("14:30"). That is the whole day separator: the date shows
 * up exactly where a new day starts, and never repeats.
 */
export function compactTimelineLabels(
  points: readonly Pick<Snapshot, "id" | "completedAt" | "createdAt">[],
  language: string,
  now: Date = new Date(),
): Map<string, string> {
  const day = new Intl.DateTimeFormat(language, { day: "numeric", month: "short" });
  const dayWithYear = new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const time = new Intl.DateTimeFormat(language, { timeStyle: "short" });

  const labels = new Map<string, string>();
  let previous: Date | null = null;
  for (const point of points) {
    const date = toDate(restorePointTime(point));
    if (!date) {
      labels.set(point.id, "");
      continue;
    }
    if (previous && sameLocalDay(previous, date)) {
      labels.set(point.id, time.format(date));
    } else {
      const format = date.getFullYear() === now.getFullYear() ? day : dayWithYear;
      labels.set(point.id, format.format(date));
    }
    previous = date;
  }
  return labels;
}
