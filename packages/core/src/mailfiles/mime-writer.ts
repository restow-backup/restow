/**
 * A small deterministic MIME writer.
 *
 * It exists for two callers: the MSG reader, which has to rebuild RFC 5322 bytes
 * from Outlook properties, and the test builders. The one property that
 * matters is determinism: the same input always yields the same bytes. There is
 * no random boundary, no "now" Date and no generated Message-ID; a header that is
 * not given is simply not written.
 *
 * Header encoding, RFC 2231 parameters and the transfer encodings come from the
 * nodemailer helpers that are already a dependency of this package.
 */
import { createHash } from "node:crypto";
import { encode as base64Encode, wrap as base64Wrap } from "nodemailer/lib/base64";
import {
  buildHeaderValue,
  detectMimeType,
  encodeWord,
  foldLines,
  isPlainText,
} from "nodemailer/lib/mime-funcs";
import { encode as qpEncode, wrap as qpWrap } from "nodemailer/lib/qp";

const CRLF = "\r\n";
/** RFC 5322 line length limit for folded headers (78, minus the CRLF). */
const HEADER_FOLD_AT = 76;
const MAX_TEXT_LINE = 998;

export type HeaderField = readonly [name: string, value: string];

export interface MimePart {
  /** Content-* headers of this part (already encoded, one entry per header). */
  readonly headers: readonly HeaderField[];
  readonly body: Buffer;
}

