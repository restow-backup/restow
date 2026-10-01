import type { ManifestObjectKind, ManifestObjectRow } from "@restow/db";

/**
 * Pure helpers for the snapshot explorer: path handling, the entry DTO the
 * explorer renders, mail metadata extraction and version-history collapsing.
 * Nothing here touches the database, so all of it is unit-tested with fixtures.
 */

/** Strip surrounding slashes; "" is the root. */
export function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/** The directory part of a logical path ("" for top-level entries). */
export function parentPathOf(path: string): string {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash);
}

/** The last segment of a logical path. */
export function baseNameOf(path: string): string {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

/** `parent/name`, or just `name` below the root. */
export function joinPath(parent: string, name: string): string {
  const base = normalizePath(parent);
  return base.length === 0 ? name : `${base}/${name}`;
}

export interface BreadcrumbSegment {
  name: string;
  path: string;
}

/** "Inbox/Projects/2024" -> [Inbox, Inbox/Projects, Inbox/Projects/2024]. */
export function breadcrumbOf(path: string): BreadcrumbSegment[] {
  const normalized = normalizePath(path);
  if (normalized.length === 0) {
    return [];
  }
  const segments: BreadcrumbSegment[] = [];
  let current = "";
  for (const name of normalized.split("/")) {
    current = joinPath(current, name);
    segments.push({ name, path: current });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Namespaces the explorer does not browse into
// ---------------------------------------------------------------------------

/**
 * OneDrive keeps earlier file versions as `<file path>:versions/<version id>`
 * (packages/core backup/onedrive/items.ts). They belong to the file's version
 * panel, not to the folder tree; `:` cannot occur in a OneDrive name, so the
 * marker is unambiguous.
 */
export const NATIVE_VERSION_MARKER = ":versions/";

export function isNativeVersionPath(path: string): boolean {
  return path.includes(NATIVE_VERSION_MARKER);
}

/** The parent path under which a file's native versions are stored. */
export function nativeVersionsParent(filePath: string): string {
  return `${normalizePath(filePath)}${NATIVE_VERSION_MARKER.slice(0, -1)}`;
}

/**
 * Attachments of oversized (JSON-format) Exchange messages carry the path of
 * their message in `metadata.messagePath`. They are restored together with
 * the message and never browsed on their own.
 */
export const ATTACHMENT_PARENT_KEY = "messagePath";

// ---------------------------------------------------------------------------
// Mail metadata
// ---------------------------------------------------------------------------

/**
 * Mail metadata as the explorer shows it. The backup engines record source
 * metadata as free-form strings (ManifestObject.metadata); the keys below are
 * the ones the Graph and IMAP engines use, read tolerantly so an engine that
 * names a field differently degrades to "unknown" instead of breaking the list.
 *
 * `to` and `cc` are "Display Name <address>" (or the bare address), comma
 * separated, capped at 20 entries by the engines; `toCount`/`ccCount` carry
 * the full totals for mailboxes with more recipients than that. `protection`
 * is set by the backup engines when they can tell a message is rights- or
 * S/MIME-protected without opening it; the preview (routes.ts) also detects
 * it from the message itself, for restore points recorded before this field
 * existed.
 */
export interface MailSummary {
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  /** Full recipient counts behind the capped `to`/`cc` strings. */
  toCount: number | null;
  ccCount: number | null;
  /** ISO-8601 receive/sent time, when the metadata carries one (sort/display default). */
  date: string | null;
  /** ISO-8601 send time (IMAP envelope date), next to Exchange's receivedDateTime. */
  sentDateTime: string | null;
  hasAttachments: boolean | null;
  isRead: boolean | null;
  flagged: boolean | null;
  protection: MailProtection | null;
}

/** How a message is protected against being read by anyone but its recipient. */
export type MailProtection = "rights-protected" | "smime-encrypted";

function isMailProtection(value: unknown): value is MailProtection {
  return value === "rights-protected" || value === "smime-encrypted";
}

function pickString(metadata: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function pickBoolean(metadata: Record<string, unknown>, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (value === "true" || value === "false") {
      return value === "true";
    }
  }
  return null;
}

/** A count stored as a decimal string (`toCount`, `ccCount`); tolerant of a plain number too. */
function pickCount(metadata: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      return Number(value);
    }
  }
  return null;
}

/** IMAP keeps flags as a JSON array or a space-separated list. */
function imapFlags(metadata: Record<string, unknown>): string[] | null {
  const raw = metadata.flags;
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((flag): flag is string => typeof flag === "string");
    }
  } catch {
    // Not JSON: the whitespace form.
  }
  return raw.split(/\s+/).filter((flag) => flag.length > 0);
}

