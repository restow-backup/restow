/**
 * Gmail over IMAP (Gmail, Google Workspace): one message, many folders.
 *
 * Gmail has labels, not folders. Its IMAP server shows every label as a folder
 * (INBOX, Sent Mail, Starred, Important, Drafts, every user label) and every
 * message once more in `[Gmail]/All Mail` (SPECIAL-USE `\All`), each copy with
 * its own UID. Only Spam and Trash hold mail that All Mail does not. Reading
 * every folder therefore downloads a message once per label plus once in All
 * Mail, against a daily IMAP download cap (docs/IMAP.md "Gmail").
 *
 * The backup (./engine.ts) and the archive capture (../../archive/imap-capture.ts)
 * read bodies only from All Mail, Spam and Trash. The backup records the labels
 * of each All Mail message (X-GM-LABELS, Gmail's IMAP extension X-GM-EXT-1) as
 * metadata and keeps the label folders as structure only.
 */
import type { ImapFolderInfo } from "./types.js";

/** Gmail's own namespace; localised as `[Google Mail]` in some countries. */
export const GMAIL_PREFIX = /^\[(gmail|google mail)\](\/|$)/i;

/** Whether a folder list is Gmail's (`[Gmail]/All Mail` with the `\All` attribute). */
export function isGmailFolderList(folders: readonly ImapFolderInfo[]): boolean {
  return folders.some((folder) => folder.specialUse === "\\All" && GMAIL_PREFIX.test(folder.path));
}

export interface GmailFolders {
  /** `[Gmail]/All Mail`. */
  readonly allMail: ImapFolderInfo;
  /** Spam and Trash: the mail All Mail does not hold. */
  readonly outsideAllMail: readonly ImapFolderInfo[];
}

/**
 * All Mail and the Gmail folders outside it (Spam, Trash; Trash is "Bin" or
 * "Papierkorb" in some locales), from the selectable folders of a list
 * {@link isGmailFolderList} recognised; null when it has no All Mail folder.
 */
export function gmailMessageFolders(selectable: readonly ImapFolderInfo[]): GmailFolders | null {
  const allMail = selectable.find(
    (folder) => folder.specialUse === "\\All" || /\/all mail$/i.test(folder.path),
  );
  if (!allMail) {
    return null;
  }
  const outsideAllMail = selectable.filter(
    (folder) =>
      folder !== allMail &&
      GMAIL_PREFIX.test(folder.path) &&
      (folder.specialUse === "\\Junk" ||
        folder.specialUse === "\\Trash" ||
        /\/(spam|trash|bin|papierkorb)$/i.test(folder.path)),
  );
  return { allMail, outsideAllMail };
}

/** Labels as stored on a message object: unique, sorted, as a JSON array. */
export function encodeGmailLabels(labels: Iterable<string>): string {
  return JSON.stringify([...new Set(labels)].sort());
}

/** Inverse of {@link encodeGmailLabels}; anything malformed reads as no labels. */
export function decodeGmailLabels(encoded: string | undefined): string[] {
  if (!encoded) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(encoded);
    return Array.isArray(parsed)
      ? parsed.filter((label): label is string => typeof label === "string")
      : [];
  } catch {
    return [];
  }
}
