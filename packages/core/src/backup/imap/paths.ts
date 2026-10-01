/**
 * Logical object paths, ids and metadata keys of IMAP snapshots.
 *
 * Manifest layout for an IMAP account:
 *   mail/<folder components...>              type "folder"  (size 0, no chunks)
 *   mail/<folder components...>/<uid>.eml    type "message" (byte-exact RFC 5322)
 *
 * Folder components are the server's hierarchy split on its delimiter; a `/`
 * or `%` inside a component is percent-escaped so the logical path stays
 * unambiguous. The server-side path is kept verbatim in `metadata.mailbox`
 * (with `metadata.delimiter`), which is what a restore uses to APPEND into the
 * right mailbox. UIDs are only meaningful together with the folder's
 * UIDVALIDITY, so both are recorded on every message.
 *
 * The metadata keys follow the shared backup/restore vocabulary in
 * restore/conventions.ts (`mailbox`, `delimiter`, `flags`, `internalDate`,
 * `messageId`); the remaining keys are specific to IMAP backups. `subject`
 * through `protection` are the mail envelope contract shared with the
 * Exchange engine: the same key names, written by both engines with the same
 * meaning.
 */
import type { ManifestObject } from "../../manifest.js";
import type { ImapEnvelopeMeta, ImapFolderInfo } from "./types.js";

export const IMAP_PATH_ROOT = "mail";
export const MESSAGE_OBJECT_TYPE = "message";
export const FOLDER_OBJECT_TYPE = "folder";
const OBJECT_ID_PREFIX = "imap";

/** Metadata keys written on every IMAP manifest object. */
export const META = {
  /** The mailbox path exactly as the server names it. */
  mailbox: "mailbox",
  delimiter: "delimiter",
  specialUse: "specialUse",
  uid: "uid",
  uidValidity: "uidValidity",
  flags: "flags",
  internalDate: "internalDate",
  messageId: "messageId",
  /** RFC822.SIZE as reported by the server; `size` on the object is the real byte count. */
  reportedSize: "reportedSize",

  subject: "subject",
  /** 'Display Name <address>' or the bare address. */
  from: "from",
  /** Comma-separated, capped at 20 entries; `toCount` carries the full total. */
  to: "to",
  toCount: "toCount",
  /** Comma-separated, capped at 20 entries; `ccCount` carries the full total. */
  cc: "cc",
  ccCount: "ccCount",
  hasAttachments: "hasAttachments",
  /** ISO 8601 envelope date (Date:), next to the existing `internalDate`. */
  sentDateTime: "sentDateTime",
  /** "rights-protected" (IRM/Purview) or "smime-encrypted" (S/MIME enveloped data); absent otherwise. */
  protection: "protection",
} as const;

/** Formatted address lists are capped here; the *Count metadata carries the full total. */
const MAX_ADDRESS_LIST_ENTRIES = 20;

