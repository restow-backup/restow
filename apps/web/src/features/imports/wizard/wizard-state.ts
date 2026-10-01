import type { CreateImportInput, MailFileFormat } from "../types";

/**
 * The state and the rules of the four wizard steps as pure functions, so the
 * step logic is tested without rendering anything. The files being uploaded
 * live in the upload manager; the wizard only learns how many of them are
 * ready through {@link WizardContext}.
 */

export const WIZARD_STEPS = ["source", "files", "target", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export type ImportOrigin = "upload" | "folder";
export type TargetMode = "new" | "existing";

export const NAME_MAX_LENGTH = 120;

/** An entry of the server import folder the person ticked. */
export interface FolderSelection {
  /** Path relative to the import root ('/'-separated). */
  path: string;
  name: string;
  type: "file" | "directory";
  size: number | null;
  format: MailFileFormat | null;
}

export interface WizardState {
  step: WizardStep;
  origin: ImportOrigin | null;
  folderSelection: FolderSelection[];
  targetMode: TargetMode;
  name: string;
  objectId: string | null;
  archive: boolean;
}

export const initialWizardState: WizardState = {
  step: "source",
  origin: null,
  folderSelection: [],
  targetMode: "new",
  name: "",
  objectId: null,
  archive: false,
};

/** What the rules need to know about the world outside the wizard state. */
export interface WizardContext {
  uploadEnabled: boolean;
  folderEnabled: boolean;
  /** Files of the upload batch that are complete and accepted. */
  uploadsReady: number;
  /** Files of the upload batch that are still on their way (queued, sending, completing). */
  uploadsBusy: number;
}

export type WizardAction =
  | { type: "setOrigin"; origin: ImportOrigin }
  | { type: "toggleFolderEntry"; entry: FolderSelection }
  | { type: "removeFolderEntry"; path: string }
  | { type: "clearFolderSelection" }
  | { type: "setTargetMode"; mode: TargetMode }
  | { type: "setName"; name: string }
  | { type: "setObjectId"; objectId: string | null }
  | { type: "setArchive"; archive: boolean }
  | { type: "goTo"; step: WizardStep; context: WizardContext }
  | { type: "next"; context: WizardContext }
  | { type: "back" };

// --- Rules -----------------------------------------------------------------------------

/** The name of a new imported mailbox: trimmed, 1 to 120 characters. */
export function validateName(name: string): "empty" | "tooLong" | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "empty";
  }
  return trimmed.length > NAME_MAX_LENGTH ? "tooLong" : null;
}

/** The directory of `selection` that contains `path`, if one is ticked. */
export function coveringDirectory(
  selection: readonly FolderSelection[],
  path: string,
): FolderSelection | null {
  return (
    selection.find((entry) => entry.type === "directory" && path.startsWith(`${entry.path}/`)) ??
    null
  );
}

/**
 * Tick or untick an entry. A whole directory replaces what was ticked inside
 * it (the API refuses duplicate entries), and an entry inside a ticked
 * directory cannot be ticked on its own: it is already part of the import.
 */
export function toggleFolderEntry(
  selection: readonly FolderSelection[],
  entry: FolderSelection,
): FolderSelection[] {
  if (selection.some((existing) => existing.path === entry.path)) {
    return selection.filter((existing) => existing.path !== entry.path);
  }
  if (coveringDirectory(selection, entry.path)) {
    return [...selection];
  }
  const rest =
    entry.type === "directory"
      ? selection.filter((existing) => !existing.path.startsWith(`${entry.path}/`))
      : [...selection];
  return [...rest, entry];
}

/** Why the person cannot leave `step` yet; null when they can. Values are i18n keys below `wizard.blockers`. */
export function stepBlocker(
  state: WizardState,
  step: WizardStep,
  context: WizardContext,
): string | null {
  switch (step) {
    case "source":
      if (state.origin === null) return "origin";
      if (state.origin === "upload" && !context.uploadEnabled) return "uploadDisabled";
      if (state.origin === "folder" && !context.folderEnabled) return "folderDisabled";
      return null;
    case "files":
      if (state.origin === "folder") {
        return state.folderSelection.length === 0 ? "noFiles" : null;
      }
      return context.uploadsReady + context.uploadsBusy === 0 ? "noFiles" : null;
    case "target":
      if (state.targetMode === "new") {
        return validateName(state.name) === null ? null : "name";
      }
      return state.objectId === null ? "mailbox" : null;
    case "review":
      if (state.origin === "upload" && context.uploadsBusy > 0) return "uploading";
      if (state.origin === "upload" && context.uploadsReady === 0) return "noFiles";
      if (state.origin === "folder" && state.folderSelection.length === 0) return "noFiles";
      return null;
  }
}

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

/** A step can be opened when every step before it can be left. */
export function canOpen(state: WizardState, step: WizardStep, context: WizardContext): boolean {
  return WIZARD_STEPS.slice(0, stepIndex(step)).every(
    (before) => stepBlocker(state, before, context) === null,
  );
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "setOrigin":
      return { ...state, origin: action.origin };
    case "toggleFolderEntry":
      return {
        ...state,
        folderSelection: toggleFolderEntry(state.folderSelection, action.entry),
      };
    case "removeFolderEntry":
      return {
        ...state,
        folderSelection: state.folderSelection.filter((entry) => entry.path !== action.path),
      };
    case "clearFolderSelection":
      return { ...state, folderSelection: [] };
    case "setTargetMode":
      return { ...state, targetMode: action.mode };
    case "setName":
      return { ...state, name: action.name };
    case "setObjectId":
      return { ...state, objectId: action.objectId };
    case "setArchive":
      return { ...state, archive: action.archive };
    case "goTo":
      // Going back is always allowed; going forward only over steps that are complete.
      return stepIndex(action.step) <= stepIndex(state.step) ||
        canOpen(state, action.step, action.context)
        ? { ...state, step: action.step }
        : state;
    case "next": {
      const index = stepIndex(state.step);
      const target = WIZARD_STEPS[index + 1];
      if (!target || stepBlocker(state, state.step, action.context) !== null) {
        return state;
      }
      return { ...state, step: target };
    }
    case "back": {
      const target = WIZARD_STEPS[stepIndex(state.step) - 1];
      return target ? { ...state, step: target } : state;
    }
  }
}

// --- The request -------------------------------------------------------------------------

/**
 * The body of `POST /imports`: exactly one of `name` and `objectId`, and only
 * the files of the chosen origin (a refused or unfinished upload is never
 * part of it because only ready upload ids are passed in).
 */
export function buildCreateInput(
  state: WizardState,
  readyUploadIds: readonly string[],
): CreateImportInput {
  const files: CreateImportInput["files"] =
    state.origin === "folder"
      ? state.folderSelection.map((entry) => ({ origin: "folder" as const, path: entry.path }))
      : readyUploadIds.map((uploadId) => ({ origin: "upload" as const, uploadId }));
  return {
    ...(state.targetMode === "new"
      ? { name: state.name.trim() }
      : { objectId: state.objectId ?? undefined }),
    files,
    archive: state.archive,
  };
}
