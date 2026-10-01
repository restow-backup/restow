/**
 * Deterministic builders for mail file test fixtures: EML, MBOX, ZIP (also
 * hand-written ZIPs with encrypted entries, hostile names and lying sizes) and
 * Outlook MSG. Used by the tests of the readers, the import engine and the
 * export writers; nothing here is used at run time.
 *
 * Everything is byte-stable (fixed dates, no random boundaries or Message-IDs)
 * except `buildMsg`, whose bytes come from `@tutao/oxmsg` (it stamps random
 * keys and the current time into the compound file).
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { Attachment, CFB, Email } from "@tutao/oxmsg";
import archiver from "archiver";
import {
  type HeaderField,
  type MimePart,
  encodeHeaderText,
  filePart,
  formatMailbox,
  mimeTypeForFile,
  multipart,
  serializeMessage,
  textPart,
} from "../mime-writer.js";
import type { MailInputFile } from "../types.js";

// ---------------------------------------------------------------------------
// EML

export interface BuildEmlAttachment {
  readonly filename: string;
  readonly content: Buffer | string;
  readonly contentType?: string;
  /** Makes the part an inline image of the HTML body (multipart/related). */
  readonly cid?: string;
}

export interface BuildEmlOptions {
  /** `Name <address>` or a bare address. */
  readonly from: string;
  readonly to: string | readonly string[];
  readonly cc?: string | readonly string[];
  readonly bcc?: string | readonly string[];
  readonly subject: string;
  /** Default: a fixed date. Pass `null` to write no Date header. */
  readonly date?: Date | string | null;
  /** Default: derived from the content. Pass `null` to write no Message-ID. */
  readonly messageId?: string | null;
  readonly body: string;
  readonly html?: string;
  readonly attachments?: readonly BuildEmlAttachment[];
  /** Extra raw headers, appended after the standard ones (already encoded). */
  readonly headers?: readonly HeaderField[];
}

export const FIXED_DATE = "Mon, 15 Jan 2024 10:00:00 +0000";

function asList(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return typeof value === "string" ? [value] : [...value];
}

function mailboxOf(text: string): string {
  const match = /^\s*(.*?)\s*<([^<>]*)>\s*$/.exec(text);
  if (!match) {
    return text.trim();
  }
  const name = (match[1] ?? "").replace(/^"(.*)"$/, "$1");
  return formatMailbox(name, match[2] ?? "");
}

export function rfc5322Date(date: Date): string {
  return date.toUTCString().replace(/ GMT$/, " +0000");
}

export function buildEml(options: BuildEmlOptions): Buffer {
  const headers: HeaderField[] = [];
  headers.push(["From", mailboxOf(options.from)]);
  const to = asList(options.to);
  if (to.length > 0) {
    headers.push(["To", to.map(mailboxOf).join(", ")]);
  }
  const cc = asList(options.cc);
  if (cc.length > 0) {
    headers.push(["Cc", cc.map(mailboxOf).join(", ")]);
  }
  const bcc = asList(options.bcc);
  if (bcc.length > 0) {
    headers.push(["Bcc", bcc.map(mailboxOf).join(", ")]);
  }
  headers.push(["Subject", encodeHeaderText(options.subject)]);
  if (options.date !== null) {
    const date = options.date ?? FIXED_DATE;
    headers.push(["Date", typeof date === "string" ? date : rfc5322Date(date)]);
  }
  if (options.messageId !== null) {
    const id =
      options.messageId ??
      `<${createHash("sha1").update(`${options.from}\0${options.subject}\0${options.body}`).digest("hex").slice(0, 16)}@example.test>`;
    headers.push(["Message-ID", id]);
  }
  for (const extra of options.headers ?? []) {
    headers.push(extra);
  }

  const inline = (options.attachments ?? []).filter((a) => a.cid !== undefined);
  const regular = (options.attachments ?? []).filter((a) => a.cid === undefined);
  const toPart = (attachment: BuildEmlAttachment, disposition: "attachment" | "inline"): MimePart =>
    filePart({
      contentType: attachment.contentType ?? mimeTypeForFile(attachment.filename),
      fileName: attachment.filename,
      disposition,
      contentId: attachment.cid ?? null,
      data:
        typeof attachment.content === "string"
          ? Buffer.from(attachment.content)
          : attachment.content,
    });

  let body: MimePart;
  if (options.html !== undefined) {
    const html = textPart("html", options.html);
    const htmlPart =
      inline.length > 0
        ? multipart("related", [html, ...inline.map((a) => toPart(a, "inline"))])
        : html;
    body = multipart("alternative", [textPart("plain", options.body), htmlPart]);
  } else {
    body = textPart("plain", options.body);
  }
  if (regular.length > 0) {
    body = multipart("mixed", [body, ...regular.map((a) => toPart(a, "attachment"))]);
  }
  return serializeMessage(headers, body);
}