export function escapeComponent(component: string): string {
  return component.replace(/%/g, "%25").replace(/\//g, "%2F");
}

export function unescapeComponent(component: string): string {
  return component.replace(/%2F/gi, "/").replace(/%25/g, "%");
}

/** Hierarchy components of a folder, outermost first. */
export function folderComponents(folder: Pick<ImapFolderInfo, "name" | "parent">): string[] {
  return [...folder.parent, folder.name];
}

export function folderObjectPath(components: readonly string[]): string {
  return [IMAP_PATH_ROOT, ...components.map(escapeComponent)].join("/");
}

export function messageObjectPath(components: readonly string[], uid: number): string {
  return `${folderObjectPath(components)}/${uid}.eml`;
}

/** Stable source id of a message: folder, UIDVALIDITY and UID. */
export function messageObjectId(folderPath: string, uidValidity: string, uid: number): string {
  return `${OBJECT_ID_PREFIX}:${folderPath}:${uidValidity}:${uid}`;
}

export function folderObjectId(folderPath: string, uidValidity: string): string {
  return `${OBJECT_ID_PREFIX}:${folderPath}:${uidValidity}`;
}

export interface ParsedMessageObjectId {
  readonly folderPath: string;
  readonly uidValidity: string;
  readonly uid: number;
}

/** Inverse of {@link messageObjectId}; folder paths may contain ":" so the id is parsed from the right. */
export function parseMessageObjectId(id: string): ParsedMessageObjectId | null {
  if (!id.startsWith(`${OBJECT_ID_PREFIX}:`)) {
    return null;
  }
  const body = id.slice(OBJECT_ID_PREFIX.length + 1);
  const lastColon = body.lastIndexOf(":");
  const secondLastColon = lastColon > 0 ? body.lastIndexOf(":", lastColon - 1) : -1;
  if (lastColon <= 0 || secondLastColon <= 0) {
    return null;
  }
  const uid = Number(body.slice(lastColon + 1));
  const uidValidity = body.slice(secondLastColon + 1, lastColon);
  const folderPath = body.slice(0, secondLastColon);
  if (!Number.isInteger(uid) || uid <= 0 || !/^\d+$/.test(uidValidity) || folderPath === "") {
    return null;
  }
  return { folderPath, uidValidity, uid };
}

/** Flags are stored sorted and space-separated (IMAP flags never contain whitespace). */
export function encodeFlags(flags: Iterable<string>): string {
  return [...new Set(flags)].sort().join(" ");
}

export function decodeFlags(encoded: string | undefined): string[] {
  if (!encoded) {
    return [];
  }
  return encoded.split(" ").filter((flag) => flag.length > 0);
}

/** The UID recorded on a message object, or null when the object is not an IMAP message. */
export function objectUid(object: ManifestObject): number | null {
  const raw = object.metadata?.[META.uid];
  if (raw === undefined) {
    return null;
  }
  const uid = Number(raw);
  return Number.isInteger(uid) && uid > 0 ? uid : null;
}

/** The server-side mailbox an IMAP object belongs to, or undefined for foreign objects. */
export function objectMailbox(object: ManifestObject): string | undefined {
  return object.metadata?.[META.mailbox];
}

export function isMessageObject(object: ManifestObject): boolean {
  return object.type === MESSAGE_OBJECT_TYPE && objectMailbox(object) !== undefined;
}

/** Metadata for a message's envelope; `to`/`cc` are capped at {@link MAX_ADDRESS_LIST_ENTRIES}. */
export function encodeEnvelope(envelope: ImapEnvelopeMeta): Record<string, string> {
  const metadata: Record<string, string> = {
    [META.subject]: envelope.subject,
    [META.to]: envelope.to.slice(0, MAX_ADDRESS_LIST_ENTRIES).join(", "),
    [META.toCount]: String(envelope.toCount),
    [META.cc]: envelope.cc.slice(0, MAX_ADDRESS_LIST_ENTRIES).join(", "),
    [META.ccCount]: String(envelope.ccCount),
    [META.hasAttachments]: String(envelope.hasAttachments),
  };
  if (envelope.from) {
    metadata[META.from] = envelope.from;
  }
  if (envelope.sentDateTime) {
    metadata[META.sentDateTime] = envelope.sentDateTime.toISOString();
  }
  if (envelope.protection) {
    metadata[META.protection] = envelope.protection;
  }
  return metadata;
}

/**
 * Whether a message object already carries envelope metadata. Absence is the
 * backfill signal (./engine.ts): either the object predates this metadata, or
 * an earlier attempt could not read the envelope and left the old fields only.
 */
export function hasEnvelopeMetadata(object: ManifestObject): boolean {
  return object.metadata?.[META.subject] !== undefined;
}

export function isFolderObject(object: ManifestObject): boolean {
  return object.type === FOLDER_OBJECT_TYPE && objectMailbox(object) !== undefined;
}
