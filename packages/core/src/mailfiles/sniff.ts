/**
 * Content-based file type detection (docs/IMPORT.md): what an offered file is
 * is decided by its bytes, never by its name.
 *
 * The verdict is deliberately conservative. A false "eml" would import garbage
 * as mail, a false "unknown" only makes the report name the file, so anything
 * that does not clearly look like one of the supported formats is unknown.
 */
import type { MailFormatDetection } from "./types.js";

/** How many leading bytes of a file the detection looks at. */
export const SNIFF_HEAD_BYTES = 64 * 1024;

const PST_MAGIC = Buffer.from("!BDN", "latin1");
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const FROM_PREFIX = "From ";

/** Longest first line ("From_ line") that still counts as one. */
const MAX_FROM_LINE = 4096;

/** RFC 5322 field name: printable ASCII except the colon (and the space). */
const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]+$/;
/** A header line as it starts in a mail file: a field name and a colon. */
const HEADER_LINE_START = /^[\x21-\x39\x3b-\x7e]+:/;

/** Field names that make a header block a mail header on their own. */
const WELL_KNOWN_FIELDS = new Set([
  "received",
  "return-path",
  "delivered-to",
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "reply-to",
  "sender",
  "in-reply-to",
  "references",
  "x-mailer",
  "user-agent",
  "x-original-to",
  "x-mozilla-status",
  "x-unsent",
  "authentication-results",
  "dkim-signature",
  "list-id",
  "thread-topic",
  "thread-index",
  "resent-from",
  "resent-to",
  "resent-date",
  "envelope-to",
  "x-originating-ip",
  "x-received",
  "arc-seal",
  "x-forwarded-to",
  "importance",
  "priority",
]);

/** True for the header line shape `Name: value`. Exported for the MBOX reader. */
export function isHeaderLine(line: string): boolean {
  return HEADER_LINE_START.test(line);
}

/** Bytes below 0x20 that may appear in a text mail header. */
function hasForbiddenControl(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      return true;
    }
  }
  return false;
}

function startsWith(head: Buffer, magic: Buffer): boolean {
  return head.length >= magic.length && head.subarray(0, magic.length).equals(magic);
}

/**
 * ZIP local file header (PK\x03\x04) or end of central directory of an empty
 * archive (PK\x05\x06). The spanned-archive marker PK\x07\x08 is not accepted:
 * a split archive cannot be read from one file anyway.
 */
function isZip(head: Buffer): boolean {
  return (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06))
  );
}

/** Other archive formats that are recognised only to say "not supported" precisely. */
export type OtherArchiveKind = "gzip" | "7z" | "rar" | "bzip2" | "xz" | "tar" | "zstd";

const ARCHIVE_LABELS: Record<OtherArchiveKind, string> = {
  gzip: "gzip",
  "7z": "7-Zip",
  rar: "RAR",
  bzip2: "bzip2",
  xz: "xz",
  tar: "TAR",
  zstd: "Zstandard",
};

/** Human label for an archive kind ("7-Zip"). */
export function archiveKindLabel(kind: OtherArchiveKind): string {
  return ARCHIVE_LABELS[kind];
}

/** Recognise a non-ZIP archive or compressed stream by its magic bytes. */
export function detectOtherArchive(head: Buffer): OtherArchiveKind | null {
  if (head.length >= 3 && head[0] === 0x1f && head[1] === 0x8b && head[2] === 0x08) {
    return "gzip";
  }
  if (
    head.length >= 6 &&
    head.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
  ) {
    return "7z";
  }
  if (
    head.length >= 7 &&
    head.subarray(0, 4).toString("latin1") === "Rar!" &&
    head[4] === 0x1a &&
    head[5] === 0x07
  ) {
    return "rar";
  }
  if (
    head.length >= 4 &&
    head.subarray(0, 3).toString("latin1") === "BZh" &&
    head[3] >= 0x31 &&
    head[3] <= 0x39
  ) {
    return "bzip2";
  }
  if (
    head.length >= 6 &&
    head.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))
  ) {
    return "xz";
  }
  if (head.length >= 4 && head.readUInt32LE(0) === 0xfd2fb528) {
    return "zstd";
  }
  if (head.length >= 262 && head.subarray(257, 262).toString("latin1") === "ustar") {
    return "tar";
  }
  return null;
}

