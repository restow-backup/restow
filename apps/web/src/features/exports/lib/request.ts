import type {
  ArchiveExportFilter,
  ArchiveExportSelection,
  CreateExportRequest,
  ExportFormatId,
} from "@/features/exports/api";
import { type FormatChoice, formatAvailable } from "@/features/exports/lib/formats";
import { MIN_REASON_LENGTH, type RestoreScope } from "@/features/restore/lib/request";
import { everythingSelection, toApiSelection } from "@/features/restore/lib/selection";
import { ApiError, errorMessageKey } from "@/lib/api";

/**
 * The export dialog's rules as pure functions: what must be filled in and the
 * request that goes to the API. The server enforces the same rules; the
 * dialog only says them first.
 */

/** What an archive export covers: the ticked results, or the whole current search. */
export type ArchiveExportScope =
  | { kind: "items"; itemIds: readonly string[] }
  | {
      kind: "filter";
      filter: ArchiveExportFilter;
      /** How many results the search has, when known. */
      total: number | null;
      /** The name of the mailbox `filter.mailbox` names, for the dialog only (never sent). */
      mailboxLabel?: string;
    };

/** Where an export comes from: a snapshot of a mailbox, or the archive. */
export type ExportSource =
  | { origin: "snapshot"; snapshotId: string; scope: RestoreScope }
  | { origin: "archive"; scope: ArchiveExportScope };

export interface ExportFormState {
  format: ExportFormatId | null;
  /** The name the person typed; empty means "let Restow pick one". */
  fileName: string;
  reason: string;
}

export interface ExportFormContext {
  /** The export touches someone else's data (admin export), so a reason is required. */
  reasonRequired: boolean;
  /** The formats shown, with availability. */
  choices: readonly FormatChoice[];
}

export type ExportFormField = "format" | "fileName" | "reason" | "scope";
/** Translation keys, with namespace, of the problem with each field. */
export type ExportFormErrors = Partial<Record<ExportFormField, string>>;

export const MAX_FILE_NAME_LENGTH = 120;

/** Extensions the server adds itself; a person who types one is not penalised. */
const KNOWN_EXTENSION = /\.(zip|mbox|eml|msg)$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused here.
const FORBIDDEN_IN_FILE_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * The file name to send: trimmed, without an extension. The server appends
 * `.zip` or `.mbox` (only it knows whether a one folder MBOX export ends up as a
 * single file), so a typed extension would only double up.
 */
export function normalizeFileName(input: string): string {
  return input.trim().replace(KNOWN_EXTENSION, "").trim();
}