/** Remove line breaks and control characters from a value that goes into a header. */
export function headerSafe(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed here
  return value.replace(/[\r\n]+/g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** Text as a header value: RFC 2047 encoded words when it is not plain ASCII. */
export function encodeHeaderText(value: string): string {
  const safe = headerSafe(value).trim();
  if (isPlainText(safe)) {
    return safe;
  }
  const words: string[] = [];
  // Encode in pieces that stay below the encoded-word limit of 75 characters.
  let current = "";
  const flush = (): void => {
    if (current.length > 0) {
      words.push(encodeWord(current, "B"));
      current = "";
    }
  };
  for (const char of safe) {
    if (Buffer.byteLength(current + char, "utf8") > 42) {
      flush();
    }
    current += char;
  }
  flush();
  return words.join(" ");
}

function quoteDisplayName(name: string): string {
  return `"${name.replace(/[\\"]/g, "\\$&")}"`;
}

/** `Name <address>`, the bare address, or `"Name" <>` when only a name is known. */
export function formatMailbox(
  name: string | null | undefined,
  address: string | null | undefined,
): string {
  const displayName = headerSafe(name ?? "").trim();
  const mailbox = headerSafe(address ?? "").trim();
  if (displayName.length === 0 || displayName === mailbox) {
    return mailbox.length > 0 ? mailbox : "<>";
  }
  const encodedName = isPlainText(displayName)
    ? /[()<>[\]:;@\\,."]/.test(displayName)
      ? quoteDisplayName(displayName)
      : displayName
    : encodeHeaderText(displayName);
  return `${encodedName} <${mailbox}>`;
}

/** One header line, folded at 76 columns (no trailing line break). */
export function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= HEADER_FOLD_AT && !line.includes(CRLF)) {
    return line;
  }
  // A header that contains its own folds (kept transport headers) is left alone.
  return line.includes(CRLF) ? line : foldLines(line, HEADER_FOLD_AT);
}

/** `Content-Disposition` / `Content-Type` style value with RFC 2231 parameters. */
export function parameterizedValue(
  value: string,
  params: Readonly<Record<string, string | null | undefined>>,
): string {
  const cleaned: Record<string, string> = {};
  for (const [key, raw] of Object.entries(params)) {
    if (raw !== null && raw !== undefined && raw !== "") {
      cleaned[key] = headerSafe(raw);
    }
  }
  const built = buildHeaderValue({ value, params: cleaned });
  // A parameter that fits one segment is written as name*=charset''value.
  return built.replace(/; ([A-Za-z0-9-]+)\*0\*=/g, (match, key: string) =>
    built.includes(`; ${key}*1`) ? match : `; ${key}*=`,
  );
}

/** A MIME type from a file name, `application/octet-stream` when unknown. */
export function mimeTypeForFile(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0
    ? detectMimeType(fileName.slice(dot + 1).toLowerCase())
    : "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Leaf parts

interface EncodedText {
  readonly encoding: "7bit" | "quoted-printable";
  readonly body: Buffer;
}

function encodeTextBody(text: string): EncodedText {
  const normalized = text.replace(/\r\n|\r|\n/g, CRLF);
  const ascii = Buffer.byteLength(normalized, "utf8") === normalized.length;
  const longest = normalized.split(CRLF).reduce((max, line) => Math.max(max, line.length), 0);
  if (ascii && longest <= MAX_TEXT_LINE && !normalized.includes("\0")) {
    return { encoding: "7bit", body: Buffer.from(normalized, "latin1") };
  }
  return {
    encoding: "quoted-printable",
    body: Buffer.from(qpWrap(qpEncode(Buffer.from(normalized, "utf8")), 76), "latin1"),
  };
}

export function textPart(subtype: "plain" | "html", text: string): MimePart {
  const { encoding, body } = encodeTextBody(text);
  return {
    headers: [
      ["Content-Type", `text/${subtype}; charset=utf-8`],
      ["Content-Transfer-Encoding", encoding],
    ],
    body,
  };
}

export interface FilePartInput {
  readonly contentType: string;
  readonly fileName: string | null;
  readonly disposition: "attachment" | "inline";
  readonly contentId?: string | null;
  readonly data: Uint8Array;
}

export function filePart(input: FilePartInput): MimePart {
  const headers: HeaderField[] = [
    [
      "Content-Type",
      parameterizedValue(headerSafe(input.contentType) || "application/octet-stream", {
        name: input.fileName,
      }),
    ],
    ["Content-Transfer-Encoding", "base64"],
    ["Content-Disposition", parameterizedValue(input.disposition, { filename: input.fileName })],
  ];
  if (input.contentId) {
    headers.push(["Content-ID", `<${headerSafe(input.contentId).replace(/^<|>$/g, "")}>`]);
  }
  return {
    headers,
    body: Buffer.from(base64Wrap(base64Encode(Buffer.from(input.data)), 76), "latin1"),
  };
}

/** An embedded message as a message/rfc822 part. */
export function messagePart(fileName: string | null, message: Buffer): MimePart {
  let eightBit = false;
  for (let i = 0; i < message.length; i++) {
    if ((message[i] as number) > 0x7f) {
      eightBit = true;
      break;
    }
  }
  return {
    headers: [
      ["Content-Type", "message/rfc822"],
      ["Content-Transfer-Encoding", eightBit ? "8bit" : "7bit"],
      ["Content-Disposition", parameterizedValue("attachment", { filename: fileName })],
    ],
    body: message,
  };
}

// ---------------------------------------------------------------------------
// Multipart and messages

export function serializePart(part: MimePart): Buffer {
  const head = part.headers.map(([name, value]) => foldHeader(name, value)).join(CRLF);
  return Buffer.concat([Buffer.from(`${head}${CRLF}${CRLF}`, "latin1"), part.body]);
}

/** A boundary derived from the content, so identical parts always get the same one. */
function boundaryFor(subtype: string, serialized: readonly Buffer[]): string {
  for (let attempt = 0; ; attempt++) {
    const hash = createHash("sha256");
    hash.update(`${subtype}\0${attempt}\0`);
    for (const part of serialized) {
      hash.update(part);
    }
    const boundary = `----=_Restow_${hash.digest("hex").slice(0, 24)}`;
    const needle = Buffer.from(`--${boundary}`, "latin1");
    if (!serialized.some((part) => part.includes(needle))) {
      return boundary;
    }
  }
}

export function multipart(
  subtype: "mixed" | "alternative" | "related",
  parts: readonly MimePart[],
): MimePart {
  const serialized = parts.map(serializePart);
  const boundary = boundaryFor(subtype, serialized);
  const chunks: Buffer[] = [];
  for (const part of serialized) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}`, "latin1"), part, Buffer.from(CRLF, "latin1"));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, "latin1"));
  return {
    headers: [["Content-Type", `multipart/${subtype}; boundary="${boundary}"`]],
    body: Buffer.concat(chunks),
  };
}

/**
 * The complete message: the given top-level headers (already encoded), then
 * MIME-Version and the root part's Content-* headers, a blank line and the body.
 */
export function serializeMessage(topHeaders: readonly HeaderField[], root: MimePart): Buffer {
  const headers: HeaderField[] = [...topHeaders, ["MIME-Version", "1.0"], ...root.headers];
  return serializePart({ headers, body: root.body });
}
