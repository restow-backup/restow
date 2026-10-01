/**
 * Pure mapping between Graph driveItems (as the root delta yields them) and
 * manifest objects: what kind of item it is, where Graph says it lives, what
 * metadata is worth keeping, and whether the bytes stored by an earlier
 * snapshot can be reused without downloading again.
 *
 * Nothing in here performs I/O, so every rule is unit-testable with fixtures.
 */
import type { DriveItem, DriveItemVersion, IdentitySet } from "@microsoft/microsoft-graph-types";
import {
  type DriveDeltaItem,
  driveItemPath,
  isDeletedItem,
  isFolderItem,
  isPackageItem,
} from "../../graph/resources/drive.js";
import type { ManifestObject } from "../../manifest.js";

/**
 * `ManifestObject.type` values written by the OneDrive engine. `file` and
 * `folder` are the shared restore vocabulary (restore/conventions.ts); OneNote
 * notebooks are recorded as folders (their sections are ordinary files below
 * them) with `metadata.packageType` set.
 */
export const ONEDRIVE_OBJECT_TYPES = {
  file: "file",
  folder: "folder",
  /** "Add shortcut to My files" links into other drives: recorded as information, not followed. */
  shortcut: "shortcut",
  /** A historical version of a file (optional), stored in the file's version namespace. */
  version: "file-version",
} as const;

export type OneDriveObjectType = (typeof ONEDRIVE_OBJECT_TYPES)[keyof typeof ONEDRIVE_OBJECT_TYPES];

/**
 * Separator between a file path and its versions. `:` is not allowed in
 * OneDrive names, so `<path>:versions/<id>` can never collide with a real item.
 */
export const VERSION_PATH_MARKER = ":versions/";

export type DriveItemKind = "root" | "deleted" | "folder" | "file" | "shortcut" | "unknown";

export function classifyItem(item: DriveItem): DriveItemKind {
  if (item.root !== undefined && item.root !== null) {
    return "root";
  }
  if (isDeletedItem(item)) {
    return "deleted";
  }
  if (item.remoteItem !== undefined && item.remoteItem !== null) {
    return "shortcut";
  }
  if (isPackageItem(item) || isFolderItem(item)) {
    return "folder";
  }
  if (item.file !== undefined && item.file !== null) {
    return "file";
  }
  return "unknown";
}

/** Join a parent path (empty for the drive root) and a child name. */
export function joinPath(parentPath: string, name: string): string {
  return parentPath.length === 0 ? name : `${parentPath}/${name}`;
}

/**
 * The item's path as Graph reported it through `parentReference.path`, or
 * undefined when the entry carries none (Graph documents delta entries
 * without it; items must then be placed by parent id).
 */
export function graphPathOf(item: DriveDeltaItem): string | undefined {
  if (typeof item.parentReference?.path !== "string" || !item.name) {
    return undefined;
  }
  return driveItemPath(item);
}

