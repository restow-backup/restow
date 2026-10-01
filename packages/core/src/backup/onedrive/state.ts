/**
 * Persistent state of the OneDrive engine, in three places:
 *
 *   manifest state    what the last committed snapshot remembers for the next
 *                     run (`SnapshotManifest.state`): delta link, root id,
 *                     items to retry
 *   job cursor        where a running job is (`jobs.cursor`): page URL, last
 *                     item, retries; saved with every checkpoint
 *   checkpoint state  what a partial manifest needs besides its objects
 *                     (deletions not yet cascaded); lives in storage, not in
 *                     the cursor, because it can grow with the change set
 *
 * All of it is plain JSON without secrets: delta links are opaque Graph URLs
 * that carry no credentials.
 */
import type { Cursor, SnapshotCheckpoint } from "../../engine/types.js";
import type { DeltaMode } from "../../graph/delta.js";
import type { DeltaStart } from "./delta.js";

export const ENGINE_NAME = "onedrive";

/** The engine's part of a committed manifest's `state`. */
export interface OneDriveManifestState {
  readonly engine: typeof ENGINE_NAME;
  readonly driveId: string;
  /** Graph id of the drive's root item: its children are the top level. */
  readonly rootId: string | null;
  /** Continue the next incremental run from here. */
  readonly deltaLink: string;
  /** How the run that produced this manifest enumerated the drive. */
  readonly mode: DeltaMode;
  /** Item ids the run could not read; the next run fetches them again before its delta. */
  readonly retry: readonly string[];
  /**
   * More items failed than the retry list holds. The next run enumerates the
   * whole drive so none of them is forgotten (unchanged content is reused).
   */
  readonly fullResyncRequired: boolean;
  /** Whether historical versions were collected. */
  readonly versions: boolean;
  /** Epoch milliseconds of the run. */
  readonly completedAt: number;
}

/** The engine's job cursor, saved with every checkpoint. */
export interface OneDriveCursor extends Cursor {
  readonly engine: typeof ENGINE_NAME;
  readonly driveId: string;
  readonly rootId: string | null;
  readonly mode: DeltaMode;
  /** URL of the delta page being processed when the checkpoint was taken. */
  readonly pageUrl: string;
  /** Last item of that page that was fully processed, if any. */
  readonly lastItemId?: string;
  /** Delta link, once the walk has completed and only the commit remains. */
  readonly deltaLink?: string;
  /** True once the previous run's retry list has been worked through. */
  readonly retriesDone: boolean;
  /** Items that failed in this job so far (carried across attempts into the manifest state). */
  readonly retry: readonly string[];
  /** Failures beyond the retry list's capacity occurred in this job. */
  readonly retryOverflow: boolean;
  readonly snapshot?: SnapshotCheckpoint;
}