export function mailSummaryOf(metadata: Record<string, unknown> | null | undefined): MailSummary {
  const source = metadata ?? {};
  const flags = imapFlags(source)?.map((flag) => flag.toLowerCase()) ?? null;
  const flagStatus = pickString(source, ["flagStatus"]);
  const protection = pickString(source, ["protection"]);
  return {
    subject: pickString(source, ["subject"]),
    from: pickString(source, ["from", "sender", "fromAddress"]),
    to: pickString(source, ["to", "toRecipients", "recipients"]),
    cc: pickString(source, ["cc", "ccRecipients"]),
    toCount: pickCount(source, ["toCount"]),
    ccCount: pickCount(source, ["ccCount"]),
    date: pickString(source, [
      "receivedDateTime",
      "receivedAt",
      "internalDate",
      "sentDateTime",
      "date",
    ]),
    sentDateTime: pickString(source, ["sentDateTime"]),
    hasAttachments: pickBoolean(source, ["hasAttachments"]),
    isRead: pickBoolean(source, ["isRead"]) ?? (flags ? flags.includes("\\seen") : null),
    flagged: flagStatus ? flagStatus === "flagged" : flags ? flags.includes("\\flagged") : null,
    protection: isMailProtection(protection) ? protection : null,
  };
}

/**
 * "Name <a@x>, Name2 <b@x>" -> the individual entries, trimmed; "" -> [].
 *
 * Splits only on commas outside a double-quoted display name, honouring a
 * backslash escape inside the quotes. The backup engines quote a display
 * name that itself contains a comma (`packages/core/src/backup/imap/
 * imapflow-connector.ts` and `.../exchange/mail.ts`, both `quoteDisplayName`:
 * `"Last, First" <addr>`, with `\` and `"` backslash-escaped) precisely so
 * this split stays unambiguous; a plain `split(",")` would break a very
 * common German directory name like "Flores, Lucas" into two bogus entries.
 */