/** Why a typed file name cannot be used, or null when it is fine (or empty). */
export function fileNameProblem(input: string): "forbidden" | "tooLong" | null {
  const name = normalizeFileName(input);
  if (name.length === 0) {
    return null;
  }
  if (name.length > MAX_FILE_NAME_LENGTH) {
    return "tooLong";
  }
  if (FORBIDDEN_IN_FILE_NAME.test(name) || name === "." || name === ".." || name.startsWith(".")) {
    return "forbidden";
  }
  return null;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** "2026-09-23-1430" in local time: readable, sortable, safe in any file name. */
function stamp(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * The file name Restow suggests (shown as the placeholder), e.g.
 * `anna-example-2026-09-23-1430`. `fallback` names an export that has no
 * object to take a name from.
 */
export function suggestedFileName(label: string, fallback: string, now: Date): string {
  const slug = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  const base = slug(label) || slug(fallback) || "export";
  return `${base}-${stamp(now)}`;
}

export function initialFormState(choices: readonly FormatChoice[]): ExportFormState {
  const first = choices.find((choice) => choice.available);
  return { format: first?.id ?? null, fileName: "", reason: "" };
}

/** Number of things the archive scope names; 0 means there is nothing to export. */
export function archiveScopeSize(scope: ArchiveExportScope): number | null {
  return scope.kind === "items" ? scope.itemIds.length : scope.total;
}

export function validateExportForm(
  state: ExportFormState,
  context: ExportFormContext,
  source: ExportSource,
): ExportFormErrors {
  const errors: ExportFormErrors = {};
  if (source.origin === "archive" && archiveScopeSize(source.scope) === 0) {
    errors.scope = "exports:dialog.errors.emptyScope";
  }
  if (!formatAvailable(context.choices, state.format)) {
    errors.format = "exports:dialog.errors.formatUnavailable";
  }
  const problem = fileNameProblem(state.fileName);
  if (problem) {
    errors.fileName = `exports:dialog.errors.fileName.${problem}`;
  }
  if (
    source.origin === "snapshot" &&
    context.reasonRequired &&
    state.reason.trim().length < MIN_REASON_LENGTH
  ) {
    errors.reason = "exports:dialog.errors.reasonRequired";
  }
  return errors;
}

export function hasErrors(errors: ExportFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** The archive filter without empty values, so the request carries only what narrows the search. */
export function cleanFilter(filter: ArchiveExportFilter): ArchiveExportFilter {
  const clean: ArchiveExportFilter = {};
  for (const key of ["q", "mailbox", "from", "dateFrom", "dateTo"] as const) {
    const value = filter[key]?.trim();
    if (value) {
      clean[key] = value;
    }
  }
  if (filter.hasAttachment === true) {
    clean.hasAttachment = true;
  }
  return clean;
}

function archiveSelection(scope: ArchiveExportScope): ArchiveExportSelection {
  return scope.kind === "items"
    ? { itemIds: [...scope.itemIds] }
    : { filter: cleanFilter(scope.filter) };
}

export interface BuildExportInput {
  source: ExportSource;
  state: ExportFormState;
  context: Pick<ExportFormContext, "reasonRequired">;
}

/** The request for a validated form (see {@link validateExportForm}). */
export function buildExportRequest(input: BuildExportInput): CreateExportRequest {
  const { source, state } = input;
  const format: ExportFormatId = state.format ?? "eml_zip";
  const fileName = normalizeFileName(state.fileName);
  const name = fileName.length > 0 ? { fileName } : {};
  if (source.origin === "archive") {
    return {
      origin: "archive",
      selection: archiveSelection(source.scope),
      format,
      ...name,
    };
  }
  const reason = state.reason.trim();
  return {
    origin: "snapshot",
    snapshotId: source.snapshotId,
    selection:
      source.scope.kind === "everything"
        ? everythingSelection()
        : toApiSelection(source.scope.selection),
    format,
    ...(input.context.reasonRequired && reason.length > 0 ? { reason } : {}),
    ...name,
  };
}

/** Where a failed request is explained: next to a field, or above the form. */
export interface ExportErrorDisplay {
  field: ExportFormField | null;
  /** Translation key with its namespace, e.g. `exports:dialog.errors.notMail`. */
  key: string;
}

const PROBLEM_KEYS: Record<string, ExportErrorDisplay> = {
  "urn:restow:problem:export-not-mail": { field: null, key: "exports:dialog.errors.notMail" },
  "urn:restow:problem:export-format-unavailable": {
    field: "format",
    key: "exports:dialog.errors.formatUnavailable",
  },
  "urn:restow:problem:export-reason-required": {
    field: "reason",
    key: "exports:dialog.errors.reasonRequired",
  },
  "urn:restow:problem:restore-reason-required": {
    field: "reason",
    key: "exports:dialog.errors.reasonRequired",
  },
  "urn:restow:problem:export-selection-unknown": {
    field: null,
    key: "exports:dialog.errors.selectionUnknown",
  },
  "urn:restow:problem:restore-selection-unknown": {
    field: null,
    key: "exports:dialog.errors.selectionUnknown",
  },
  "urn:restow:problem:export-quota-exceeded": {
    field: null,
    key: "exports:dialog.errors.quotaExceeded",
  },
  "urn:restow:problem:queue-unavailable": {
    field: null,
    key: "exports:dialog.errors.queueUnavailable",
  },
};

/** Every translation key (with namespace) the dialog can show as a problem; checked against both languages by a test. */
export const EXPORT_ERROR_KEYS: readonly string[] = [
  ...new Set([
    ...Object.values(PROBLEM_KEYS).map((display) => display.key),
    "exports:dialog.errors.emptyScope",
    "exports:dialog.errors.formatUnavailable",
    "exports:dialog.errors.reasonRequired",
    "exports:dialog.errors.fileName.forbidden",
    "exports:dialog.errors.fileName.tooLong",
    "exports:dialog.errors.snapshotGone",
    "exports:dialog.errors.archiveGone",
  ]),
];

/** Explain a failed export request in the user's language. */
export function exportErrorOf(error: unknown, origin: ExportSource["origin"]): ExportErrorDisplay {
  if (error instanceof ApiError) {
    const known = error.problem ? PROBLEM_KEYS[error.problem.type] : undefined;
    if (known) {
      return known;
    }
    if (error.status === 404) {
      return {
        field: null,
        key:
          origin === "snapshot"
            ? "exports:dialog.errors.snapshotGone"
            : "exports:dialog.errors.archiveGone",
      };
    }
  }
  return { field: null, key: `common:${errorMessageKey(error)}` };
}
