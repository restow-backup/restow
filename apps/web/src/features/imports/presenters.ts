import { ApiError, errorMessageKey } from "@/lib/api";
import type {
  ImportDetail,
  ImportReport,
  ImportReportItem,
  ImportStatus,
  ImportSummary,
  MailFileFormat,
  ObjectListEntry,
} from "./types";

/**
 * Pure view logic of the import pages: status tones, progress, the item
 * filter, imported mailboxes for the target step and how API problems map to
 * messages. Everything returns i18n keys or plain data, never text.
 */

// --- Status ---------------------------------------------------------------------------

export type StatusTone = "muted" | "default" | "neutral" | "warning" | "destructive" | "secondary";

export function isLive(job: Pick<ImportSummary, "status">): boolean {
  return job.status === "queued" || job.status === "active";
}

export function isCancellable(job: Pick<ImportSummary, "status">): boolean {
  return isLive(job);
}

/** Problems worth a warning colour on a finished import: failed items, or a file that was refused. */
export function hasProblems(job: Pick<ImportSummary, "failed">): boolean {
  return (job.failed ?? 0) > 0;
}

/**
 * The tone of an import. One that completed is neutral, not green: the mail is
 * stowed, and green is kept for a restore check that passed (brand guide,
 * section 4).
 */
export function statusTone(job: Pick<ImportSummary, "status" | "failed">): StatusTone {
  switch (job.status) {
    case "queued":
      return "muted";
    case "active":
      return "default";
    case "completed":
      return hasProblems(job) ? "warning" : "neutral";
    case "failed":
      return "destructive";
    case "cancelled":
      return "secondary";
    default:
      return "muted";
  }
}

/** Key (namespace `imports`) of a status label, "completed with problems" included. */
export function statusKey(job: Pick<ImportSummary, "status" | "failed">): string {
  if (job.status === "completed" && hasProblems(job)) {
    return "status.completedWithIssues";
  }
  return `status.${job.status satisfies ImportStatus}`;
}

// --- Progress ---------------------------------------------------------------------------

/** `total` and `done` are source bytes; null while nothing is known yet. */
export function progressRatio(
  progress: Pick<NonNullable<ImportDetail["progress"]>, "total" | "done"> | null,
): number | null {
  if (!progress || !(progress.total > 0)) {
    return null;
  }
  return Math.max(0, Math.min(1, progress.done / progress.total));
}

const PHASES = new Set(["starting", "prepare", "import", "manifest", "archive"]);

/** Key of a phase name; unknown phases fall back to a generic label. */
export function phaseKey(phase: string | null): string | null {
  if (!phase) {
    return null;
  }
  return PHASES.has(phase) ? `phase.${phase}` : "phase.other";
}

// --- Items --------------------------------------------------------------------------------

export type ItemFilter = "all" | "failed" | "skipped";

export function matchesFilter(
  item: Pick<ImportReportItem, "outcome">,
  filter: ItemFilter,
): boolean {
  return filter === "all" || item.outcome === filter;
}

export function countByFilter(
  items: readonly Pick<ImportReportItem, "outcome">[],
): Record<ItemFilter, number> {
  const counts: Record<ItemFilter, number> = { all: items.length, failed: 0, skipped: 0 };
  for (const item of items) {
    counts[item.outcome] += 1;
  }
  return counts;
}

/** Problems first when there are any. */
export function initialFilter(items: readonly Pick<ImportReportItem, "outcome">[]): ItemFilter {
  return items.some((item) => item.outcome === "failed") ? "failed" : "all";
}

/** Failed items first, then skipped ones; the order within each group is kept. */
export function orderItems<T extends Pick<ImportReportItem, "outcome">>(items: readonly T[]): T[] {
  return [
    ...items.filter((item) => item.outcome === "failed"),
    ...items.filter((item) => item.outcome !== "failed"),
  ];
}