/** What a partial (checkpoint) manifest carries in its `state`. */
export interface OneDriveCheckpointState {
  readonly engine: typeof ENGINE_NAME;
  readonly driveId: string;
  readonly checkpoint: true;
  /** Items deleted in this run whose descendants are dropped at commit. */
  readonly deleted: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is DeltaMode {
  return value === "initial" || value === "incremental" || value === "resync";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The state of a previous manifest, if it was written by this engine for this drive. */
export function readManifestState(
  state: Record<string, unknown> | undefined,
  driveId: string,
): OneDriveManifestState | null {
  if (!isRecord(state) || state.engine !== ENGINE_NAME || state.driveId !== driveId) {
    return null;
  }
  if (typeof state.deltaLink !== "string" || state.deltaLink.length === 0) {
    return null;
  }
  return {
    engine: ENGINE_NAME,
    driveId,
    rootId: typeof state.rootId === "string" ? state.rootId : null,
    deltaLink: state.deltaLink,
    mode: isMode(state.mode) ? state.mode : "initial",
    retry: stringList(state.retry),
    fullResyncRequired: state.fullResyncRequired === true,
    versions: state.versions === true,
    completedAt: typeof state.completedAt === "number" ? state.completedAt : 0,
  };
}

/** The saved cursor, if it belongs to this engine and drive and carries a snapshot checkpoint. */
export function readCursor(cursor: Cursor | null, driveId: string): OneDriveCursor | null {
  if (!cursor || cursor.engine !== ENGINE_NAME || cursor.driveId !== driveId) {
    return null;
  }
  if (typeof cursor.pageUrl !== "string" || !isMode(cursor.mode) || !cursor.snapshot) {
    return null;
  }
  return {
    ...cursor,
    engine: ENGINE_NAME,
    driveId,
    rootId: typeof cursor.rootId === "string" ? cursor.rootId : null,
    mode: cursor.mode,
    pageUrl: cursor.pageUrl,
    lastItemId: typeof cursor.lastItemId === "string" ? cursor.lastItemId : undefined,
    deltaLink: typeof cursor.deltaLink === "string" ? cursor.deltaLink : undefined,
    retriesDone: cursor.retriesDone === true,
    retry: stringList(cursor.retry),
    retryOverflow: cursor.retryOverflow === true,
    snapshot: cursor.snapshot,
  };
}

export function checkpointState(
  driveId: string,
  deleted: readonly string[],
): OneDriveCheckpointState {
  return { engine: ENGINE_NAME, driveId, checkpoint: true, deleted };
}

/** Deletions recorded by a checkpoint of this engine and drive (empty for anything else). */
export function readCheckpointDeletions(
  state: Record<string, unknown> | undefined,
  driveId: string,
): string[] {
  if (!isRecord(state) || state.engine !== ENGINE_NAME || state.driveId !== driveId) {
    return [];
  }
  return state.checkpoint === true ? stringList(state.deleted) : [];
}

/** Why a run enumerates the way it does (logged; lets an operator see why a run took long). */
export type RunReason =
  | "resume"
  | "incremental"
  | "first-run"
  | "full-requested"
  | "retry-overflow"
  | "versions-enabled";

/** How a run proceeds, decided once up front from options, cursor and previous state. */
export interface RunPlan {
  readonly reason: RunReason;
  readonly start: DeltaStart;
  /** Skip the items of the first page up to and including this id (already stored before the restart). */
  readonly skipThroughItemId: string | undefined;
  /** Start from the previous snapshot's objects and apply the changes on top. */
  readonly inheritPrevious: boolean;
  /** Items to fetch again before the walk. */
  readonly retryIds: readonly string[];
  readonly rootId: string | null;
  /** The walk already finished in a previous attempt; only the commit remains. */
  readonly walkDone: boolean;
  /** The delta link that finished walk produced (null while a walk is still needed). */
  readonly deltaLink: string | null;
  /** Versions were just switched on: list them for unchanged files too, not only for changed ones. */
  readonly backfillVersions: boolean;
  /** An earlier attempt of this job already had more failures than the retry list holds. */
  readonly retryOverflow: boolean;
}

export function planRun(input: {
  readonly full: boolean;
  readonly includeVersions: boolean;
  readonly resume: OneDriveCursor | null;
  readonly previous: OneDriveManifestState | null;
}): RunPlan {
  const { full, includeVersions, resume, previous } = input;
  const backfillVersions = includeVersions && previous !== null && !previous.versions;

  if (resume) {
    const walkDone = resume.deltaLink !== undefined;
    // Items that failed earlier in this job get one more attempt on resume; the
    // previous run's list is only replayed when the retry phase had not finished.
    const retryIds = [
      ...new Set([...(resume.retriesDone ? [] : (previous?.retry ?? [])), ...resume.retry]),
    ];
    return {
      reason: "resume",
      start: { url: resume.pageUrl, mode: resume.mode },
      skipThroughItemId: walkDone ? undefined : resume.lastItemId,
      inheritPrevious: false,
      retryIds,
      rootId: resume.rootId,
      walkDone,
      deltaLink: resume.deltaLink ?? null,
      backfillVersions,
      retryOverflow: resume.retryOverflow,
    };
  }

  const fullReason: RunReason | null = full
    ? "full-requested"
    : previous === null
      ? "first-run"
      : previous.fullResyncRequired
        ? "retry-overflow"
        : backfillVersions
          ? "versions-enabled"
          : null;
  if (fullReason !== null || previous === null) {
    // A full enumeration sees every item, so nothing is left to retry separately.
    return {
      reason: fullReason ?? "first-run",
      start: { url: null, mode: "initial" },
      skipThroughItemId: undefined,
      inheritPrevious: false,
      retryIds: [],
      rootId: previous?.rootId ?? null,
      walkDone: false,
      deltaLink: null,
      backfillVersions,
      retryOverflow: false,
    };
  }
  return {
    reason: "incremental",
    start: { url: previous.deltaLink, mode: "incremental" },
    skipThroughItemId: undefined,
    inheritPrevious: true,
    retryIds: previous.retry,
    rootId: previous.rootId,
    walkDone: false,
    deltaLink: null,
    backfillVersions,
    retryOverflow: false,
  };
}
