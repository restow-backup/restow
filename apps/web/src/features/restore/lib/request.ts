import type {
  CreateRestoreRequest,
  ObjectKind,
  RestoreMode,
  RestoreOptions,
  RestoreTargetType,
} from "@/features/restore/api";
import {
  type Selection,
  everythingSelection,
  toApiSelection,
} from "@/features/restore/lib/selection";
import { ApiError, errorMessageKey } from "@/lib/api";

/**
 * The restore dialog's rules as pure functions: which targets are open to
 * whom, what must be filled in, and the request that goes to the API. The
 * server enforces the same rules; the dialog only says them first.
 */

export interface RestoreFormState {
  target: RestoreTargetType;
  accountId: string;
  mode: RestoreMode;
  reason: string;
}

export interface RestoreFormContext {
  /** Tenant admins may restore into another account. */
  canRestoreElsewhere: boolean;
  /** The restore touches someone else's data (admin restore), so a reason is required. */
  reasonRequired: boolean;
  /** The original account still exists in the source. */
  originalAvailable: boolean;
  /** The public demo only offers restore as a download (the API refuses anything else). */
  downloadOnly?: boolean;
}

/** What is being restored: a selection of the explorer, or the whole snapshot. */
export type RestoreScope = { kind: "selection"; selection: Selection } | { kind: "everything" };

/** Minimum reason length, mirrored from the API (apps/api/src/features/restore/schemas.ts). */
export const MIN_REASON_LENGTH = 3;

export type RestoreFormField = "target" | "accountId" | "reason";
/** Translation keys, with namespace, of the problem with each field. */
export type RestoreFormErrors = Partial<Record<RestoreFormField, string>>;

export function targetAvailable(target: RestoreTargetType, context: RestoreFormContext): boolean {
  if (context.downloadOnly && target !== "download") {
    return false;
  }
  switch (target) {
    case "original":
      return context.originalAvailable;
    case "other":
      return context.canRestoreElsewhere;
    case "download":
      return true;
  }
}

/** The target a dialog opens with: back where it came from when possible. */
export function defaultTarget(context: RestoreFormContext): RestoreTargetType {
  return targetAvailable("original", context) ? "original" : "download";
}

export function initialFormState(
  context: RestoreFormContext,
  preferred?: RestoreTargetType,
): RestoreFormState {
  const target =
    preferred && targetAvailable(preferred, context) ? preferred : defaultTarget(context);
  return { target, accountId: "", mode: "rename", reason: "" };
}

export function validateRestoreForm(
  state: RestoreFormState,
  context: RestoreFormContext,
): RestoreFormErrors {
  const errors: RestoreFormErrors = {};
  if (!targetAvailable(state.target, context)) {
    errors.target = "restore:dialog.errors.targetUnavailable";
  }
  if (state.target === "other" && state.accountId.trim().length === 0) {
    errors.accountId = "restore:dialog.errors.accountRequired";
  }
  if (context.reasonRequired && state.reason.trim().length < MIN_REASON_LENGTH) {
    errors.reason = "restore:dialog.errors.reasonRequired";
  }
  return errors;
}