/** Epoch milliseconds of the client-side modification time, falling back to the server's. */
export function itemMtime(item: DriveItem, fallback: number): number {
  const candidates = [item.fileSystemInfo?.lastModifiedDateTime, item.lastModifiedDateTime];
  for (const value of candidates) {
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return fallback;
}

function identityLabel(identity: IdentitySet | null | undefined): string | undefined {
  const who = identity?.user ?? identity?.application ?? identity?.device;
  if (!who) {
    return undefined;
  }
  const email = (who as { email?: string }).email;
  return who.displayName ?? email ?? who.id ?? undefined;
}

/** Keep only defined, non-empty string values. */
function compact(entries: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

/** Metadata common to every item kind (placement, timestamps, authorship, sharing as information only). */
function baseMetadata(item: DriveItem): Record<string, string> {
  return compact({
    eTag: item.eTag ?? undefined,
    // The parent id is what places the item in the tree on the next run.
    parentId: item.parentReference?.id ?? undefined,
    webUrl: item.webUrl ?? undefined,
    createdDateTime: item.fileSystemInfo?.createdDateTime ?? item.createdDateTime ?? undefined,
    lastModifiedDateTime:
      item.fileSystemInfo?.lastModifiedDateTime ?? item.lastModifiedDateTime ?? undefined,
    createdBy: identityLabel(item.createdBy),
    lastModifiedBy: identityLabel(item.lastModifiedBy),
    // Sharing is recorded so an operator can see it; permissions are never restored (v1).
    sharedScope: item.shared?.scope ?? undefined,
    sharedBy: identityLabel(item.shared?.sharedBy),
    sharedDateTime: item.shared?.sharedDateTime ?? undefined,
  });
}

/**
 * Metadata keys that describe the stored bytes rather than the item. A copy
 * carried forward after a failed download keeps these from the copy, not from
 * the item's current (unread) content.
 */
const CONTENT_KEYS = [
  "cTag",
  "sourceSize",
  "contentType",
  "quickXorHash",
  "sha1Hash",
  "sha256Hash",
] as const;

export function fileMetadata(item: DriveItem, contentType?: string | null): Record<string, string> {
  return {
    ...baseMetadata(item),
    ...compact({
      cTag: item.cTag ?? undefined,
      // The size Graph reports can differ from the bytes a download yields
      // (SharePoint rewrites Office document properties on the way out); the
      // reuse check compares like with like.
      sourceSize: typeof item.size === "number" ? String(item.size) : undefined,
      // `contentType` is the key the restore conventions read (restore/conventions.ts).
      contentType: item.file?.mimeType ?? contentType ?? undefined,
      quickXorHash: item.file?.hashes?.quickXorHash ?? undefined,
      sha1Hash: item.file?.hashes?.sha1Hash ?? undefined,
      sha256Hash: item.file?.hashes?.sha256Hash ?? undefined,
    }),
  };
}

/** The bytes of one object as the chunk writer reported them (or as an earlier snapshot recorded them). */
export interface StoredContent {
  readonly size: number;
  readonly sha256?: string;
  readonly chunks: string[];
}

export function fileObject(
  item: DriveDeltaItem,
  path: string,
  content: StoredContent,
  options: { now: number; contentType?: string | null },
): ManifestObject {
  const object: ManifestObject = {
    path,
    id: item.id,
    type: ONEDRIVE_OBJECT_TYPES.file,
    size: content.size,
    mtime: itemMtime(item, options.now),
    metadata: fileMetadata(item, options.contentType),
    chunks: content.chunks,
  };
  if (content.sha256 !== undefined) {
    object.sha256 = content.sha256;
  }
  return object;
}

/** A folder, or a OneNote notebook (a package whose sections are files below it). */
export function folderObject(item: DriveDeltaItem, path: string, now: number): ManifestObject {
  const childCount = item.folder?.childCount;
  return {
    path,
    id: item.id,
    type: ONEDRIVE_OBJECT_TYPES.folder,
    size: 0,
    mtime: itemMtime(item, now),
    metadata: {
      ...baseMetadata(item),
      ...compact({
        childCount:
          childCount === undefined || childCount === null ? undefined : String(childCount),
        packageType: item.package?.type ?? undefined,
      }),
    },
    chunks: [],
  };
}

export function shortcutObject(item: DriveDeltaItem, path: string, now: number): ManifestObject {
  return {
    path,
    id: item.id,
    type: ONEDRIVE_OBJECT_TYPES.shortcut,
    size: 0,
    mtime: itemMtime(item, now),
    metadata: {
      ...baseMetadata(item),
      ...compact({
        remoteDriveId: item.remoteItem?.parentReference?.driveId ?? undefined,
        remoteItemId: item.remoteItem?.id ?? undefined,
        remoteWebUrl: item.remoteItem?.webUrl ?? undefined,
        remoteKind: item.remoteItem?.folder ? "folder" : item.remoteItem?.file ? "file" : undefined,
      }),
    },
    chunks: [],
  };
}

/** Objects that carry bytes an unchanged item may reuse. */
export function hasContent(object: ManifestObject): boolean {
  return (
    object.type === ONEDRIVE_OBJECT_TYPES.file || object.type === ONEDRIVE_OBJECT_TYPES.version
  );
}

/**
 * A previous copy of the same file whose bytes are still what the source
 * holds. Graph's `cTag` changes exactly when the content changes (not on
 * metadata edits); the quickXorHash is the fallback for items without one.
 * Both must agree with the size Graph reported, and the copy must carry the
 * chunk list and hash that reconstruct and verify it.
 */
export function canReuseContent(previous: ManifestObject, item: DriveDeltaItem): boolean {
  if (previous.id !== item.id || previous.type !== ONEDRIVE_OBJECT_TYPES.file) {
    return false;
  }
  if (previous.sha256 === undefined || previous.metadata?.stale === "true") {
    return false;
  }
  if (typeof item.size !== "number") {
    return false;
  }
  const recordedSize = previous.metadata?.sourceSize ?? String(previous.size);
  if (recordedSize !== String(item.size)) {
    return false;
  }
  const previousTag = previous.metadata?.cTag;
  if (previousTag !== undefined && item.cTag) {
    return previousTag === item.cTag;
  }
  const previousHash = previous.metadata?.quickXorHash;
  const currentHash = item.file?.hashes?.quickXorHash;
  return previousHash !== undefined && !!currentHash && previousHash === currentHash;
}

/**
 * The same file at a (possibly new) path with fresh metadata but the stored
 * bytes of `previous`. Used for renames, moves and unchanged content on a
 * full re-enumeration.
 */
export function reusedFileObject(
  previous: ManifestObject,
  item: DriveDeltaItem,
  path: string,
  now: number,
): ManifestObject {
  return fileObject(
    item,
    path,
    { size: previous.size, sha256: previous.sha256, chunks: previous.chunks },
    { now, contentType: previous.metadata?.contentType },
  );
}

/**
 * When the source could not be read this run, the last good copy is kept at
 * the item's current place and marked stale, so a restore still has the file
 * while the failure is reported and retried on the next run. Everything that
 * describes the bytes (content tag, hashes, sizes) stays with the copy.
 */
export function staleFileObject(
  previous: ManifestObject,
  item: DriveDeltaItem,
  path: string,
  now: number,
): ManifestObject {
  const object = reusedFileObject(previous, item, path, now);
  const metadata: Record<string, string> = { ...object.metadata };
  for (const key of CONTENT_KEYS) {
    const kept = previous.metadata?.[key];
    if (kept === undefined) {
      delete metadata[key];
    } else {
      metadata[key] = kept;
    }
  }
  metadata.stale = "true";
  return { ...object, mtime: previous.mtime, metadata };
}

// ---------------------------------------------------------------------------
// Versions

export function versionPath(filePath: string, versionId: string): string {
  return `${filePath}${VERSION_PATH_MARKER}${versionId}`;
}

export function versionObjectId(itemId: string, versionId: string): string {
  return `${itemId}#${versionId}`;
}

export function isVersionPath(path: string): boolean {
  return path.includes(VERSION_PATH_MARKER);
}

export function versionObject(
  item: DriveDeltaItem,
  filePath: string,
  version: DriveItemVersion & { id: string },
  content: StoredContent,
  now: number,
): ManifestObject {
  const modified = version.lastModifiedDateTime
    ? Date.parse(version.lastModifiedDateTime)
    : Number.NaN;
  const object: ManifestObject = {
    path: versionPath(filePath, version.id),
    id: versionObjectId(item.id, version.id),
    type: ONEDRIVE_OBJECT_TYPES.version,
    size: content.size,
    mtime: Number.isNaN(modified) ? now : modified,
    metadata: compact({
      itemId: item.id,
      versionId: version.id,
      sourceSize: typeof version.size === "number" ? String(version.size) : undefined,
      lastModifiedDateTime: version.lastModifiedDateTime ?? undefined,
      lastModifiedBy: identityLabel(version.lastModifiedBy),
      contentType: item.file?.mimeType ?? undefined,
    }),
    chunks: content.chunks,
  };
  if (content.sha256 !== undefined) {
    object.sha256 = content.sha256;
  }
  return object;
}

/** True when a stored version still matches what Graph lists for it. */
export function versionUnchanged(stored: ManifestObject, version: DriveItemVersion): boolean {
  if (stored.type !== ONEDRIVE_OBJECT_TYPES.version || stored.sha256 === undefined) {
    return false;
  }
  if (typeof version.size !== "number") {
    return true;
  }
  return (stored.metadata?.sourceSize ?? String(stored.size)) === String(version.size);
}

function modifiedAt(version: DriveItemVersion): number {
  const parsed = version.lastModifiedDateTime
    ? Date.parse(version.lastModifiedDateTime)
    : Number.NaN;
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Historical versions to store: everything but the current one, which is the
 * item itself. The newest entry by modification time is the current version
 * (Graph lists newest first; the sort only guards against a different order).
 * Entries without an id cannot be addressed and are skipped.
 */
export function historicalVersions(
  versions: readonly DriveItemVersion[],
): Array<DriveItemVersion & { id: string }> {
  return [...versions]
    .sort((a, b) => modifiedAt(b) - modifiedAt(a))
    .slice(1)
    .filter((version): version is DriveItemVersion & { id: string } => !!version.id);
}
