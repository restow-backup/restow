import type { Snapshot, StoredVersion, TreeEntry, Version } from "@/features/restore/api";
import type { SelectedEntry } from "@/features/restore/lib/selection";

/**
 * Version history helpers: which version the browsed snapshot shows, and how
 * a version becomes something the restore dialog can take.
 */

/** Whether a version is the one the browsed snapshot contains. */
export function isShownVersion(version: Version, snapshot: Pick<Snapshot, "sequence">): boolean {
  return version.firstSeenSequence <= snapshot.sequence && snapshot.sequence <= version.sequence;
}

/**
 * The snapshot a version is restored from. The list of points in time is
 * usually loaded already; if the version lies beyond it, the version itself
 * carries everything the dialog shows.
 */
export function snapshotOfVersion(
  version: Version,
  snapshots: readonly Snapshot[] | undefined,
): Snapshot {
  const known = snapshots?.find((snapshot) => snapshot.id === version.snapshotId);
  if (known) {
    return known;
  }
  const at = version.snapshotAt ?? new Date(0).toISOString();
  return {
    id: version.snapshotId,
    objectId: version.objectId,
    sequence: version.sequence,
    itemCount: 0,
    byteSize: 0,
    startedAt: null,
    completedAt: version.snapshotAt,
    createdAt: at,
  };
}

/** A version as the one entry of a restore. */
export function versionEntry(version: Version, entry: Pick<TreeEntry, "mail">): SelectedEntry {
  return {
    path: version.path,
    kind: version.kind,
    itemId: version.itemId,
    subject: entry.mail?.subject ?? null,
    size: version.size,
  };
}

/** A version OneDrive kept, as the one entry of a download. */
export function storedVersionEntry(version: StoredVersion): SelectedEntry {
  return { path: version.path, kind: "file", itemId: null, subject: null, size: version.size };
}