// ---------------------------------------------------------------------------
// MBOX

export interface BuildMboxOptions {
  /**
   * Convert the messages to this line ending (and write the separators with it).
   * Default: the message bytes are kept verbatim, and each message's separators use
   * its own line ending (CRLF when it contains CRLF, else LF).
   */
  readonly eol?: "\n" | "\r\n";
  /** The text after `From ` for message i. Default: a fixed sender and ctime date. */
  readonly fromLine?: (index: number) => string;
  /** Write no blank line after the last message. Default false (a blank line is written). */
  readonly omitFinalBlank?: boolean;
  /** Leave lines starting with "From " unescaped (mboxo without escaping; for negative tests). */
  readonly noEscaping?: boolean;
}

export const DEFAULT_FROM_LINE = "MAILER-DAEMON Mon Jan 15 10:00:00 2024";

/** mboxrd: every line matching `^>*From ` gets one more `>`. */
export function escapeMboxrd(text: string): string {
  return text.replace(/^(>*From )/gm, ">$1");
}

export function buildMbox(messages: readonly Buffer[], options: BuildMboxOptions = {}): Buffer {
  const parts: Buffer[] = [];
  messages.forEach((message, index) => {
    let text = message.toString("latin1");
    if (!options.noEscaping) {
      text = escapeMboxrd(text);
    }
    const eol = options.eol ?? (text.includes("\r\n") ? "\r\n" : "\n");
    if (options.eol) {
      text = text.replace(/\r\n|\n/g, eol);
    }
    if (!text.endsWith("\n")) {
      text += eol;
    }
    const last = index === messages.length - 1;
    const from = options.fromLine ? options.fromLine(index) : DEFAULT_FROM_LINE;
    parts.push(
      Buffer.from(
        `From ${from}${eol}${text}${last && options.omitFinalBlank ? "" : eol}`,
        "latin1",
      ),
    );
  });
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ZIP

export interface ZipEntryInput {
  /** A name ending in "/" is a directory entry. */
  readonly name: string;
  readonly data?: Buffer | string;
  /** Store instead of deflate. */
  readonly store?: boolean;
}

const ZIP_DATE = new Date(Date.UTC(2024, 0, 15, 10, 0, 0));

/** A ZIP made with archiver (the library the export uses). Fixed timestamps, so byte-stable. */
export async function buildZip(entries: readonly ZipEntryInput[]): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const entry of entries) {
    if (entry.name.endsWith("/")) {
      archive.append(Buffer.alloc(0), { name: entry.name, date: ZIP_DATE });
    } else {
      const data =
        typeof entry.data === "string" ? Buffer.from(entry.data) : (entry.data ?? Buffer.alloc(0));
      archive.append(data, { name: entry.name, date: ZIP_DATE, store: entry.store ?? false });
    }
  }
  await archive.finalize();
  return done;
}

