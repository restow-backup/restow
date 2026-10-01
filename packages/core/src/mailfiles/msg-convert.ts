/**
 * Outlook MSG conversion: `@kenjiuno/msgreader` parses the compound file, this
 * module rebuilds RFC 5322 bytes from the MAPI properties.
 *
 * This is the code that touches hostile bytes. It runs in a child process with a
 * memory limit and a time limit (./isolate.ts, called from ./msg.ts), after the
 * structure of the compound file was checked (./cfb-guard.ts). Callers outside
 * the child use `readMsg` of ./msg.ts, not this module.
 *
 * The rebuild is deterministic: the same MSG bytes always yield the same EML
 * bytes. There is no random boundary, no "now" Date and no generated Message-ID
 * (a message without one gets none), see ./mime-writer.ts.
 *
 * What is kept:
 *   - the original transport headers, when the MSG has them (received mail
 *     does); the MIME structure headers are replaced because the body is
 *     rebuilt, everything else (Received, Return-Path, From, To, Date, ...) is
 *     written back verbatim. Without transport headers (sent items, drafts) the
 *     headers are rebuilt from the properties: From, To, Cc, Bcc, Subject, Date
 *     (the submit or delivery time), Message-ID;
 *   - plain text and HTML body, inline (cid) and regular attachments, embedded
 *     messages as message/rfc822 parts (an embedded item that is not mail stays
 *     an .msg attachment);
 *   - the read flag as `\Seen`, an unsent message as `\Draft`.
 *
 * What is not: an RTF-only body (the plain text body is used), attachments that
 * only point to a file (no content in the MSG), and anything Outlook keeps in
 * properties that have no RFC 5322 equivalent.
 */
import * as msgreaderModule from "@kenjiuno/msgreader";
import type { FieldsData } from "@kenjiuno/msgreader";
import { checkCompoundFile } from "./cfb-guard.js";
import {
  type HeaderField,
  type MimePart,
  encodeHeaderText,
  filePart,
  formatMailbox,
  headerSafe,
  messagePart,
  mimeTypeForFile,
  multipart,
  serializeMessage,
  textPart,
} from "./mime-writer.js";

type MsgReaderConstructor = typeof import("@kenjiuno/msgreader").default;

/** Embedded messages nested deeper than this stay .msg attachments (loop and bomb guard). */
const MAX_EMBEDDED_DEPTH = 6;

export type MsgReadResult =
  | {
      readonly ok: true;
      /** The rebuilt RFC 5322 message. */
      readonly raw: Buffer;
      readonly flags: readonly string[];
      readonly internalDate: Date | null;
      readonly attachmentCount: number;
    }
  | {
      readonly ok: false;
      readonly code: "not_mail" | "unreadable";
      readonly reason: string;
    };

function resolveReader(): MsgReaderConstructor {
  // CommonJS interop: under plain Node ESM the default import is the exports
  // object, under bundlers it is the class itself.
  let candidate: unknown = (msgreaderModule as unknown as { default?: unknown }).default;
  if (candidate && typeof candidate === "object" && "default" in candidate) {
    candidate = (candidate as { default: unknown }).default;
  }
  return candidate as MsgReaderConstructor;
}

// ---------------------------------------------------------------------------
// Message classes

const NON_MAIL_CLASSES: readonly { readonly pattern: RegExp; readonly kind: string }[] = [
  { pattern: /^IPM\.Contact(\.|$)/i, kind: "contact" },
  { pattern: /^IPM\.DistList(\.|$)/i, kind: "distribution list" },
  { pattern: /^IPM\.Appointment(\.|$)/i, kind: "calendar appointment" },
  { pattern: /^IPM\.OLE\.CLASS\./i, kind: "calendar appointment" },
  { pattern: /^IPM\.Task(\.|$)/i, kind: "task" },
  { pattern: /^IPM\.StickyNote(\.|$)/i, kind: "note" },
  { pattern: /^IPM\.Activity(\.|$)/i, kind: "journal entry" },
  { pattern: /^IPM\.Configuration(\.|$)/i, kind: "Outlook configuration item" },
  { pattern: /^IPM\.Rule(\.|$)/i, kind: "Outlook rule" },
];

