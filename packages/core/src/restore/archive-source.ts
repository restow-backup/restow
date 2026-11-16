/**
 * Archived messages as a restore source (docs/ARCHIVE.md "Aus dem Archiv im
 * Restore-Explorer"): mail that reached the archive after the newest backup
 * of a mailbox goes back into that mailbox through the same engines as a
 * restore from a snapshot.
 *
 * The archive keeps every message as its original RFC 5322 bytes in the
 * tenant's chunk store (`archive_items.chunks`, `item_hash`, `size_bytes`),
 * which is exactly what a MIME message of a mailbox snapshot is. The host
 * reads the rows it may restore and hands them over as a manifest of `mail`
 * objects ({@link RestoreSourceOverride}); the engines then read, verify and
 * write each message like any other: the chunk reader checks every chunk
 * against its id and the whole message against the SHA-256 recorded at
 * capture, so a message that does not match never reaches the mailbox.
 *
 * Archived mail carries no folder, read state or flags of the mailbox
 * (journaling sees the transport, not the mailbox): the objects sit at the
 * root of the mail area, so a restore puts them into its restore folder
 * ("rename", the only mode the host uses for them). Nothing in the archive is
 * changed; the archive item stays as it was, under its retention and holds.
 */
import type { ProtectedObjectRef, RestoreSourceOverride } from "../engine/types.js";
import { MANIFEST_VERSION, type ManifestObject, type SnapshotManifest } from "../manifest.js";

/** The fields of one archived message a restore needs (`archive_items`). */
export interface ArchiveRestoreItem {
  readonly id: string;
  /** SHA-256 (hex) of the original bytes, recorded at capture. */
  readonly itemHash: string;
  readonly sizeBytes: number;
  /** Ordered stored chunk ids of the original bytes. */
  readonly chunks: readonly string[];
  readonly messageId: string | null;
  readonly receivedAt: Date;
  /** The message's own date, when the capture knew it. */
  readonly sentAt: Date | null;
  /** Subject and sender as captured, so the restore report names the message. */
  readonly subject?: string | null;
  readonly from?: string | null;
}

/** The logical path of an archived message in the restore source: the root of the mail area. */
export function archiveRestorePath(itemId: string): string {
  return `mail/${itemId}.eml`;
}

/** One archived message as the `mail` object the Exchange and IMAP engines restore. */
export function archiveRestoreObject(item: ArchiveRestoreItem): ManifestObject {
  const date = item.sentAt ?? item.receivedAt;
  const messageId = item.messageId?.trim();
  const subject = item.subject?.trim();
  const from = item.from?.trim();
  return {
    path: archiveRestorePath(item.id),
    size: item.sizeBytes,
    mtime: date.getTime(),
    id: item.id,
    type: "mail",
    sha256: item.itemHash,
    chunks: [...item.chunks],
    metadata: {
      format: "mime",
      // The date IMAP APPEND gives the message (else the restore time).
      internalDate: date.toISOString(),
      ...(messageId ? { messageId } : {}),
      ...(subject ? { subject } : {}),
      ...(from ? { from } : {}),
    },
  };
}

/**
 * The archived messages of one mailbox as a restore source. `label` names the
 * source in logs (the restore job id); it is not a snapshot id.
 */
export function archiveRestoreSource(input: {
  readonly protectedObject: ProtectedObjectRef;
  readonly items: readonly ArchiveRestoreItem[];
  readonly label: string;
  readonly createdAt: Date;
}): RestoreSourceOverride {
  const { protectedObject } = input;
  const manifest: SnapshotManifest = {
    version: MANIFEST_VERSION,
    tenantId: protectedObject.tenantId,
    snapshotId: input.label,
    createdAt: input.createdAt.getTime(),
    source: {
      type: protectedObject.kind === "imap" ? "imap" : "m365",
      id: protectedObject.externalId,
      kind: protectedObject.kind,
      protectedObjectId: protectedObject.id,
    },
    objects: input.items.map(archiveRestoreObject),
  };
  return { kind: "archive", manifest };
}