export function hasErrors(errors: RestoreFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Collision handling only matters when writing into an account. */
export function modeApplies(target: RestoreTargetType): boolean {
  return target !== "download";
}

/**
 * Which collision modes a restore may offer: keep both or skip what exists. A
 * restore never overwrites an existing item; replacing OneDrive files (the
 * existing file becoming an earlier version) is planned for a later release.
 */
export function restoreModesFor(_kind: ObjectKind): readonly RestoreMode[] {
  return ["rename", "skip"] as const;
}

/**
 * Mail, calendar and contacts restored in "keep both" mode land in a new
 * folder (packages/core restore/common.ts); OneDrive renames files instead.
 */
export function usesRestoreFolder(kind: ObjectKind, state: RestoreFormState): boolean {
  return modeApplies(state.target) && state.mode === "rename" && kind !== "onedrive";
}

/**
 * What the "original location" card promises, for the collision mode chosen
 * below it: in "keep both" mode mail lands in a new folder of the account,
 * not where it came from, and the card says so (I-7).
 */
export function originalTargetDescriptionKey(
  kind: ObjectKind,
  mode: RestoreFormState["mode"],
): "dialog.target.originalDescription" | "dialog.target.originalDescriptionFolder" {
  return usesRestoreFolder(kind, { target: "original", accountId: "", mode, reason: "" })
    ? "dialog.target.originalDescriptionFolder"
    : "dialog.target.originalDescription";
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** "2026-09-23 1430" in local time: readable, sortable, safe in any mail folder name. */
export function restoreStamp(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** A download file name from the object's name and the time, e.g. `anna-example-2026-09-23-1430.zip`. */
export function archiveNameFor(label: string, now: Date): string {
  const base = label
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const stamp = restoreStamp(now).replace(" ", "-");
  return `${base.length > 0 ? base : "restore"}-${stamp}.zip`;
}

export interface BuildRequestInput {
  snapshotId: string;
  objectKind: ObjectKind;
  objectLabel: string;
  scope: RestoreScope;
  state: RestoreFormState;
  context: RestoreFormContext;
  /** Localized name of the restore folder (see usesRestoreFolder). */
  restoreFolderName: string;
  now: Date;
}

export function buildRestoreRequest(input: BuildRequestInput): CreateRestoreRequest {
  const { state } = input;
  const target =
    state.target === "other"
      ? { type: "other" as const, accountId: state.accountId.trim() }
      : { type: state.target };
  const reason = state.reason.trim();
  const options: RestoreOptions | null =
    state.target === "download"
      ? { archiveName: archiveNameFor(input.objectLabel, input.now) }
      : usesRestoreFolder(input.objectKind, state)
        ? { restoreFolderName: input.restoreFolderName }
        : null;
  // Defensive, not reachable from the form: the mode choices already only
  // offer what restoreModesFor(kind) allows, so a mailbox or IMAP request
  // can never carry "replace" even if `state` came from somewhere else.
  const allowedModes = restoreModesFor(input.objectKind);
  const mode =
    modeApplies(state.target) && allowedModes.includes(state.mode) ? state.mode : "rename";

  return {
    snapshotId: input.snapshotId,
    selection:
      input.scope.kind === "everything"
        ? everythingSelection()
        : toApiSelection(input.scope.selection),
    target,
    mode,
    ...(input.context.reasonRequired && reason.length > 0 ? { reason } : {}),
    ...(options ? { options } : {}),
  };
}

/** Where a failed request is explained: next to a field, or above the form. */
export interface RestoreErrorDisplay {
  field: RestoreFormField | null;
  /** Translation key with its namespace, e.g. `restore:dialog.errors.selectionUnknown`. */
  key: string;
}

const PROBLEM_KEYS: Record<string, RestoreErrorDisplay> = {
  "urn:restow:problem:restore-reason-required": {
    field: "reason",
    key: "restore:dialog.errors.reasonRequired",
  },
  "urn:restow:problem:restore-target-unknown": {
    field: "accountId",
    key: "restore:dialog.errors.targetUnknown",
  },
  "urn:restow:problem:restore-selection-unknown": {
    field: null,
    key: "restore:dialog.errors.selectionUnknown",
  },
  "urn:restow:problem:restore-original-gone": {
    field: null,
    key: "restore:dialog.errors.originalGone",
  },
  "urn:restow:problem:queue-unavailable": {
    field: null,
    key: "restore:dialog.errors.queueUnavailable",
  },
};

/** Explain a failed restore request in the user's language. */
export function restoreErrorOf(error: unknown): RestoreErrorDisplay {
  if (error instanceof ApiError) {
    const known = error.problem ? PROBLEM_KEYS[error.problem.type] : undefined;
    if (known) {
      return known;
    }
    if (error.status === 404) {
      return { field: null, key: "restore:dialog.errors.snapshotGone" };
    }
  }
  return { field: null, key: `common:${errorMessageKey(error)}` };
}