interface HeaderBlockScan {
  /** Lower-cased field names in order of appearance. */
  readonly fields: readonly string[];
  /** False when a line breaks the header syntax. */
  readonly valid: boolean;
}

/**
 * Scan the header block at the start of `text`: `Name: value` lines with
 * continuation lines, ended by a blank line or the end of the text. The last
 * line is forgiven when the text was cut in the middle of it.
 */
function scanHeaderBlock(text: string, cutOff: boolean): HeaderBlockScan {
  const fields: string[] = [];
  let position = 0;
  while (position < text.length) {
    const newline = text.indexOf("\n", position);
    const isLast = newline === -1;
    let line = isLast ? text.slice(position) : text.slice(position, newline);
    position = isLast ? text.length : newline + 1;
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (line.length === 0) {
      // The blank line that ends the header block.
      return { fields, valid: fields.length > 0 };
    }
    if (line.includes("\r")) {
      return { fields, valid: false };
    }
    if (line[0] === " " || line[0] === "\t") {
      if (fields.length === 0) {
        return { fields, valid: false };
      }
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0 && FIELD_NAME.test(line.slice(0, colon))) {
      fields.push(line.slice(0, colon).toLowerCase());
      continue;
    }
    // A cut-off text may end in half a field name; anything else is not a header.
    if (isLast && cutOff && fields.length > 0) {
      return { fields, valid: true };
    }
    return { fields, valid: false };
  }
  return { fields, valid: fields.length > 0 };
}

function stripBom(head: Buffer): Buffer {
  return startsWith(head, UTF8_BOM) ? head.subarray(UTF8_BOM.length) : head;
}

function looksLikeMbox(text: Buffer): boolean {
  if (text.length < FROM_PREFIX.length + 1 || text.toString("latin1", 0, 5) !== FROM_PREFIX) {
    return false;
  }
  const firstEnd = text.indexOf(0x0a);
  if (firstEnd === -1 || firstEnd > MAX_FROM_LINE) {
    return false;
  }
  const nextStart = firstEnd + 1;
  const secondEnd = text.indexOf(0x0a, nextStart);
  const secondLine = text
    .toString(
      "latin1",
      nextStart,
      secondEnd === -1 ? Math.min(text.length, nextStart + 998) : secondEnd,
    )
    .replace(/\r$/, "");
  if (!isHeaderLine(secondLine)) {
    return false;
  }
  return !hasForbiddenControl(text.subarray(0, secondEnd === -1 ? text.length : secondEnd));
}

/** Classify the first bytes (up to 64 KiB) of a file. */
export function detectMailFormat(head: Buffer): MailFormatDetection {
  if (head.length === 0) {
    return { format: "unknown", detail: "The file is empty" };
  }
  if (startsWith(head, PST_MAGIC)) {
    return { format: "pst", detail: "Outlook data file (PST or OST)" };
  }
  if (isZip(head)) {
    return { format: "zip", detail: "ZIP archive" };
  }
  if (startsWith(head, OLE_MAGIC)) {
    return { format: "msg", detail: "OLE compound file (an Outlook message when it holds mail)" };
  }

  const text = stripBom(head.length > SNIFF_HEAD_BYTES ? head.subarray(0, SNIFF_HEAD_BYTES) : head);
  if (looksLikeMbox(text)) {
    return { format: "mbox", detail: "MBOX mailbox" };
  }
  if (text.includes(0x00) || hasForbiddenControl(text.subarray(0, Math.min(text.length, 8192)))) {
    const archive = detectOtherArchive(head);
    return {
      format: "unknown",
      detail: archive
        ? `${archiveKindLabel(archive)} archive`
        : "Binary data that is not a mail file",
    };
  }
  // The head may end inside a line when the file is longer than what was read.
  const cutOff = head.length >= SNIFF_HEAD_BYTES;
  const scan = scanHeaderBlock(text.toString("latin1"), cutOff);
  if (
    scan.valid &&
    (scan.fields.length >= 2 || scan.fields.some((f) => WELL_KNOWN_FIELDS.has(f)))
  ) {
    return { format: "eml", detail: "RFC 5322 message" };
  }
  return { format: "unknown", detail: "The content is not a recognised mail format" };
}
