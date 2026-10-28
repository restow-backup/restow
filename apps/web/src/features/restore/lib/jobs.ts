import type { EntryKind, RestoreItem, RestoreJob, RestoreProgress } from "@/features/restore/api";

/**
 * Pure helpers for showing restore jobs honestly: live or finished, how far
 * along, and which item outcomes need attention.
 */

export function isLive(job: Pick<RestoreJob, "status">): boolean {
  return job.status === "queued" || job.status === "active";
}

export function isCancellable(job: Pick<RestoreJob, "status">): boolean {
  return isLive(job);
}

export type StatusTone = "muted" | "default" | "success" | "destructive" | "secondary" | "warning";

/**
 * Badge tone per status. Engines record item errors per item, so a restore
 * that could write nothing still ends "completed": with failed items and
 * nothing restored it is shown as destructive, with failed or unconfirmed
 * items next to restored ones as a warning, and one that skipped everything
 * (nothing restored, nothing failed) as a warning too, never a green success.
 */
export function statusTone(job: Pick<RestoreJob, "status" | "result">): StatusTone {
  switch (job.status) {
    case "queued":
      return "muted";
    case "active":
      return "default";
    case "completed": {
      const outcome = completedOutcome(job.result);
      if (outcome === "clean") {
        return "success";
      }
      return outcome === "nothingRestored" ? "destructive" : "warning";
    }
    case "failed":
      return "destructive";
    case "cancelled":
      return "secondary";
    default:
      return "muted";
  }
}

type CompletedOutcome = "clean" | "issues" | "nothingRestored" | "allSkipped";

function completedOutcome(result: RestoreJob["result"]): CompletedOutcome {
  const restored = result?.restored ?? 0;
  const skipped = result?.skipped ?? 0;
  const failures = result?.failures ?? 0;
  if (restored === 0 && failures > 0) {
    return "nothingRestored";
  }
  if (failures > 0 || (result?.unverified ?? 0) > 0) {
    return "issues";
  }
  if (restored === 0 && skipped > 0) {
    return "allSkipped";
  }
  return "clean";
}

/**
 * i18n key (namespace `restore`) of a status, including "completed with
 * problems", "nothing restored" and "everything skipped".
 */
export function statusKey(job: Pick<RestoreJob, "status" | "result">): string {
  if (job.status === "completed") {
    switch (completedOutcome(job.result)) {
      case "nothingRestored":
        return "jobs.status.completedNothingRestored";
      case "allSkipped":
        return "jobs.status.completedAllSkipped";
      case "issues":
        return "jobs.status.completedWithIssues";
      default:
        break;
    }
  }
  return `jobs.status.${job.status}`;
}

/** Share of work done (0..1), or null while the total is still unknown. */
export function progressRatio(progress: RestoreProgress | null): number | null {
  if (!progress || progress.total <= 0) {
    return null;
  }
  return Math.min(1, (progress.done + progress.failed) / progress.total);
}

/** Whole minutes left, at least one; null when no estimate exists. */
export function etaMinutes(progress: RestoreProgress | null): number | null {
  if (!progress || progress.etaSeconds === null || progress.etaSeconds < 0) {
    return null;
  }
  return Math.max(1, Math.round(progress.etaSeconds / 60));
}

export type ItemFilter = "all" | "attention" | "failed" | "skipped" | "unverified" | "restored";

export function matchesFilter(item: RestoreItem, filter: ItemFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "attention":
      return item.status !== "restored" || item.code === "unverified";
    case "unverified":
      return item.status === "restored" && item.code === "unverified";
    case "restored":
      return item.status === "restored" && item.code !== "unverified";
    default:
      return item.status === filter;
  }
}

export function countByFilter(items: readonly RestoreItem[]): Record<ItemFilter, number> {
  const counts: Record<ItemFilter, number> = {
    all: 0,
    attention: 0,
    failed: 0,
    skipped: 0,
    unverified: 0,
    restored: 0,
  };
  for (const item of items) {
    for (const filter of Object.keys(counts) as ItemFilter[]) {
      if (matchesFilter(item, filter)) {
        counts[filter] += 1;
      }
    }
  }
  return counts;
}

/** The filter a finished job opens with: problems first when there are any. */
export function initialFilter(items: readonly RestoreItem[]): ItemFilter {
  return items.some((item) => matchesFilter(item, "attention")) ? "attention" : "all";
}

/** The explorer kind of an engine item type (`message`, `attachment`, `file-version`, ...). */
export function itemKind(type: string): EntryKind {
  switch (type) {
    case "mail":
    case "message":
      return "mail";
    case "event":
    case "contact":
    case "folder":
      return type;
    default:
      return "file";
  }
}
