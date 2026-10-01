/**
 * What the archive stores next to an imported message: envelope, subject and
 * the text the full text search reads. Parsed from the RFC 5322 bytes with
 * mailparser; never throws (an unparseable message yields empty fields, the
 * original bytes are archived regardless).
 *
 * This runs in a child process with a time and memory limit, like the metadata
 * parse (./meta-parse.ts): use `extractArchiveFields` of ./archive-fields.ts
 * outside the child. Nothing is asked of mailparser that is not used: no text to
 * HTML conversion (textAsHtml, one allocation of several times the text), no link
 * or image rewriting, no HTML to text conversion.
 */
import { simpleParser } from "mailparser";
import type { AddressObject } from "mailparser";
import type { JournalEnvelope, JournalRecipient } from "../archive/journal.js";
import { htmlToPlainText } from "./html-text.js";

/** `archive_items.body_text` is cut here; the byte-exact original stays the archival copy. */
export const ARCHIVE_BODY_TEXT_LIMIT = 200_000;

export interface ArchiveFields {
  readonly messageId: string | null;
  readonly subject: string | null;
  readonly envelope: JournalEnvelope;
  readonly bodyText: string;
  readonly hasAttachment: boolean;
  /** The Date header, if valid. */
  readonly sentAt: Date | null;
  /** True when the message could not be parsed (also in time or memory): the fields are empty. */
  readonly unavailable?: boolean;
}

function addressesOf(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) {
    return [];
  }
  const objects = Array.isArray(field) ? field : [field];
  const found: string[] = [];
  for (const object of objects) {
    for (const entry of object.value) {
      if (entry.address) {
        found.push(entry.address);
      }
      for (const member of entry.group ?? []) {
        if (member.address) {
          found.push(member.address);
        }
      }
    }
  }
  return found;
}

export const UNAVAILABLE_ARCHIVE_FIELDS: ArchiveFields = {
  messageId: null,
  subject: null,
  envelope: { sender: null, subject: null, messageId: null, onBehalfOf: null, recipients: [] },
  bodyText: "",
  hasAttachment: false,
  sentAt: null,
  unavailable: true,
};

/** Never throws; runs in the child process. */
export async function extractArchiveFieldsInProcess(raw: Buffer): Promise<ArchiveFields> {
  try {
    const mail = await simpleParser(raw, {
      skipImageLinks: true,
      skipTextToHtml: true,
      skipTextLinks: true,
      skipHtmlToText: true,
    });
    const recipients: JournalRecipient[] = [
      ...addressesOf(mail.to).map((address) => ({ address, type: "to" as const })),
      ...addressesOf(mail.cc).map((address) => ({ address, type: "cc" as const })),
      ...addressesOf(mail.bcc).map((address) => ({ address, type: "bcc" as const })),
    ];
    const messageId = mail.messageId ?? null;
    const subject = mail.subject ?? null;
    const sender = addressesOf(mail.from)[0] ?? null;
    return {
      messageId,
      subject,
      envelope: { sender, subject, messageId, onBehalfOf: null, recipients },
      bodyText: (
        mail.text || (typeof mail.html === "string" ? htmlToPlainText(mail.html) : "")
      ).slice(0, ARCHIVE_BODY_TEXT_LIMIT),
      hasAttachment: mail.attachments.some(
        (attachment) => attachment.contentDisposition !== "inline" || !attachment.related,
      ),
      sentAt: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : null,
    };
  } catch {
    return UNAVAILABLE_ARCHIVE_FIELDS;
  }
}