function nonMailKind(messageClass: string): string | null {
  for (const entry of NON_MAIL_CLASSES) {
    if (entry.pattern.test(messageClass)) {
      return entry.kind;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Code pages

/** Windows ANSI code page of a locale (LCID), for the 8-bit strings of old MSG files. */
function ansiCodePageOfLocale(lcid: number | undefined): number {
  if (lcid === undefined) {
    return 1252;
  }
  const language = lcid & 0x3ff;
  switch (language) {
    case 0x11:
      return 932;
    case 0x04:
      return lcid === 0x0404 || lcid === 0x0c04 || lcid === 0x1404 ? 950 : 936;
    case 0x12:
      return 949;
    case 0x1e:
      return 874;
    case 0x2a:
      return 1258;
    case 0x05:
    case 0x0e:
    case 0x15:
    case 0x18:
    case 0x1b:
    case 0x24:
    case 0x1c:
      return 1250;
    case 0x1a:
      return lcid === 0x0c1a || lcid === 0x1c1a || lcid === 0x281a ? 1251 : 1250;
    case 0x19:
    case 0x02:
    case 0x22:
    case 0x23:
    case 0x2f:
    case 0x3f:
    case 0x28:
      return 1251;
    case 0x08:
      return 1253;
    case 0x1f:
    case 0x2c:
      return 1254;
    case 0x0d:
      return 1255;
    case 0x01:
    case 0x29:
    case 0x20:
      return 1256;
    case 0x25:
    case 0x26:
    case 0x27:
      return 1257;
    default:
      return 1252;
  }
}

const SUPPORTED_ANSI_PAGES = new Set([
  874, 932, 936, 949, 950, 1250, 1251, 1253, 1254, 1255, 1256, 1257, 1258,
]);

/** TextDecoder label for a Windows or ISO code page number. */
function decoderLabel(codePage: number | undefined): string {
  switch (codePage) {
    case 65001:
      return "utf-8";
    case 1200:
      return "utf-16le";
    case 1201:
      return "utf-16be";
    case 932:
    case 50221:
    case 50222:
      return codePage === 932 ? "shift_jis" : "iso-2022-jp";
    case 50220:
      return "iso-2022-jp";
    case 20932:
    case 51932:
      return "euc-jp";
    case 936:
    case 54936:
      return "gbk";
    case 949:
    case 51949:
      return "euc-kr";
    case 950:
      return "big5";
    case 20866:
      return "koi8-r";
    case 21866:
      return "koi8-u";
    case 20127:
    case undefined:
      return "windows-1252";
    default:
      if (codePage >= 1250 && codePage <= 1258) {
        return `windows-${codePage}`;
      }
      if (codePage === 874) {
        return "windows-874";
      }
      if (codePage >= 28591 && codePage <= 28599) {
        return `iso-8859-${codePage - 28590}`;
      }
      return "utf-8";
  }
}

function decodeBytes(bytes: Uint8Array, codePage: number | undefined): string {
  try {
    return new TextDecoder(decoderLabel(codePage)).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString("utf8");
  }
}

// ---------------------------------------------------------------------------
// Property helpers

const EMAIL_LIKE = /^[^@\s<>"',;]+@[^@\s<>"',;]+$/;

function clean(value: string | undefined): string {
  return (value ?? "").replace(/^['"]+|['"]+$/g, "").trim();
}

function looksLikeAddress(value: string | undefined): boolean {
  return value !== undefined && EMAIL_LIKE.test(clean(value));
}

function parseMsgDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  // A FILETIME of zero (1601) is how MAPI says "no time".
  return Number.isNaN(time) || new Date(time).getUTCFullYear() < 1970 ? null : new Date(time);
}

function rfc5322Date(date: Date): string {
  return date.toUTCString().replace(/ GMT$/, " +0000");
}

function senderMailbox(data: FieldsData): { name: string; address: string } | null {
  let address = "";
  if (data.senderSmtpAddress) {
    address = clean(data.senderSmtpAddress);
  } else if (
    looksLikeAddress(data.senderEmail) &&
    (data.senderAddressType ?? "SMTP").toUpperCase() === "SMTP"
  ) {
    address = clean(data.senderEmail);
  } else if (data.sentRepresentingSmtpAddress) {
    address = clean(data.sentRepresentingSmtpAddress);
  } else if (data.creatorSMTPAddress) {
    address = clean(data.creatorSMTPAddress);
  }
  const name = clean(data.senderName);
  if (address === "" && name === "") {
    return null;
  }
  return { name, address };
}

function recipientMailbox(recipient: FieldsData): { name: string; address: string } {
  let address = "";
  if (recipient.smtpAddress) {
    address = clean(recipient.smtpAddress);
  } else if (
    looksLikeAddress(recipient.email) &&
    (recipient.addressType ?? "SMTP").toUpperCase() === "SMTP"
  ) {
    address = clean(recipient.email);
  } else if (looksLikeAddress(recipient.name)) {
    address = clean(recipient.name);
  }
  let name = clean(recipient.name);
  if (name === address) {
    name = "";
  }
  return { name, address };
}

// ---------------------------------------------------------------------------
// Headers

/** MIME structure headers of the original message: the body is rebuilt, so they no longer apply. */
const REPLACED_HEADERS = new Set([
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
  "content-id",
  "content-description",
  "content-length",
  "content-md5",
  "lines",
]);

interface KeptHeaders {
  /** Header entries in their original order, each with its own folded lines. */
  readonly entries: readonly { readonly name: string; readonly text: string }[];
  readonly names: ReadonlySet<string>;
}

/** Keep the original transport headers verbatim, minus the MIME structure headers. */
function keepTransportHeaders(transport: string | undefined): KeptHeaders | null {
  if (!transport) {
    return null;
  }
  const lines = transport.replace(/\r\n|\r/g, "\n").split("\n");
  const entries: { name: string; text: string }[] = [];
  let current: { name: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (current && !REPLACED_HEADERS.has(current.name)) {
      entries.push({ name: current.name, text: current.lines.join("\r\n") });
    }
    current = null;
  };
  for (const line of lines) {
    if (line.length === 0) {
      if (current) {
        flush();
      }
      continue;
    }
    if ((line[0] === " " || line[0] === "\t") && current) {
      (current as { lines: string[] }).lines.push(headerSafe(line));
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0 && /^[\x21-\x39\x3b-\x7e]+$/.test(line.slice(0, colon))) {
      flush();
      current = { name: line.slice(0, colon).toLowerCase(), lines: [headerSafe(line)] };
    }
  }
  flush();
  if (entries.length === 0) {
    return null;
  }
  return { entries, names: new Set(entries.map((entry) => entry.name)) };
}

// ---------------------------------------------------------------------------
// Building the message

interface BuildContext {
  readonly Reader: MsgReaderConstructor;
  readonly depth: number;
  readonly structureCheck: boolean;
}

interface BuiltMessage {
  readonly raw: Buffer;
  readonly attachmentCount: number;
}

function openReader(
  Reader: MsgReaderConstructor,
  bytes: Uint8Array,
): InstanceType<MsgReaderConstructor> {
  return new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

function parseWithCodePage(
  Reader: MsgReaderConstructor,
  bytes: Uint8Array,
): { reader: InstanceType<MsgReaderConstructor>; data: FieldsData } {
  let reader = openReader(Reader, bytes);
  let data = reader.getFileData();
  // Old MSG files keep some strings as 8-bit text in the message's ANSI code page.
  const codePage = data.messageCodepage ?? ansiCodePageOfLocale(data.messageLocaleId);
  if (codePage !== 1252 && SUPPORTED_ANSI_PAGES.has(codePage)) {
    reader = openReader(Reader, bytes);
    reader.parserConfig = { ansiEncoding: `cp${codePage}` };
    data = reader.getFileData();
  }
  return { reader, data };
}

function embeddedFileName(
  subject: string | undefined,
  fallback: string,
  extension: string,
): string {
  const base = clean(subject) || fallback;
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

/**
 * The Content-IDs the HTML refers to (`cid:abc` in an `src`, a `url()` and the like), lower
 * case, found in one pass. Looked up once per attachment, so the cost does not grow with
 * the number of attachments times the size of the body.
 */
function collectCidReferences(html: string): Set<string> {
  const found = new Set<string>();
  const lower = html.toLowerCase();
  let position = lower.indexOf("cid:");
  while (position !== -1) {
    let end = position + 4;
    while (end < lower.length && !/[\s"'<>)]/.test(lower.charAt(end))) {
      end++;
    }
    const token = lower.slice(position + 4, end);
    found.add(token);
    // A reference closed by punctuation of the surrounding text still names the same part.
    let trimmed = token.length;
    while (trimmed > 0 && ";,.".includes(token.charAt(trimmed - 1))) {
      trimmed--;
    }
    found.add(token.slice(0, trimmed));
    position = lower.indexOf("cid:", end);
  }
  return found;
}

function buildMessage(
  reader: InstanceType<MsgReaderConstructor>,
  data: FieldsData,
  context: BuildContext,
): BuiltMessage {
  const codePage = data.internetCodepage ?? data.messageCodepage;
  const text = data.body ?? "";
  let html: string | undefined;
  if (data.bodyHtml) {
    html = data.bodyHtml;
  } else if (data.html && data.html.length > 0) {
    html = decodeBytes(data.html, codePage);
  }

  // Attachments
  let referencedCids: Set<string> | undefined;
  const cidsOf = (text: string): Set<string> => {
    if (!referencedCids) {
      referencedCids = collectCidReferences(text);
    }
    return referencedCids;
  };
  const inlineParts: MimePart[] = [];
  const attachedParts: MimePart[] = [];
  let attachmentCount = 0;
  for (const attachment of data.attachments ?? []) {
    let content: Uint8Array;
    let fileName: string;
    try {
      const loaded = reader.getAttachment(attachment);
      content = loaded.content;
      fileName = loaded.fileName;
    } catch {
      continue;
    }
    attachmentCount++;
    const name =
      clean(fileName) || clean(attachment.fileName) || clean(attachment.name) || "attachment";
    if (attachment.innerMsgContent) {
      const embedded =
        context.depth < MAX_EMBEDDED_DEPTH
          ? readMsgInternal(
              Buffer.from(content),
              context.depth + 1,
              context.Reader,
              context.structureCheck,
            )
          : null;
      if (embedded?.ok) {
        attachedParts.push(
          messagePart(embeddedFileName(attachment.name ?? name, "message", ".eml"), embedded.raw),
        );
        continue;
      }
      attachedParts.push(
        filePart({
          contentType: "application/vnd.ms-outlook",
          fileName: embeddedFileName(attachment.name ?? name, "message", ".msg"),
          disposition: "attachment",
          data: content,
        }),
      );
      continue;
    }
    const contentId = clean(attachment.pidContentId).replace(/^<|>$/g, "");
    const referenced =
      contentId !== "" && html !== undefined && cidsOf(html).has(contentId.toLowerCase());
    const part = filePart({
      contentType: clean(attachment.attachMimeTag) || mimeTypeForFile(name),
      fileName: name,
      disposition: referenced ? "inline" : "attachment",
      contentId: contentId || null,
      data: content,
    });
    (referenced ? inlineParts : attachedParts).push(part);
  }

  // Body structure
  let body: MimePart;
  if (html !== undefined) {
    const htmlPart = textPart("html", html);
    const withRelated =
      inlineParts.length > 0 ? multipart("related", [htmlPart, ...inlineParts]) : htmlPart;
    body =
      text.trim().length > 0
        ? multipart("alternative", [textPart("plain", text), withRelated])
        : withRelated;
  } else {
    body = textPart("plain", text);
    if (inlineParts.length > 0) {
      attachedParts.unshift(...inlineParts);
    }
  }
  if (attachedParts.length > 0) {
    body = multipart("mixed", [body, ...attachedParts]);
  }

  // Headers
  const kept = keepTransportHeaders(data.headers);
  const headers: HeaderField[] = [];
  const keptText: string[] = [];
  if (kept) {
    for (const entry of kept.entries) {
      keptText.push(entry.text);
    }
  }
  const has = (name: string): boolean => kept?.names.has(name) ?? false;
  const synthesized: HeaderField[] = [];
  if (!has("from")) {
    const sender = senderMailbox(data);
    if (sender) {
      synthesized.push(["From", formatMailbox(sender.name, sender.address)]);
    }
  }
  const byType = (type: "to" | "cc" | "bcc"): string[] =>
    (data.recipients ?? [])
      .filter((recipient) => (recipient.recipType ?? "to") === type)
      .map(recipientMailbox)
      .map((mailbox) => formatMailbox(mailbox.name, mailbox.address));
  for (const [header, type] of [
    ["To", "to"],
    ["Cc", "cc"],
    ["Bcc", "bcc"],
  ] as const) {
    if (!has(header.toLowerCase())) {
      const list = byType(type);
      if (list.length > 0) {
        synthesized.push([header, list.join(", ")]);
      }
    }
  }
  if (!has("subject") && data.subject && data.subject.length > 0) {
    synthesized.push(["Subject", encodeHeaderText(data.subject)]);
  }
  if (!has("date")) {
    const sent = parseMsgDate(data.clientSubmitTime) ?? parseMsgDate(data.messageDeliveryTime);
    if (sent) {
      synthesized.push(["Date", rfc5322Date(sent)]);
    }
  }
  if (!has("message-id") && data.messageId && data.messageId.trim().length > 0) {
    const id = headerSafe(data.messageId).trim();
    synthesized.push(["Message-ID", id.startsWith("<") ? id : `<${id}>`]);
  }
  headers.push(...synthesized);

  const structured = serializeMessage(headers, body);
  if (keptText.length === 0) {
    return { raw: structured, attachmentCount };
  }
  // Original transport headers first, then the synthesized and the MIME headers.
  const prefix = Buffer.from(`${keptText.join("\r\n")}\r\n`, "utf8");
  return { raw: Buffer.concat([prefix, structured]), attachmentCount };
}

function readMsgInternal(
  bytes: Buffer,
  depth: number,
  Reader: MsgReaderConstructor,
  structureCheck: boolean,
): MsgReadResult {
  if (structureCheck) {
    const structure = checkCompoundFile(bytes);
    if (!structure.ok) {
      return {
        ok: false,
        code: "unreadable",
        reason: `The MSG file is damaged (${structure.detail}) and was not read.`,
      };
    }
  }
  let parsed: { reader: InstanceType<MsgReaderConstructor>; data: FieldsData };
  try {
    parsed = parseWithCodePage(Reader, bytes);
  } catch {
    return {
      ok: false,
      code: "unreadable",
      reason: "The MSG file is damaged or incomplete and could not be read.",
    };
  }
  const { reader, data } = parsed;
  const messageClass = (data.messageClass ?? "").trim();
  const hasContent =
    !!data.subject ||
    !!data.body ||
    !!data.bodyHtml ||
    !!data.html ||
    (data.recipients?.length ?? 0) > 0 ||
    (data.attachments?.length ?? 0) > 0 ||
    !!data.senderName;
  if (messageClass === "" && !hasContent) {
    return {
      ok: false,
      code: "not_mail",
      reason: "The file is an OLE compound file, but not an Outlook message.",
    };
  }
  const kind = nonMailKind(messageClass);
  if (kind !== null) {
    return {
      ok: false,
      code: "not_mail",
      reason: `This Outlook item is a ${kind} (${messageClass}), not a mail message. Only mail messages are imported.`,
    };
  }
  try {
    const built = buildMessage(reader, data, { Reader, depth, structureCheck });
    const flags: string[] = [];
    const messageFlags = data.messageFlags ?? 0;
    if (messageFlags & 0x1) {
      flags.push("\\Seen");
    }
    if (messageFlags & 0x8) {
      flags.push("\\Draft");
    }
    const internalDate =
      parseMsgDate(data.messageDeliveryTime) ??
      parseMsgDate(data.clientSubmitTime) ??
      parseMsgDate(data.creationTime) ??
      parseMsgDate(data.lastModificationTime);
    return {
      ok: true,
      raw: built.raw,
      flags,
      internalDate,
      attachmentCount: built.attachmentCount,
    };
  } catch {
    return {
      ok: false,
      code: "unreadable",
      reason: "The MSG file could not be converted to a mail message.",
    };
  }
}

export interface ConvertMsgOptions {
  /**
   * Check the structure of the compound file first (default). Switched off only by the
   * tests that prove the child process contains what the check would have caught.
   */
  readonly structureCheck?: boolean;
}

/**
 * Read an Outlook MSG and rebuild the RFC 5322 message. A file that is damaged, not an
 * Outlook message, or not mail (contact, appointment, task, note) is reported through
 * the result. Runs in a child process: see `readMsg` in ./msg.ts.
 */
export function convertMsg(bytes: Uint8Array, options: ConvertMsgOptions = {}): MsgReadResult {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return readMsgInternal(buffer, 0, resolveReader(), options.structureCheck ?? true);
}
