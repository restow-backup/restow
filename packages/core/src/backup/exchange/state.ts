/**
 * Persistent state of the Exchange engine.
 *
 * Two things outlive a run:
 *
 *   ExchangeState  travels inside the snapshot manifest (`manifest.state`). It
 *                  holds the per-folder delta links the next run continues from
 *                  and the folder id -> path map that lets a later run notice a
 *                  renamed or deleted folder without touching every object.
 *   ExchangeCursor is the job cursor (`jobs.cursor`). It records what this run
 *                  has finished so a restarted attempt skips it, and carries
 *                  the SnapshotWriter checkpoint (see engine/snapshot.ts).
 *
 * Both are plain JSON, contain no secrets, and are validated on the way in: a
 * cursor or state from an older or corrupted run degrades to "start over",
 * never to a crash.
 */
import type { Cursor, SnapshotCheckpoint } from "../../engine/types.js";

export const EXCHANGE_STATE_VERSION = 1;

/**
 * Bumped whenever the mail delta `$select` gains a property that existing
 * stored delta links were not built with. Graph replays a stored delta link's
 * original `$select` verbatim (docs/MICROSOFT.md), so an installation that
 * upgrades across such a change would otherwise keep missing the new
 * properties on every incremental run forever. `./engine.ts` initialState
 * drops `mailDeltaLinks` when a loaded state predates this version, so each
 * mail folder is enumerated once more from scratch; unchanged messages still
 * match their stored fingerprint and so are carried forward without a new
 * MIME download (see mail.ts carryMessage), only their metadata refreshes.
 */
export const MAIL_SELECT_VERSION = 2;

/** One mail folder as recorded in the state. */
export interface MailFolderState {
  /** Object path of the folder, e.g. `mail/Inbox/Projects`. */
  readonly path: string;
  /** Folder names from the mailbox root, e.g. `Inbox/Projects` (the items' `folderPath`). */
  readonly displayPath: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly wellKnownName?: string;
  /** Well-known name of the top-level folder above (or equal to) this one. */
  readonly topWellKnownName?: string;
  readonly hidden?: boolean;
}

/** Mutable during a run; the run owns exactly one instance and serialises it at every checkpoint. */
export interface ExchangeState {
  readonly version: number;
  /** {@link MAIL_SELECT_VERSION} the stored `mailDeltaLinks` were built with. */
  mailSelectVersion: number;
  /** Delta link per mail folder id, from the last completed enumeration. */
  mailDeltaLinks: Record<string, string>;
  /** Mail folders by Graph id as the snapshot saw them. */
  mailFolders: Record<string, MailFolderState>;
  /**
   * Message ids per mail folder whose content could not be stored. The delta
   * link has moved past them, so the next run fetches them one by one.
   */
  mailRetry: Record<string, string[]>;
  /** Calendars by id -> object path. */
  calendars: Record<string, string>;
  /** Contact folders by id (the default folder uses the empty string) -> object path. */
  contactFolders: Record<string, string>;
}

export function emptyState(): ExchangeState {
  return {
    version: EXCHANGE_STATE_VERSION,
    mailSelectVersion: MAIL_SELECT_VERSION,
    mailDeltaLinks: {},
    mailFolders: {},
    mailRetry: {},
    calendars: {},
    contactFolders: {},
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function readRetry(value: unknown): Record<string, string[]> {
  const retry: Record<string, string[]> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return retry;
  }
  for (const [folderId, ids] of Object.entries(value as Record<string, unknown>)) {
    if (isStringArray(ids) && ids.length > 0) {
      retry[folderId] = [...ids];
    }
  }
  return retry;
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

function isFolderState(value: unknown): value is MailFolderState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === "string" &&
    typeof record.displayPath === "string" &&
    typeof record.name === "string" &&
    (record.parentId === null || typeof record.parentId === "string") &&
    (record.topWellKnownName === undefined || typeof record.topWellKnownName === "string")
  );
}