export const ITEM_CODES = [
  "unreadable",
  "unsupported",
  "not_mail",
  "pst_not_supported",
  "too_large",
  "empty",
  "limit",
  "duplicate",
] as const;

/** Key of the plain-language explanation of an item code; unknown codes get a generic one. */
export function itemCodeKey(code: string): string {
  return (ITEM_CODES as readonly string[]).includes(code)
    ? `items.codes.${code}`
    : "items.codes.other";
}

/** The item list as text for the clipboard: one line per item, tab separated. */
export function itemsAsText(items: readonly ImportReportItem[]): string {
  return items
    .map((item) => [item.file, item.ref, item.outcome, item.code, item.reason].join("\t"))
    .join("\n");
}

/**
 * How many messages a finished import found, all of them in the mailbox already (the same
 * files imported again): no message was new, none was unreadable and no restore point was
 * made. Null for every other report.
 */
export function alreadyImportedCount(report: ImportReport | null): number | null {
  if (!report || report.snapshotId) {
    return null;
  }
  const { messages, duplicates, failed } = report.totals;
  return messages === 0 && failed === 0 && duplicates > 0 ? duplicates : null;
}

export const KNOWN_NOTES = [
  "calendar_contacts_not_imported",
  "msg_reconstructed",
  "metadata_unavailable",
  "item_list_truncated",
  "report_recovered",
] as const;

/** Key of the sentence for a note code, or null for one this version does not know. */
export function noteKey(code: string): string | null {
  return (KNOWN_NOTES as readonly string[]).includes(code) ? `notes.${code}` : null;
}

/** First characters of a SHA-256 for the file table. */
export function shortHash(hash: string | null): string | null {
  return hash ? hash.slice(0, 12) : null;
}

// --- Formats -------------------------------------------------------------------------------

/** Key of a format's label (`formats.eml`, ...). */
export function formatKey(format: MailFileFormat | null): string {
  return `formats.${format ?? "unknown"}`;
}

// --- Imported mailboxes ----------------------------------------------------------------------

export interface ImportedMailbox {
  id: string;
  name: string;
  imports: number;
}

/**
 * The imported mailboxes to add to: the ones the account list knows
 * (`sourceKind: "import"`) plus the ones only the imports history knows about
 * (an import that has not produced a snapshot yet). Sorted by name.
 */
export function collectMailboxes(
  objects: readonly ObjectListEntry[],
  imports: readonly ImportSummary[],
): ImportedMailbox[] {
  const found = new Map<string, ImportedMailbox>();
  for (const object of objects) {
    if (object.sourceKind === "import") {
      found.set(object.id, {
        id: object.id,
        name: object.displayName?.trim() || object.externalId,
        imports: 0,
      });
    }
  }
  // The history is newest first: the first entry of an unknown object carries its current name.
  for (const entry of imports) {
    let mailbox = found.get(entry.objectId);
    if (!mailbox) {
      mailbox = { id: entry.objectId, name: entry.name, imports: 0 };
      found.set(entry.objectId, mailbox);
    }
    mailbox.imports += 1;
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// --- API problems ------------------------------------------------------------------------------

const PROBLEM_KEYS: Record<string, string> = {
  "urn:restow:problem:import-format-not-supported": "errors.formatNotSupported",
  "urn:restow:problem:import-file-too-large": "errors.fileTooLarge",
  "urn:restow:problem:import-name-taken": "errors.nameTaken",
  "urn:restow:problem:import-upload-not-ready": "errors.uploadNotReady",
  "urn:restow:problem:import-already-queued": "errors.alreadyQueued",
  "urn:restow:problem:import-folder-disabled": "errors.folderDisabled",
};

/** The fully qualified i18n key for a failed call: feature problems first, else the common mapping. */
export function importErrorKey(error: unknown): string {
  if (error instanceof ApiError && error.problem) {
    const key = PROBLEM_KEYS[error.problem.type];
    if (key) {
      return `imports:${key}`;
    }
  }
  return `common:${errorMessageKey(error)}`;
}
