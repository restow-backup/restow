/**
 * Object paths of an Exchange mailbox snapshot.
 *
 * A manifest is keyed by path, and the restore explorer browses it by
 * `parentPath`, so paths mirror what the user sees in Outlook:
 *
 *   mail/<Folder>/<Sub folder>/<Subject>.<id>.eml        message (MIME)
 *   mail/<Folder>/<Subject>.<id>.json                     oversized message (Graph JSON)
 *   mail/<Folder>/<Subject>.<id>.attachments/<name>.<id>  its attachments
 *   calendar/<Calendar>/<Subject>.<id>.json               event (master with exceptions)
 *   contacts/<Folder>/<Display name>.<id>.json            contact
 *
 * Display names are user input: they may contain slashes, control characters
 * or nothing at all, and two siblings may share a name. Every segment is
 * sanitised and every item name carries a short digest of its Graph id, which
 * keeps paths unique without leaking the (very long) ids into the tree.
 *
 * Separately from the object path, every item records its folder as the user
 * named it (`folderPath` metadata, relative to its area, see
 * restore/conventions.ts). That is what a restore recreates in the mailbox, so
 * it keeps names as close to the original as a `/`-separated path allows.
 */
import { createHash } from "node:crypto";

export const MAIL_ROOT = "mail";
export const CALENDAR_ROOT = "calendar";
export const CONTACTS_ROOT = "contacts";

export const NO_SUBJECT = "(no subject)";
export const UNNAMED = "(unnamed)";

/** Longest sanitised segment; longer names are cut, uniqueness comes from the id digest. */
export const MAX_SEGMENT_LENGTH = 120;

/** Hex characters of the id digest in item names (64 bits). */
const ITEM_DIGEST_LENGTH = 16;
/** Hex characters appended to a folder name that collides with a sibling. */
const FOLDER_DIGEST_LENGTH = 8;

/** Slash-like characters become U+2215 so a name stays readable but never splits a path. */
const SLASH = /[/\\]/g;
const DIVISION_SLASH = "∕";
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is stripped here
const CONTROL = /[\u0000-\u001f\u007f]/g;
const WHITESPACE = /\s+/g;

/** A short, stable digest of a Graph id (which is long and not path-safe). */
export function shortId(id: string, length = ITEM_DIGEST_LENGTH): string {
  return createHash("sha256").update(id, "utf8").digest("hex").slice(0, length);
}

/**
 * Whitespace runs (tabs and line breaks included) become one space, other
 * control characters go, slashes are replaced. Whitespace is collapsed first
 * so a tab or newline between two words keeps them apart.
 */
function cleanName(name: string | null | undefined): string {
  return (name ?? "")
    .replace(WHITESPACE, " ")
    .replace(CONTROL, "")
    .replace(SLASH, DIVISION_SLASH)
    .trim();
}

/** Make a display name safe as one object path segment; `fallback` when nothing is left. */
export function sanitizeSegment(name: string | null | undefined, fallback: string): string {
  // Leading dots would produce `.`/`..` segments or hidden files in a download restore.
  const cleaned = cleanName(name).replace(/^\.+/, "").trim();
  if (cleaned.length === 0) {
    return fallback;
  }
  return cleaned.length > MAX_SEGMENT_LENGTH
    ? cleaned.slice(0, MAX_SEGMENT_LENGTH).trimEnd()
    : cleaned;
}

/**
 * The `folderPath` metadata of an item: the folder names from its area root
 * down, as the user named them (only slashes and control characters are
 * replaced). An empty list is the area root itself, e.g. the default contacts
 * folder, and yields `""`.
 */
export function displayFolderPath(names: readonly string[]): string {
  return names.map((name) => cleanName(name) || UNNAMED).join("/");
}

export function joinPath(...segments: string[]): string {
  return segments.filter((segment) => segment.length > 0).join("/");
}

/** Move a path from one folder prefix to another; returns the path unchanged when it is outside `from`. */
export function rebasePath(path: string, from: string, to: string): string {
  if (path === from) {
    return to;
  }
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

/** `<name>.<digest>` for an item inside a folder. */
export function itemName(
  displayName: string | null | undefined,
  id: string,
  fallback: string,
): string {
  return `${sanitizeSegment(displayName, fallback)}.${shortId(id)}`;
}

/** Path of a message stored as MIME. */
export function mailObjectPath(
  folderPath: string,
  subject: string | null | undefined,
  id: string,
): string {
  return `${joinPath(folderPath, itemName(subject, id, NO_SUBJECT))}.eml`;
}

/** Path of a message stored as Graph JSON (its MIME export was refused). */
export function mailJsonObjectPath(
  folderPath: string,
  subject: string | null | undefined,
  id: string,
): string {
  return `${joinPath(folderPath, itemName(subject, id, NO_SUBJECT))}.json`;
}

/** Folder that holds the attachments of a message stored as JSON. */
export function attachmentsFolderPath(
  folderPath: string,
  subject: string | null | undefined,
  id: string,
): string {
  return `${joinPath(folderPath, itemName(subject, id, NO_SUBJECT))}.attachments`;
}

/** The attachments folder that belongs to a JSON message object path. */
export function attachmentsFolderOf(messageJsonPath: string): string {
  return `${messageJsonPath.replace(/\.json$/, "")}.attachments`;
}

export function attachmentObjectPath(
  attachmentsFolder: string,
  name: string | null | undefined,
  attachmentId: string,
): string {
  return joinPath(attachmentsFolder, itemName(name, attachmentId, UNNAMED));
}

export function eventObjectPath(
  calendarPath: string,
  subject: string | null | undefined,
  id: string,
): string {
  return `${joinPath(calendarPath, itemName(subject, id, NO_SUBJECT))}.json`;
}

export function contactObjectPath(
  folderPath: string,
  displayName: string | null | undefined,
  id: string,
): string {
  return `${joinPath(folderPath, itemName(displayName, id, UNNAMED))}.json`;
}

/**
 * Assign a unique path to each folder-like node under `root`. Nodes must be
 * ordered parents first (the Graph resource helpers yield them breadth or depth
 * first, both satisfy this). A node whose parent is unknown hangs off the root.
 * A name that collides with a sibling gets a digest suffix so the two never
 * merge into one path.
 */
export function assignFolderPaths<T extends { id: string; parentId: string | null; name: string }>(
  root: string,
  nodes: readonly T[],
): Map<string, string> {
  const paths = new Map<string, string>();
  const taken = new Set<string>([root]);
  for (const node of nodes) {
    const parent = (node.parentId !== null && paths.get(node.parentId)) || root;
    let candidate = joinPath(parent, sanitizeSegment(node.name, UNNAMED));
    if (taken.has(candidate)) {
      candidate = `${candidate}.${shortId(node.id, FOLDER_DIGEST_LENGTH)}`;
    }
    taken.add(candidate);
    paths.set(node.id, candidate);
  }
  return paths;
}