export interface RawZipEntry {
  /** Written as given (bytes), no sanitising: use it for `../x`, `/abs`, `a\\b`. */
  readonly name: string | Buffer;
  readonly data?: Buffer | string;
  /** 0 = stored, 8 = deflate. Default 8. */
  readonly method?: 0 | 8;
  /** Set the "encrypted" bit; the data is written as is (it is not real ciphertext). */
  readonly encrypted?: boolean;
  /** Lie about the uncompressed size in the headers (zip bomb tests). */
  readonly declaredSize?: number;
  /** Lie about the compressed size in the headers. */
  readonly declaredCompressedSize?: number;
  /** Write the UTF-8 name flag (default true for strings). */
  readonly utf8?: boolean;
  /** Compression method number to write instead of `method` (unsupported method tests). */
  readonly methodOverride?: number;
}

let crcTable: Uint32Array | null = null;
function crc32(buffer: Buffer): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A ZIP writer with full control over the headers, for cases archiver refuses to
 * produce: hostile names, encrypted flags, lying sizes, unsupported methods.
 */
export function buildRawZip(entries: readonly RawZipEntry[], comment = ""): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const dosTime = ((10 << 11) | (0 << 5) | 0) & 0xffff;
  const dosDate = (((2024 - 1980) << 9) | (1 << 5) | 15) & 0xffff;
  for (const entry of entries) {
    const name = typeof entry.name === "string" ? Buffer.from(entry.name, "utf8") : entry.name;
    const raw =
      typeof entry.data === "string" ? Buffer.from(entry.data) : (entry.data ?? Buffer.alloc(0));
    const method = entry.method ?? 8;
    const stored = method === 0 ? raw : deflateRawSync(raw);
    const crc = crc32(raw);
    const flags = (entry.encrypted ? 1 : 0) | (entry.utf8 === false ? 0 : 0x800);
    const usize = entry.declaredSize ?? raw.length;
    const csize = entry.declaredCompressedSize ?? stored.length;
    const writtenMethod = entry.methodOverride ?? method;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(writtenMethod, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(csize, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(writtenMethod, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(csize, 20);
    central.writeUInt32LE(usize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + stored.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const commentBytes = Buffer.from(comment, "utf8");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...locals, ...centrals, end, commentBytes]);
}

// ---------------------------------------------------------------------------
// MSG

export interface BuildMsgAttachment {
  readonly filename: string;
  readonly content: Buffer | string;
  readonly cid?: string;
}

export interface BuildMsgOptions {
  readonly from: { readonly address: string; readonly name?: string };
  readonly to: readonly { readonly address: string; readonly name?: string }[];
  readonly cc?: readonly { readonly address: string; readonly name?: string }[];
  readonly bcc?: readonly { readonly address: string; readonly name?: string }[];
  readonly subject: string;
  readonly body?: string;
  readonly html?: string;
  readonly sentOn?: Date;
  readonly receivedOn?: Date;
  /** Zero the submit, delivery and creation times afterwards (MAPI's way to say "unknown"). */
  readonly noTimes?: boolean;
  readonly attachments?: readonly BuildMsgAttachment[];
  /** Original transport headers (RFC 5322 header block). */
  readonly transportHeaders?: string;
  /** Set the "read" flag of the message. */
  readonly read?: boolean;
  /** Rewrite PR_MESSAGE_CLASS, e.g. "IPM.Contact" to test the non-mail refusal. */
  readonly messageClass?: string;
  /** Written as a draft (unsent). */
  readonly draft?: boolean;
}

function findProperty(properties: Uint8Array, tag: number): number {
  // Top-level property stream: 32 header bytes, then 16-byte records (tag as type|id<<16 little endian).
  for (let offset = 32; offset + 16 <= properties.length; offset += 16) {
    const view = new DataView(properties.buffer, properties.byteOffset + offset, 16);
    if (view.getUint32(0, true) === tag) {
      return offset;
    }
  }
  return -1;
}

/** An Outlook MSG made by `@tutao/oxmsg`, optionally patched (read flag, message class). */
export async function buildMsg(options: BuildMsgOptions): Promise<Buffer> {
  const email = new Email(options.draft ?? false);
  email.sender(options.from.address, options.from.name);
  for (const r of options.to) {
    email.to(r.address, r.name);
  }
  for (const r of options.cc ?? []) {
    email.cc(r.address, r.name);
  }
  for (const r of options.bcc ?? []) {
    email.bcc(r.address, r.name);
  }
  email.subject(options.subject);
  if (options.body !== undefined) {
    email.bodyText(options.body);
  }
  if (options.html !== undefined) {
    email.bodyHtml(options.html);
  }
  if (options.sentOn) {
    email.sentOn(options.sentOn);
  }
  if (options.receivedOn) {
    email.receivedOn(options.receivedOn);
  }
  if (options.transportHeaders) {
    email.headers(options.transportHeaders);
  }
  for (const attachment of options.attachments ?? []) {
    const data =
      typeof attachment.content === "string" ? Buffer.from(attachment.content) : attachment.content;
    email.attach(new Attachment(data, attachment.filename, attachment.cid ?? ""));
  }
  let bytes: Uint8Array = email.msg();
  if (options.read || options.messageClass || options.noTimes) {
    const cfb = CFB.read(Buffer.from(bytes), { type: "buffer" });
    if (options.noTimes) {
      const content = CFB.find(cfb, "/__properties_version1.0")?.content as Uint8Array | undefined;
      if (content) {
        // PidTagClientSubmitTime 0x0039, PidTagMessageDeliveryTime 0x0E06, PidTagCreationTime 0x3007 (PT_SYSTIME).
        for (const id of [0x0039, 0x0e06, 0x3007, 0x3008]) {
          const at = findProperty(content, ((id << 16) | 0x0040) >>> 0);
          if (at >= 0) {
            content.fill(0, at + 8, at + 16);
          }
        }
      }
    }
    if (options.read) {
      const entry = CFB.find(cfb, "/__properties_version1.0");
      const content = entry?.content as Uint8Array | undefined;
      if (content) {
        // PidTagMessageFlags = 0x0E07, PT_LONG (3). Set MSGFLAG_READ (1).
        const at = findProperty(content, ((0x0e07 << 16) | 0x0003) >>> 0);
        if (at >= 0) {
          const view = new DataView(content.buffer, content.byteOffset + at + 8, 4);
          view.setUint32(0, view.getUint32(0, true) | 1, true);
        }
      }
    }
    if (options.messageClass) {
      const entry = CFB.find(cfb, "/__substg1.0_001A001F");
      if (entry) {
        entry.content = Buffer.from(options.messageClass, "utf16le");
        entry.size = (entry.content as Buffer).length;
      }
    }
    bytes = CFB.write(cfb, { type: "buffer" }) as Uint8Array;
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Input files

export interface InputFileOptions {
  /** Size of the chunks `open()` emits (default 64 KiB); tiny values test streaming. */
  readonly chunkSize?: number;
}

/** A {@link MailInputFile} over an in-memory buffer. */
export function inputFileFromBuffer(
  path: string,
  buffer: Buffer,
  options: InputFileOptions = {},
): MailInputFile {
  const chunkSize = Math.max(1, options.chunkSize ?? 64 * 1024);
  return {
    path,
    size: buffer.length,
    open(): Readable {
      function* chunks(): Generator<Buffer> {
        for (let offset = 0; offset < buffer.length; offset += chunkSize) {
          yield buffer.subarray(offset, Math.min(buffer.length, offset + chunkSize));
        }
      }
      return Readable.from(chunks(), { objectMode: false });
    },
    async read(offset: number, length: number): Promise<Buffer> {
      if (offset < 0 || length < 0) {
        throw new RangeError("negative read");
      }
      return Buffer.from(buffer.subarray(offset, Math.min(buffer.length, offset + length)));
    },
  };
}