/**
 * Read the engine state out of a manifest's `state` field. Anything that does
 * not match the current version yields an empty state, which costs a full
 * enumeration but never correctness.
 */
export function readState(raw: Record<string, unknown> | undefined): ExchangeState {
  const candidate = raw?.exchange;
  if (typeof candidate !== "object" || candidate === null) {
    return emptyState();
  }
  const record = candidate as Record<string, unknown>;
  if (record.version !== EXCHANGE_STATE_VERSION) {
    return emptyState();
  }
  const folders: Record<string, MailFolderState> = {};
  if (typeof record.mailFolders === "object" && record.mailFolders !== null) {
    for (const [id, folder] of Object.entries(record.mailFolders as Record<string, unknown>)) {
      if (isFolderState(folder)) {
        folders[id] = folder;
      }
    }
  }
  return {
    version: EXCHANGE_STATE_VERSION,
    // Absent on any state saved before MAIL_SELECT_VERSION existed: treated as the
    // oldest select version so engine.ts resets the (also old) stored delta links.
    mailSelectVersion: typeof record.mailSelectVersion === "number" ? record.mailSelectVersion : 1,
    mailDeltaLinks: isRecordOfStrings(record.mailDeltaLinks) ? { ...record.mailDeltaLinks } : {},
    mailFolders: folders,
    mailRetry: readRetry(record.mailRetry),
    calendars: isRecordOfStrings(record.calendars) ? { ...record.calendars } : {},
    contactFolders: isRecordOfStrings(record.contactFolders) ? { ...record.contactFolders } : {},
  };
}

/** The manifest `state` field for an engine state. */
export function serializeState(state: ExchangeState): Record<string, unknown> {
  return { exchange: state };
}

/** The part of the run a cursor was saved in. */
export type ExchangePhase = "mail" | "calendar" | "contacts";

/**
 * What a run has completed so far; lives in the job cursor under `exchange`.
 * Mutated by the run. A folder interrupted halfway is enumerated again from
 * its stored delta link on resume; items this run already stored are
 * recognised by their fingerprint and not fetched twice, so the cursor's
 * `lastItemId` is for diagnostics only.
 */
export interface ExchangeProgress {
  /** Mail folders whose delta enumeration finished in this run. */
  completedFolders: string[];
  calendarDone: boolean;
  contactsDone: boolean;
}

export interface ExchangeCursor extends Cursor {
  phase?: ExchangePhase;
  exchange?: ExchangeProgress;
}

export interface ParsedCursor {
  readonly checkpoint: SnapshotCheckpoint | undefined;
  readonly progress: ExchangeProgress;
  /** Delta links of the folders completed in the interrupted run. */
  readonly deltaTokens: Record<string, string>;
}

function isCheckpoint(value: unknown): value is SnapshotCheckpoint {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.snapshotId === "string" &&
    typeof record.sequence === "number" &&
    typeof record.partialKey === "string" &&
    typeof record.objectCount === "number"
  );
}

/** Validate a stored cursor. A malformed cursor is treated as absent. */
export function parseCursor(raw: Cursor | null): ParsedCursor {
  const empty: ParsedCursor = {
    checkpoint: undefined,
    progress: { completedFolders: [], calendarDone: false, contactsDone: false },
    deltaTokens: {},
  };
  if (!raw || !isCheckpoint(raw.snapshot)) {
    return empty;
  }
  const progress = raw.exchange as Partial<ExchangeProgress> | undefined;
  const completed = Array.isArray(progress?.completedFolders)
    ? progress.completedFolders.filter((id): id is string => typeof id === "string")
    : [];
  return {
    checkpoint: raw.snapshot,
    progress: {
      completedFolders: completed,
      calendarDone: progress?.calendarDone === true,
      contactsDone: progress?.contactsDone === true,
    },
    deltaTokens: isRecordOfStrings(raw.deltaTokens) ? { ...raw.deltaTokens } : {},
  };
}
