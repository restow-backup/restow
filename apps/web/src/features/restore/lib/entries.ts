import type { EntryKind, ObjectKind, TreeEntry } from "@/features/restore/api";
import { baseNameOf, parentPathOf } from "@/features/restore/lib/paths";

/**
 * How explorer entries are presented. Backup paths are made to be unique and
 * path-safe (an Exchange item is `<Subject>.<id digest>.eml`), which is right
 * for storage but not what a person should read; these helpers turn an entry
 * back into the name the user knows.
 */

export interface NamedEntry {
  kind: EntryKind;
  path: string;
  /** Mail subject when known. */
  subject?: string | null;
}

/** `<name>.<16 hex digest>.<eml|json>`, the Exchange item layout (packages/core backup/exchange/paths.ts). */
const EXCHANGE_ITEM = /^(.+)\.[0-9a-f]{16}\.(?:eml|json)$/;

/** The readable name of an entry: the mail subject, the item name without its digest, or the file name. */
export function displayName(entry: NamedEntry): string {
  const subject = entry.subject?.trim();
  if (entry.kind === "mail" && subject) {
    return subject;
  }
  const name = baseNameOf(entry.path);
  if (entry.kind === "mail" || entry.kind === "event" || entry.kind === "contact") {
    const match = EXCHANGE_ITEM.exec(name);
    if (match?.[1]) {
      return match[1];
    }
  }
  return name;
}

/** The three areas at the root of a mailbox snapshot (and `mail` for IMAP). */
export const MAILBOX_AREAS = ["mail", "calendar", "contacts"] as const;
export type MailboxArea = (typeof MAILBOX_AREAS)[number];

/** The mailbox area a root folder stands for, so its label can be translated. */
export function areaOf(
  entry: Pick<NamedEntry, "kind" | "path">,
  objectKind: ObjectKind,
): MailboxArea | null {
  if (objectKind === "onedrive" || entry.kind !== "folder" || parentPathOf(entry.path) !== "") {
    return null;
  }
  const name = baseNameOf(entry.path);
  return (MAILBOX_AREAS as readonly string[]).includes(name) ? (name as MailboxArea) : null;
}

/** The time that describes an entry best: when a mail arrived, else when it last changed. */
export function entryDate(entry: Pick<TreeEntry, "mail" | "mtime">): string | null {
  return entry.mail?.date ?? entry.mtime;
}

export function toNamedEntry(entry: Pick<TreeEntry, "kind" | "path" | "mail">): NamedEntry {
  return { kind: entry.kind, path: entry.path, subject: entry.mail?.subject ?? null };
}
