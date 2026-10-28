/**
 * Persistent state of the SharePoint engine. A site is many drives (its
 * libraries) and lists in one snapshot, so the OneDrive engine's state
 * (backup/onedrive/state.ts) is kept once per library, under the library's
 * drive id:
 *
 *   manifest state    per library the drive state the next run continues from
 *                     (delta link, root id, items to retry)
 *   job cursor        the libraries this job already finished (their new drive
 *                     state) and the cursor of the library in progress
 *   checkpoint state  the deletions the library in progress has not cascaded yet
 *
 * Lists have no state: they are read in full on every run (one request per
 * 200 items, the item JSON comes with the listing), unchanged items reuse the
 * stored bytes by their eTag.
 */
import type { Cursor, SnapshotCheckpoint } from "../../engine/types.js";
import {
  type OneDriveCheckpointState,
  type OneDriveCursor,
  type OneDriveManifestState,
  readCursor as readDriveCursor,
  readManifestState as readDriveState,
} from "../onedrive/state.js";

export const SITE_ENGINE_NAME = "sharepoint";

/** One library as the manifest state remembers it. */
export interface SiteLibraryState {
  readonly driveId: string;
  /** The folder below `Libraries/` the library was recorded in. */
  readonly folder: string;
  readonly drive: OneDriveManifestState;
  /**
   * Job cursor only: the item failures the attempt that finished the library
   * reported, so a resumed attempt still counts them in its result.
   */
  readonly failures?: number;
}

export interface SiteManifestState {
  readonly engine: typeof SITE_ENGINE_NAME;
  readonly siteId: string;
  readonly libraries: readonly SiteLibraryState[];
  /** Epoch milliseconds of the run. */
  readonly completedAt: number;
}

export interface SiteCursor extends Cursor {
  readonly engine: typeof SITE_ENGINE_NAME;
  readonly siteId: string;
  /** Libraries finished by this job (an earlier attempt), with their new drive state. */
  readonly done: readonly SiteLibraryState[];
  /** The library in progress when the checkpoint was taken. */
  readonly current?: {
    readonly driveId: string;
    readonly folder: string;
    readonly cursor: Omit<OneDriveCursor, "snapshot">;
  };
  readonly snapshot?: SnapshotCheckpoint;
}

export interface SiteCheckpointState {
  readonly engine: typeof SITE_ENGINE_NAME;
  readonly siteId: string;
  readonly checkpoint: true;
  /** The drive checkpoint of the library in progress, if any. */
  readonly drive: OneDriveCheckpointState | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLibraries(value: unknown): SiteLibraryState[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: SiteLibraryState[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.driveId !== "string" || typeof entry.folder !== "string") {
      continue;
    }
    const drive = readDriveState(isRecord(entry.drive) ? entry.drive : undefined, entry.driveId);
    if (drive) {
      const failures =
        typeof entry.failures === "number" && Number.isInteger(entry.failures) && entry.failures > 0
          ? entry.failures
          : undefined;
      result.push({
        driveId: entry.driveId,
        folder: entry.folder,
        drive,
        ...(failures !== undefined ? { failures } : {}),
      });
    }
  }
  return result;
}

/** The state of a previous manifest, if this engine wrote it for this site. */
export function readSiteManifestState(
  state: Record<string, unknown> | undefined,
  siteId: string,
): SiteManifestState | null {
  if (!isRecord(state) || state.engine !== SITE_ENGINE_NAME || state.siteId !== siteId) {
    return null;
  }
  return {
    engine: SITE_ENGINE_NAME,
    siteId,
    libraries: readLibraries(state.libraries),
    completedAt: typeof state.completedAt === "number" ? state.completedAt : 0,
  };
}

/** The saved cursor, if it belongs to this engine and site and carries a snapshot checkpoint. */
export function readSiteCursor(cursor: Cursor | null, siteId: string): SiteCursor | null {
  if (!cursor || cursor.engine !== SITE_ENGINE_NAME || cursor.siteId !== siteId) {
    return null;
  }
  if (!cursor.snapshot) {
    return null;
  }
  const current = isRecord(cursor.current) ? cursor.current : null;
  const driveCursor =
    current && typeof current.driveId === "string" && isRecord(current.cursor)
      ? readDriveCursor(
          { ...(current.cursor as Cursor), snapshot: cursor.snapshot as SnapshotCheckpoint },
          current.driveId,
        )
      : null;
  return {
    engine: SITE_ENGINE_NAME,
    siteId,
    done: readLibraries(cursor.done),
    current:
      driveCursor && current && typeof current.folder === "string"
        ? { driveId: driveCursor.driveId, folder: current.folder, cursor: driveCursor }
        : undefined,
    snapshot: cursor.snapshot as SnapshotCheckpoint,
  };
}

/** The drive cursor of the library in progress, in the form the drive run reads it. */
export function currentDriveCursor(
  cursor: SiteCursor | null,
  driveId: string,
  folder: string,
): OneDriveCursor | null {
  const current = cursor?.current;
  if (!current || current.driveId !== driveId || current.folder !== folder || !cursor?.snapshot) {
    return null;
  }
  return readDriveCursor({ ...current.cursor, snapshot: cursor.snapshot }, driveId);
}

export function siteCheckpointState(
  siteId: string,
  drive: OneDriveCheckpointState | null,
): SiteCheckpointState {
  return { engine: SITE_ENGINE_NAME, siteId, checkpoint: true, drive };
}

/** The drive checkpoint a site checkpoint carries, in the form the drive run reads it. */
export function checkpointDriveState(
  state: Record<string, unknown> | undefined,
  siteId: string,
): Record<string, unknown> | undefined {
  if (!isRecord(state) || state.engine !== SITE_ENGINE_NAME || state.siteId !== siteId) {
    return undefined;
  }
  return isRecord(state.drive) ? state.drive : undefined;
}
