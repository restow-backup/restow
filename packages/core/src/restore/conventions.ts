/**
 * What a restore expects to find in a snapshot manifest.
 *
 * The backup engines write manifests, the restore engines read them; this
 * module is the shared vocabulary between the two so neither has to import
 * the other. Everything here is tolerant on purpose: a missing metadata key
 * falls back to what the object's path says, an unknown value is ignored, and
 * a manifest written by an older engine still restores.
 *
 * Object types (`ManifestObject.type`):
 *   "mail" | "message"  RFC 5322 bytes of one message (Exchange MIME export or
 *                       IMAP `BODY.PEEK[]`), or Graph message JSON when
 *                       `metadata.format` is "parts" (or "json"): the
 *                       oversized-message fallback of docs/MICROSOFT.md.
 *   "attachment"        One attachment of a "parts" message.
 *   "event"             Graph event JSON: `{ event, exceptions }` or a bare event.
 *   "contact"           Graph contact JSON.
 *   "file"              OneDrive file bytes (also the default for untyped objects).
 *   "file-version"      A historical OneDrive file version at `<file>:versions/<id>`.
 *   "folder"            A folder without chunks (kept so empty folders restore).
 *   "package"           OneNote notebook and similar: recorded, no content.
 *   "shortcut"          Shortcut to an item in another drive: recorded, no content.
 *
 * Path layout (logical path within the source, `/`-separated):
 *   mailbox   mail/<folders>/<item>, calendar/<calendar>/<item>, contacts/<folders>/<item>
 *   onedrive  <folders>/<file name>, relative to the drive root
 *   imap      mail/<mailbox components>/<uid>.eml, `/` and `%` percent-escaped
 *
 * Metadata keys (`ManifestObject.metadata`, all values strings):
 *   Mail and folders (Exchange)
 *     messageId          RFC 5322 Message-ID (also read as internetMessageId)
 *     folderPath         the folder's display names from the area root down
 *                        (`Inbox/Projects`; "" = the area root). On a folder
 *                        object: the folder itself. Default: the object's
 *                        parent path without the area root.
 *     wellKnownFolder    Graph well-known name (inbox, sentitems, ...) of the
 *                        first segment of folderPath
 *     isRead             "true" | "false"
 *     flagStatus         notFlagged | flagged | complete
 *     categories         JSON array (or whitespace list) of category names
 *     importance         low | normal | high
 *     format             "mime" (default) | "json" ("parts" is read as "json")
 *     referenceAttachments  JSON message: JSON array of link attachment names
 *     folderKind         folder objects: mail | calendar | contacts | attachments | root
 *   Attachments (of "json" messages)
 *     messagePath        path of the message it belongs to (or messageItemId: its id)
 *     name, contentType  file name and MIME type
 *     attachmentType     Graph `@odata.type` (file or item attachment)
 *     isInline, contentId  inline attachment facts
 *   Calendar and contacts
 *     calendarId         events and calendar folder objects
 *     calendarName       display name of the calendar (events and calendar folders)
 *     isDefaultCalendar  "true" for the default calendar (events and calendar folders)
 *     folderPath         contacts: folder names below the default folder ("" = default)
 *     isDefault          contact folder object: "true" for the default contacts folder
 *   OneDrive
 *     createdDateTime, lastModifiedDateTime  ISO 8601 (default: mtime)
 *     contentType        MIME type
 *     quickXorHash       hash OneDrive reported at backup time
 *     stale              "true" when the bytes are the last good copy of a changed file
 *     versionId          file-version: the OneDrive version id
 *     packageType        folder: a package (OneNote notebook) whose files lie below it
 *   IMAP
 *     mailbox            the mailbox path exactly as the server names it
 *     delimiter          the server's hierarchy delimiter
 *     specialUse         SPECIAL-USE of the mailbox (\Sent, \Trash, ...)
 *     flags              space-separated flags (or a JSON array)
 *     internalDate       ISO 8601 internal date (default: mtime)
 */
import type { FollowupFlag, Importance } from "@microsoft/microsoft-graph-types";
import type { ManifestObject } from "../manifest.js";

// ---------------------------------------------------------------------------
// Object types

export type RestoreObjectType =
  | "mail"
  | "attachment"
  | "event"
  | "contact"
  | "file"
  | "version"
  | "folder"
  | "package"
  | "shortcut"
  | "unknown";

