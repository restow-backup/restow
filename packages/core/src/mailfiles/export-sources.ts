/**
 * Where exported mail comes from (docs/IMPORT.md): the messages of a backup or
 * imported-mailbox snapshot, turned into {@link ExportMessage}s for the export
 * writers.
 *
 * The snapshot and its selection are resolved exactly like a download restore
 * (restore/selection.ts), so an export shows what the explorer showed. Only
 * mail is exported. Every message streams straight from the chunk store; the
 * store verifies the SHA-256 recorded in the manifest while it reads, so a
 * damaged chunk ends the export instead of producing a silently corrupt file.
 *
 * What is left out is counted, never hidden: calendar events and contacts (not
 * mail), messages that Graph could only deliver as parts (no RFC 5322 bytes
 * exist for them) and other object types.
 */
import { Readable } from "node:stream";
import type { ChunkReader } from "../engine/chunkstore.js";
import type { JobContext, ProtectedObjectRef, RestoreSelection } from "../engine/types.js";
import type { ManifestObject } from "../manifest.js";
import { chunkReaderFor } from "../restore/common.js";
import {
  folderSegmentsOf,
  mailboxAreaOf,
  messageFormatOf,
  objectTypeOf,
} from "../restore/conventions.js";
import { planRestore, resolveRestoreSource } from "../restore/selection.js";
import type { ExportMessage } from "./export/types.js";

export interface SnapshotExportRequest {
  readonly snapshotId: string;
  readonly protectedObject: ProtectedObjectRef;
  readonly selection: RestoreSelection;
}

export interface ExportCounts {
  /** Messages that will be exported (or fail while doing so). */
  readonly mail: number;
  /** Left out because they are not mail. */
  readonly calendar: number;
  readonly contacts: number;
  readonly other: number;
  /** Folder objects in the selection (kept as empty folders). */
  readonly folders: number;
}

export interface SnapshotExportSource {
  readonly messages: readonly ExportMessage[];
  /** Folders to keep even when empty. */
  readonly folders: readonly (readonly string[])[];
  readonly counts: ExportCounts;
}

function isMailObject(object: ManifestObject): boolean {
  return objectTypeOf(object) === "mail";
}

/**
 * The folder a message lives in: IMAP mailboxes by the path the server (or the
 * import) recorded, verbatim (an imported "Inbox" stays "Inbox"), Exchange folders by display name.
 */
export function exportFolderOf(object: ManifestObject): string[] {
  const mailbox = object.metadata?.mailbox;
  const components =
    mailbox !== undefined
      ? mailbox.split(object.metadata?.delimiter || "/").filter((part) => part.length > 0)
      : folderSegmentsOf(object, "mail");
  return components.length > 0 ? components : ["Mailbox"];
}

function dateOf(object: ManifestObject): Date | null {
  const recorded = object.metadata?.internalDate ?? object.metadata?.sentDateTime;
  if (recorded) {
    const parsed = new Date(recorded);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return object.mtime > 0 ? new Date(object.mtime) : null;
}

function failingStream(reason: string): Readable {
  return new Readable({
    read() {
      this.destroy(new Error(reason));
    },
  });
}

function compareForExport(a: ManifestObject, b: ManifestObject): number {
  const folderA = exportFolderOf(a).join("\u0000");
  const folderB = exportFolderOf(b).join("\u0000");
  if (folderA !== folderB) {
    return folderA < folderB ? -1 : 1;
  }
  const uidA = Number(a.metadata?.uid);
  const uidB = Number(b.metadata?.uid);
  if (Number.isInteger(uidA) && Number.isInteger(uidB) && uidA !== uidB) {
    return uidA - uidB;
  }
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** One message as an {@link ExportMessage}; `open` streams verified bytes from the chunk store. */
export function exportMessageOf(object: ManifestObject, reader: ChunkReader): ExportMessage {
  const metadata = object.metadata ?? {};
  const base = {
    folder: exportFolderOf(object),
    date: dateOf(object),
    size: object.size,
    messageId: metadata.messageId ?? metadata.internetMessageId ?? null,
    subject: metadata.subject ?? null,
    from: metadata.from ?? null,
    to: metadata.to ?? null,
  };
  if (messageFormatOf(object) === "json") {
    return {
      ...base,
      open: () =>
        failingStream(
          "the message was backed up as separate parts (Microsoft did not deliver its MIME form), so it has no original file to export",
        ),
    };
  }
  return {
    ...base,
    ...(object.sha256 !== undefined ? { sha256: object.sha256 } : {}),
    open: () => reader.objectStream(object),
  };
}

/** Resolve a snapshot selection into export messages and the counts of what is left out. */
export async function openSnapshotExport(
  ctx: Pick<
    JobContext,
    "snapshots" | "storage" | "keys" | "chunkIndex" | "logger" | "signal" | "progress"
  >,
  request: SnapshotExportRequest,
): Promise<SnapshotExportSource> {
  const { manifest } = await resolveRestoreSource(ctx, request);
  const plan = planRestore(manifest, request.selection);
  const reader = chunkReaderFor(ctx as JobContext);
  // Messages of one folder must follow each other (an MBOX file is written in one go),
  // and a person expects them in the order they arrived.
  const mail = plan.objects.filter(isMailObject).sort(compareForExport);
  const mailFolders = plan.folders.filter((folder) => mailboxAreaOf(folder) === "mail");
  const folders = mailFolders.map((folder) => exportFolderOf(folder));
  return {
    messages: mail.map((object) => exportMessageOf(object, reader)),
    folders,
    counts: {
      mail: mail.length,
      calendar: plan.events.length,
      contacts: plan.contacts.length,
      other:
        plan.objects.length -
        mail.length -
        plan.folders.length -
        plan.events.length -
        plan.contacts.length,
      folders: mailFolders.length,
    },
  };
}
