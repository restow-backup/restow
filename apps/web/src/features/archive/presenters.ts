import type { StorageTargetList } from "@/features/storage/types";

import type { ArchiveSearchParams, ChainVerification } from "./api.js";

/** Rows of one page of search results. */
export const ARCHIVE_PAGE_SIZE = 50;

/** How long the search waits after the last keystroke before it runs (each search is audited). */
export const SEARCH_DEBOUNCE_MS = 400;

/** The filters of the archive search as the person entered them. */
export interface ArchiveFilters {
  q: string;
  from: string;
  /** `YYYY-MM-DD` from a date field, or "". */
  dateFrom: string;
  /** `YYYY-MM-DD` from a date field, or "". */
  dateTo: string;
  mailbox: string | null;
  hasAttachment: boolean;
}

export const NO_FILTERS: ArchiveFilters = {
  q: "",
  from: "",
  dateFrom: "",
  dateTo: "",
  mailbox: null,
  hasAttachment: false,
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` day at the start (or end) of that day in the viewer's time zone, as ISO; null when not a day. */
export function dayBoundary(day: string, end: boolean): string | null {
  const match = DAY.exec(day.trim());
  if (!match) {
    return null;
  }
  const [, year, month, date] = match;
  const value = end
    ? new Date(Number(year), Number(month) - 1, Number(date), 23, 59, 59, 999)
    : new Date(Number(year), Number(month) - 1, Number(date), 0, 0, 0, 0);
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

/** Whether the date range is the wrong way round (and so would find nothing). */
export function invertedRange(filters: Pick<ArchiveFilters, "dateFrom" | "dateTo">): boolean {
  const from = dayBoundary(filters.dateFrom, false);
  const to = dayBoundary(filters.dateTo, true);
  return from !== null && to !== null && from > to;
}

/** The search request of the filters and page; empty filters are left out. */
export function searchParamsOf(filters: ArchiveFilters, offset: number): ArchiveSearchParams {
  const q = filters.q.trim();
  const from = filters.from.trim();
  return {
    q: q || undefined,
    from: from || undefined,
    dateFrom: dayBoundary(filters.dateFrom, false) ?? undefined,
    dateTo: dayBoundary(filters.dateTo, true) ?? undefined,
    mailbox: filters.mailbox ?? undefined,
    hasAttachment: filters.hasAttachment ? true : undefined,
    limit: ARCHIVE_PAGE_SIZE,
    offset,
  };
}

/** Whether any filter narrows the search (an empty result then means "no match", not "empty archive"). */
export function isFiltered(filters: ArchiveFilters): boolean {
  return (
    filters.q.trim() !== "" ||
    filters.from.trim() !== "" ||
    filters.dateFrom !== "" ||
    filters.dateTo !== "" ||
    filters.mailbox !== null ||
    filters.hasAttachment
  );
}

/** The rows shown, 1-based, out of the total: "51–100 of 1,234". */
export function pageRange(
  offset: number,
  shown: number,
  total: number,
): { first: number; last: number; total: number } {
  if (shown === 0) {
    return { first: 0, last: 0, total };
  }
  return { first: offset + 1, last: offset + shown, total };
}

/**
 * How the archive's storage protects archived mail against change or
 * deletion (README, Known Issues): on a filesystem (local disk, NFS) only the
 * application does; on S3 with Object Lock 0.2.x locks the archive item
 * records but not the packs with the message content.
 */
export type ArchiveProtection =
  /** Local disk or NFS: only the application enforces immutability. */
  | "filesystem"
  /** S3 with Object Lock: records locked, message content not yet. */
  | "s3_locked"
  /** S3 without Object Lock (disabled or not supported). */
  | "s3_unlocked"
  /** S3, Object Lock not detected yet or not readable. */
  | "s3_unknown"
  /** No storage known (not configured, or the list could not be read). */
  | "unknown";

/** The protection of the storage the archive writes to: the tenant's primary, else the installation default. */
export function archiveProtectionOf(list: StorageTargetList | undefined): ArchiveProtection {
  if (!list) {
    return "unknown";
  }
  const primary = (list.items ?? []).find(
    (target) => target.role === "primary" && target.kind !== "installation_default",
  );
  const fallback = list.installationDefault?.inUse ? list.installationDefault.kind : null;
  const kind = primary?.kind ?? fallback;
  if (kind === "local") {
    return "filesystem";
  }
  if (kind !== "s3") {
    return "unknown";
  }
  switch (primary?.objectLock?.status) {
    case "enabled":
      return "s3_locked";
    case "disabled":
    case "unsupported":
      return "s3_unlocked";
    default:
      return "s3_unknown";
  }
}

/** The overall verdict of an archive check: passed, or which part failed first. */
export type ChainVerdict = "empty" | "ok" | "broken" | "anchor" | "content";

export function chainVerdictOf(result: ChainVerification): ChainVerdict {
  if (result.brokenAt) {
    return "broken";
  }
  if (result.anchors?.failed) {
    return "anchor";
  }
  if ((result.content?.failures.length ?? 0) > 0) {
    return "content";
  }
  return result.checked === 0 ? "empty" : "ok";
}