/** Normalise the free-form `type` of a manifest object. */
export function objectTypeOf(object: ManifestObject): RestoreObjectType {
  switch (object.type) {
    case undefined:
      return "file";
    case "mail":
    case "message":
      return "mail";
    case "file-version":
      return "version";
    case "attachment":
    case "event":
    case "contact":
    case "file":
    case "folder":
    case "package":
    case "shortcut":
      return object.type;
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Paths

/** Split a logical path into non-empty, trimmed segments. */
export function pathSegments(path: string): string[] {
  return path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** The last segment of a path (the item's own name). */
export function baseName(path: string): string {
  const segments = pathSegments(path);
  return segments[segments.length - 1] ?? "";
}

/** The three areas of a mailbox snapshot, which are also their path roots. */
export type MailboxArea = "mail" | "calendar" | "contacts";

const AREAS: readonly MailboxArea[] = ["mail", "calendar", "contacts"];

function isArea(value: string | undefined): value is MailboxArea {
  return value !== undefined && (AREAS as readonly string[]).includes(value);
}

/** Which mailbox area an object belongs to: by type, then folder kind, then path root. */
export function mailboxAreaOf(object: ManifestObject): MailboxArea {
  switch (objectTypeOf(object)) {
    case "event":
      return "calendar";
    case "contact":
      return "contacts";
    case "mail":
    case "attachment":
      return "mail";
    default: {
      const kind = object.metadata?.folderKind;
      if (isArea(kind)) {
        return kind;
      }
      const root = pathSegments(object.path)[0];
      return isArea(root) ? root : "mail";
    }
  }
}

/**
 * The folder path of an object inside its area, without the area root: the
 * recorded `folderPath` (display names), else the object path's parent (of a
 * folder object: the path itself) with the root removed.
 * `mail/Inbox/Projects/x.eml` -> `["Inbox", "Projects"]`.
 */
export function folderSegmentsOf(
  object: ManifestObject,
  area: MailboxArea = mailboxAreaOf(object),
): string[] {
  const recorded = object.metadata?.folderPath;
  if (recorded !== undefined) {
    return pathSegments(recorded);
  }
  const all = pathSegments(object.path);
  const segments = objectTypeOf(object) === "folder" ? all : all.slice(0, -1);
  return segments[0] === area ? segments.slice(1) : segments;
}

// ---------------------------------------------------------------------------
// Mail

export type MessageFormat = "mime" | "json";

/** "mime" for RFC 5322 bytes, "json" for the Graph message JSON of the parts fallback. */
export function messageFormatOf(object: ManifestObject): MessageFormat {
  const format = object.metadata?.format;
  return format === "parts" || format === "json" ? "json" : "mime";
}

/** The RFC 5322 Message-ID recorded for a message, if any. */
export function messageIdOf(object: ManifestObject): string | undefined {
  const value = object.metadata?.messageId ?? object.metadata?.internetMessageId;
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

/** The well-known name of the first folder of an object's folder path. */
export function wellKnownFolderOf(object: ManifestObject): string | undefined {
  const value = object.metadata?.wellKnownFolder;
  return value !== undefined && value.length > 0 ? value.toLowerCase() : undefined;
}

export interface MessageFlags {
  isRead?: boolean;
  flag?: FollowupFlag;
  categories?: string[];
  importance?: Importance;
}

export function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function parseStringArray(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed as string[];
    }
  } catch {
    // Not JSON: fall through to the whitespace form.
  }
  return value.split(/\s+/).filter((entry) => entry.length > 0);
}

const FLAG_STATUSES = new Set(["notFlagged", "flagged", "complete"]);
const IMPORTANCES = new Set(["low", "normal", "high"]);

/** Flags, categories and importance that a MIME import does not carry. */
export function messageFlagsOf(object: ManifestObject): MessageFlags {
  const metadata = object.metadata ?? {};
  const flags: MessageFlags = {};
  const isRead = parseBoolean(metadata.isRead);
  if (isRead !== undefined) {
    flags.isRead = isRead;
  }
  if (metadata.flagStatus !== undefined && FLAG_STATUSES.has(metadata.flagStatus)) {
    flags.flag = { flagStatus: metadata.flagStatus as FollowupFlag["flagStatus"] };
  }
  const categories = parseStringArray(metadata.categories);
  if (categories !== undefined) {
    flags.categories = categories;
  }
  if (metadata.importance !== undefined && IMPORTANCES.has(metadata.importance)) {
    flags.importance = metadata.importance as Importance;
  }
  return flags;
}

/** Names of link attachments a JSON message had; they carry no content to restore. */
export function referenceAttachmentsOf(object: ManifestObject): string[] {
  const raw = object.metadata?.referenceAttachments;
  if (raw === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

export type AttachmentKind = "file" | "item" | "reference";

export interface AttachmentFacts {
  readonly kind: AttachmentKind;
  readonly name: string;
  readonly contentType: string | undefined;
  readonly isInline: boolean;
  readonly contentId: string | undefined;
}

function attachmentKindOf(metadata: Record<string, string>): AttachmentKind {
  const type = (metadata.attachmentType ?? "").toLowerCase();
  if (type.endsWith("referenceattachment") || metadata.format === "json") {
    return "reference";
  }
  return type.endsWith("itemattachment") ? "item" : "file";
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

export function attachmentFactsOf(object: ManifestObject): AttachmentFacts {
  const metadata = object.metadata ?? {};
  return {
    kind: attachmentKindOf(metadata),
    name: nonEmpty(metadata.name) ?? baseName(object.path),
    contentType: nonEmpty(metadata.contentType),
    isInline: parseBoolean(metadata.isInline) ?? false,
    contentId: nonEmpty(metadata.contentId),
  };
}

// ---------------------------------------------------------------------------
// Calendar

export interface CalendarFacts {
  /** Display name of the source calendar. */
  readonly name: string | undefined;
  readonly isDefault: boolean;
}

/** What an event says about its calendar on its own (the catalog knows more). */
export function calendarFactsOf(object: ManifestObject): CalendarFacts {
  const metadata = object.metadata ?? {};
  return {
    name:
      nonEmpty(metadata.calendarName) ??
      nonEmpty(metadata.name) ??
      folderSegmentsOf(object, "calendar")[0],
    isDefault: parseBoolean(metadata.isDefaultCalendar) ?? false,
  };
}

// ---------------------------------------------------------------------------
// Files

export interface FileTimestamps {
  createdDateTime?: string;
  lastModifiedDateTime: string;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined || Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  return value;
}

/** The timestamps to put back on a restored file (Graph `fileSystemInfo`). */
export function fileTimestampsOf(object: ManifestObject): FileTimestamps {
  const metadata = object.metadata ?? {};
  const created = isoOrUndefined(metadata.createdDateTime);
  const modified =
    isoOrUndefined(metadata.lastModifiedDateTime) ??
    (object.mtime > 0 ? new Date(object.mtime).toISOString() : undefined);
  return {
    ...(created !== undefined ? { createdDateTime: created } : {}),
    lastModifiedDateTime: modified ?? created ?? new Date(0).toISOString(),
  };
}

export function contentTypeOf(object: ManifestObject): string | undefined {
  return nonEmpty(object.metadata?.contentType);
}

/** Separator between a file path and its versions (`:` never occurs in OneDrive names). */
export const VERSION_PATH_MARKER = ":versions/";

export interface VersionFacts {
  /** Path of the file the version belongs to. */
  readonly filePath: string;
  readonly versionId: string;
}

export function versionFactsOf(object: ManifestObject): VersionFacts {
  const marker = object.path.indexOf(VERSION_PATH_MARKER);
  const filePath = marker === -1 ? object.path : object.path.slice(0, marker);
  const fromPath = marker === -1 ? "" : object.path.slice(marker + VERSION_PATH_MARKER.length);
  return { filePath, versionId: nonEmpty(object.metadata?.versionId) ?? fromPath };
}

/** The backup-time QuickXorHash of a file, when its bytes still belong to it. */
export function recordedQuickXorHashOf(object: ManifestObject): string | undefined {
  if (object.metadata?.stale === "true") {
    return undefined;
  }
  return nonEmpty(object.metadata?.quickXorHash);
}

// ---------------------------------------------------------------------------
// IMAP

/** IMAP flags recorded for a message (`\Seen`, `\Flagged`, custom keywords). */
export function imapFlagsOf(object: ManifestObject): string[] {
  return parseStringArray(object.metadata?.flags) ?? [];
}

/** The IMAP internal date to APPEND with. */
export function imapInternalDateOf(object: ManifestObject): Date | undefined {
  const recorded = object.metadata?.internalDate;
  if (recorded !== undefined) {
    const parsed = new Date(recorded);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return object.mtime > 0 ? new Date(object.mtime) : undefined;
}

/** Undo the percent-escaping of `/` and `%` in IMAP path components. */
export function unescapeImapComponent(component: string): string {
  return component.replace(/%2F/gi, "/").replace(/%25/g, "%");
}

/** The IMAP delimiter a snapshot recorded for an object's mailbox. */
export function imapDelimiterOf(object: ManifestObject): string | undefined {
  const delimiter = object.metadata?.delimiter;
  return delimiter !== undefined && delimiter.length > 0 ? delimiter : undefined;
}

/**
 * The hierarchy components of the mailbox an object belongs to (of a folder
 * object: of itself), outermost first: the recorded server path split on the
 * recorded delimiter, or the unescaped path below the `mail` root.
 */
export function imapMailboxComponentsOf(object: ManifestObject): string[] {
  const mailbox = nonEmpty(object.metadata?.mailbox);
  const delimiter = imapDelimiterOf(object);
  let components: string[];
  if (mailbox !== undefined) {
    components = delimiter === undefined ? [mailbox] : mailbox.split(delimiter);
  } else {
    components = folderSegmentsOf(object, "mail").map(unescapeImapComponent);
  }
  components = components.filter((component) => component.length > 0);
  if (components.length === 0) {
    return ["INBOX"];
  }
  // INBOX is case-insensitive and always spelled INBOX on the wire.
  if (components[0]?.toUpperCase() === "INBOX") {
    components[0] = "INBOX";
  }
  return components;
}

export function imapSpecialUseOf(object: ManifestObject): string | undefined {
  return nonEmpty(object.metadata?.specialUse);
}