export function splitAddressList(value: string | null): string[] {
  if (!value) {
    return [];
  }
  const entries: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (inQuotes) {
      current += char;
      if (char === "\\" && i + 1 < value.length) {
        // Consume the escaped character verbatim (a `\"` must not end the
        // quoted name early, and a `\\` must not be reinterpreted).
        i += 1;
        current += value[i];
        continue;
      }
      if (char === '"') {
        inQuotes = false;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      current += char;
      continue;
    }
    if (char === ",") {
      entries.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  entries.push(current.trim());
  return entries.filter((part) => part.length > 0);
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** One row of the explorer list. */
export interface TreeEntryDto {
  /** Manifest row id; `folder:<path>` for folders that exist only through their contents. */
  id: string;
  kind: ManifestObjectKind;
  name: string;
  path: string;
  parentPath: string;
  size: number;
  /** ISO-8601 last-modified time, or null when the source did not report one. */
  mtime: string | null;
  itemId: string | null;
  /** The source had removed this object by the time of the snapshot. */
  deleted: boolean;
  /**
   * A folder without a manifest row of its own (an area root such as `mail`,
   * or a parent the source never reported). It browses and restores like any
   * other folder.
   */
  implicit: boolean;
  /** Present for mail items only. */
  mail: MailSummary | null;
  /** Content type hint the UI may show; never secrets. */
  contentType: string | null;
}

export type EntryRow = Pick<
  ManifestObjectRow,
  | "id"
  | "kind"
  | "name"
  | "path"
  | "parentPath"
  | "size"
  | "mtime"
  | "itemId"
  | "deleted"
  | "metadata"
> & { implicit?: boolean };

export function implicitFolderId(path: string): string {
  return `folder:${path}`;
}

export function toTreeEntry(row: EntryRow): TreeEntryDto {
  const metadata = row.metadata ?? null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    parentPath: row.parentPath,
    size: row.size,
    mtime: row.mtime ? row.mtime.toISOString() : null,
    itemId: row.itemId,
    deleted: row.deleted,
    implicit: row.implicit === true,
    mail: row.kind === "mail" ? mailSummaryOf(metadata) : null,
    contentType: metadata ? pickString(metadata, ["contentType", "mimeType"]) : null,
  };
}

/**
 * A mail entry's own recorded date (`mail.date`, already coalesced by
 * {@link mailSummaryOf}), falling back to its `mtime` when the metadata carries
 * no date of its own; null for anything that is not mail. Mirrors the SQL
 * listing order's `mailDateExpression` (service.ts) so the tree's default sort
 * and this in-memory order (used for search hits) agree: `mtime` alone is the
 * wrong signal for Exchange mail, whose `mtime` is `lastModifiedDateTime`, not
 * the receive time (a read-flag or category change bumps it independently).
 */
function mailDateOf(entry: TreeEntryDto): string | null {
  return entry.kind === "mail" ? (entry.mail?.date ?? entry.mtime) : null;
}

/**
 * The explorer order, identical to the ORDER BY of the tree query: folders
 * first, then dated mail newest first (by {@link mailDateOf}), then everything
 * else by name (case-insensitive, natural numbers).
 */
export function compareEntries(a: TreeEntryDto, b: TreeEntryDto): number {
  const folderRank = (entry: TreeEntryDto) => (entry.kind === "folder" ? 0 : 1);
  const byFolder = folderRank(a) - folderRank(b);
  if (byFolder !== 0) {
    return byFolder;
  }
  const dateA = mailDateOf(a);
  const dateB = mailDateOf(b);
  if ((dateA !== null) !== (dateB !== null)) {
    return dateA !== null ? -1 : 1;
  }
  if (dateA !== null && dateB !== null && dateA !== dateB) {
    // Compare the actual instant, not the two strings: the metadata's date
    // formats can differ (a "Z" suffix vs. an explicit "+02:00" offset, or a
    // different sub-second precision) between the Graph and IMAP engines, and
    // a lexical compare of those strings does not agree with time order.
    const timeA = Date.parse(dateA);
    const timeB = Date.parse(dateB);
    const bothValid = !Number.isNaN(timeA) && !Number.isNaN(timeB);
    if (bothValid && timeA !== timeB) {
      return timeB - timeA;
    }
    if (!bothValid) {
      return dateB.localeCompare(dateA);
    }
    // Same instant, different formatting: fall through to the name/path
    // tiebreak below instead of an arbitrary string order.
  }
  const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return byName !== 0 ? byName : a.path.localeCompare(b.path);
}

export function sortEntries(entries: readonly TreeEntryDto[]): TreeEntryDto[] {
  return [...entries].sort(compareEntries);
}

// ---------------------------------------------------------------------------
// Version history across snapshots
// ---------------------------------------------------------------------------

/** A path's state in one snapshot (before collapsing). */
export interface VersionRow {
  objectId: string;
  snapshotId: string;
  sequence: number;
  /** ISO-8601 snapshot completion time. */
  snapshotAt: string | null;
  path: string;
  name: string;
  kind: ManifestObjectKind;
  size: number;
  mtime: string | null;
  itemId: string | null;
  deleted: boolean;
  /** Content fingerprint used to tell versions apart (sha256, chunks, etag or size+mtime). */
  fingerprint: string;
}

/** A distinct version: the same content seen in one or more consecutive snapshots. */
export interface VersionDto {
  /** Manifest object id in the newest snapshot that carries this version. */
  objectId: string;
  snapshotId: string;
  sequence: number;
  snapshotAt: string | null;
  /** Oldest snapshot (by sequence) in which this exact content was seen. */
  firstSeenSequence: number;
  firstSeenAt: string | null;
  snapshotCount: number;
  path: string;
  name: string;
  kind: ManifestObjectKind;
  size: number;
  mtime: string | null;
  itemId: string | null;
  deleted: boolean;
}

/** Stable fingerprint of an object's content, from the strongest evidence available. */
export function fingerprintOf(
  row: Pick<ManifestObjectRow, "size" | "mtime" | "chunkRefs" | "metadata" | "deleted">,
): string {
  if (row.deleted) {
    return "deleted";
  }
  const metadata = row.metadata ?? {};
  const sha = metadata.sha256;
  if (typeof sha === "string" && sha.length > 0) {
    return `sha256:${sha}`;
  }
  if (row.chunkRefs && row.chunkRefs.length > 0) {
    return `chunks:${row.chunkRefs.join(",")}`;
  }
  const etag = metadata.etag ?? metadata.cTag;
  if (typeof etag === "string" && etag.length > 0) {
    return `etag:${etag}`;
  }
  return `stat:${row.size}:${row.mtime ? row.mtime.getTime() : 0}`;
}

/**
 * Collapse per-snapshot rows into distinct versions (newest first):
 * consecutive snapshots with the same fingerprint are one version, so a file
 * that never changed across 90 daily snapshots shows as one entry seen 90
 * times.
 */
export function collapseVersions(rows: readonly VersionRow[]): VersionDto[] {
  const ordered = [...rows].sort((a, b) => b.sequence - a.sequence);
  const versions: VersionDto[] = [];
  let open: { version: VersionDto; fingerprint: string } | null = null;

  for (const row of ordered) {
    if (open && open.fingerprint === row.fingerprint) {
      open.version.firstSeenSequence = row.sequence;
      open.version.firstSeenAt = row.snapshotAt;
      open.version.snapshotCount += 1;
      continue;
    }
    const version: VersionDto = {
      objectId: row.objectId,
      snapshotId: row.snapshotId,
      sequence: row.sequence,
      snapshotAt: row.snapshotAt,
      firstSeenSequence: row.sequence,
      firstSeenAt: row.snapshotAt,
      snapshotCount: 1,
      path: row.path,
      name: row.name,
      kind: row.kind,
      size: row.size,
      mtime: row.mtime,
      itemId: row.itemId,
      deleted: row.deleted,
    };
    versions.push(version);
    open = { version, fingerprint: row.fingerprint };
  }
  return versions;
}

// ---------------------------------------------------------------------------
// Versions kept by the source (OneDrive)
// ---------------------------------------------------------------------------

/** An earlier version the source itself kept, captured inside one snapshot. */
export interface StoredVersionDto {
  /** Path of the version object (`<file>:versions/<id>`); restorable like any item. */
  path: string;
  versionId: string;
  size: number;
  /** ISO-8601 time the version was last modified at the source. */
  modifiedAt: string | null;
  modifiedBy: string | null;
}

type StoredVersionRow = Pick<ManifestObjectRow, "path" | "name" | "size" | "mtime" | "metadata">;

export function toStoredVersion(row: StoredVersionRow): StoredVersionDto {
  const metadata = row.metadata ?? {};
  return {
    path: row.path,
    versionId: pickString(metadata, ["versionId"]) ?? row.name,
    size: row.size,
    modifiedAt:
      pickString(metadata, ["lastModifiedDateTime"]) ??
      (row.mtime ? row.mtime.toISOString() : null),
    modifiedBy: pickString(metadata, ["lastModifiedBy"]),
  };
}

/** Escape `%`, `_` and `\` so user input is matched literally by ILIKE. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (match) => `\\${match}`);
}
