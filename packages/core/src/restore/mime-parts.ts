/**
 * A MIME message taken apart for an Exchange restore that cannot import it in
 * one request: Graph takes at most 4 MB per request, so a message whose
 * base64 MIME is larger is created from its header and body as JSON, and its
 * attachments are added one by one afterwards (docs/MICROSOFT.md, Exchange
 * restore).
 *
 * Both passes stream the backed-up bytes through mailparser, so memory holds
 * the body text, never an attachment: {@link outlineMime} reads header, body
 * and the facts of every attachment (name, type, size), {@link
 * forEachMimeAttachment} hands each attachment's content to a callback in the
 * same order. mailparser's conversions (text to HTML, links, HTML to text)
 * stay off; an attached message (message/rfc822) is kept as one attachment,
 * not opened up.
 */
import type { Readable } from "node:stream";
import type { Importance, Message, Recipient } from "@microsoft/microsoft-graph-types";
import {
  type AddressObject,
  type AttachmentStream,
  type EmailAddress,
  type HeaderLines,
  type Headers,
  type HeaderValue,
  MailParser,
  type MailParserOptions,
  type MessageText,
} from "mailparser";
import { parseHeaderDate } from "../mailfiles/headers.js";

const PARSER_OPTIONS: MailParserOptions = {
  skipImageLinks: true,
  skipTextToHtml: true,
  skipTextLinks: true,
  skipHtmlToText: true,
  // An attached message is one .eml attachment, not parts of this one.
  ignoreEmbedded: true,
  checksumAlgo: false,
};

export interface MimeAttachmentFacts {
  readonly name: string;
  readonly contentType: string;
  /** Decoded size in bytes. */
  readonly size: number;
  readonly isInline: boolean;
  /** Content-ID without angle brackets, for parts the HTML body refers to (`cid:`). */
  readonly contentId: string | undefined;
}

/**
 * How a message protects its content, as its structure shows it:
 *
 *   encrypted          S/MIME enveloped data (application/pkcs7-mime) or
 *                      PGP/MIME (multipart/encrypted): the body is ciphertext
 *   opaque-signed      S/MIME signed data (application/pkcs7-mime,
 *                      smime-type=signed-data): body and signature are one
 *                      binary part
 *   signed             multipart/signed (S/MIME or PGP): readable body, the
 *                      signature over its exact bytes in a second part
 *   rights-protected   Microsoft Purview / IRM (an .rpmsg part)
 *
 * Rebuilt from its parts, none of these is what it was: Exchange stores
 * protected mail as a message class of its own with the original MIME, and a
 * signature covers bytes a rebuild does not keep.
 */
export type MimeProtection = "encrypted" | "opaque-signed" | "signed" | "rights-protected";

export interface MimeOutline {
  readonly headers: Headers;
  readonly headerLines: HeaderLines;
  readonly html: string | undefined;
  readonly text: string | undefined;
  readonly attachments: readonly MimeAttachmentFacts[];
  readonly protection: MimeProtection | undefined;
}

const PKCS7_MIME = new Set(["application/pkcs7-mime", "application/x-pkcs7-mime"]);
const RPMSG = "application/x-microsoft-rpmsg-message";

/** The structured value of a Content-Type header (mailparser keeps it as value and params). */
function contentTypeOf(headers: Headers): { type: string; params: Record<string, string> } {
  const value = headers.get("content-type");
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    const structured = value as { value: unknown; params?: Record<string, string> };
    if (typeof structured.value === "string") {
      return { type: structured.value.toLowerCase(), params: structured.params ?? {} };
    }
  }
  return { type: typeof value === "string" ? value.toLowerCase() : "", params: {} };
}

function protectionOf(
  headers: Headers,
  attachments: readonly MimeAttachmentFacts[],
): MimeProtection | undefined {
  const { type, params } = contentTypeOf(headers);
  if (PKCS7_MIME.has(type)) {
    const smimeType = (params["smime-type"] ?? "").toLowerCase();
    return smimeType === "signed-data" ? "opaque-signed" : "encrypted";
  }
  if (type === "multipart/encrypted") {
    return "encrypted";
  }
  if (type === "multipart/signed") {
    return "signed";
  }
  if (
    attachments.some(
      (attachment) =>
        attachment.contentType === RPMSG || attachment.name.toLowerCase().endsWith(".rpmsg"),
    )
  ) {
    return "rights-protected";
  }
  return undefined;
}

/**
 * Whether a MIME import of these headers would be a draft: Exchange makes
 * one of a message whose header lacks Date or From (docs/MICROSOFT.md).
 */
export function mimeImportIsDraft(outline: Pick<MimeOutline, "headerLines">): boolean {
  const has = (name: string) =>
    outline.headerLines.some((entry) => entry.key.toLowerCase() === name);
  return !(has("date") && has("from"));
}

function newParser(source: Readable): MailParser {
  const parser = new MailParser(PARSER_OPTIONS);
  source.once("error", (error) => parser.destroy(error));
  // A consumer that stops early (an abort) closes the parser; the backup read stops with it.
  parser.once("close", () => source.destroy());
  source.pipe(parser);
  return parser;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "message/rfc822": "eml",
  "text/calendar": "ics",
  "application/pdf": "pdf",
};

function attachmentFacts(
  attachment: AttachmentStream,
  index: number,
  size: number,
): MimeAttachmentFacts {
  const contentType = (attachment.contentType || "application/octet-stream").toLowerCase();
  const contentId = attachment.cid?.trim() || undefined;
  let name = attachment.filename?.trim() || "";
  if (name.length === 0) {
    const extension = EXTENSIONS[contentType];
    name = `attachment-${index + 1}${extension ? `.${extension}` : ""}`;
  } else if (contentType === "message/rfc822" && !/\.[A-Za-z0-9]{1,8}$/.test(name)) {
    name = `${name}.eml`;
  }
  const isInline =
    contentId !== undefined &&
    (attachment.related === true || attachment.contentDisposition === "inline");
  return { name, contentType, size, isInline, contentId };
}

/** Read header, body and attachment facts; attachment contents are counted and dropped. */
export async function outlineMime(source: Readable): Promise<MimeOutline> {
  const parser = newParser(source);
  let headers: Headers = new Map();
  let headerLines: HeaderLines = [];
  parser.on("headers", (value: Headers) => {
    headers = value;
  });
  parser.on("headerLines", (value: HeaderLines) => {
    headerLines = value;
  });
  let html: string | undefined;
  let text: string | undefined;
  const attachments: MimeAttachmentFacts[] = [];
  for await (const data of parser as AsyncIterable<AttachmentStream | MessageText>) {
    if (data.type === "text") {
      html = typeof data.html === "string" && data.html.length > 0 ? data.html : undefined;
      text = typeof data.text === "string" ? data.text : undefined;
      continue;
    }
    let size = 0;
    try {
      for await (const chunk of data.content as Readable) {
        size += (chunk as Buffer).length;
      }
    } finally {
      data.release?.();
    }
    attachments.push(attachmentFacts(data, attachments.length, size));
  }
  return {
    headers,
    headerLines,
    html,
    text,
    attachments,
    protection: protectionOf(headers, attachments),
  };
}

/** An image the HTML body carried as a `data:` URI, to be added as an inline attachment. */
export interface BodyImage extends MimeAttachmentFacts {
  readonly content: Buffer;
}

const DATA_IMAGE = /(\bsrc\s*=\s*)(["'])data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)\2/gi;

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};

/**
 * Move the images an HTML body embeds as `data:` URIs (a newsletter with its
 * pictures inline) out of the body: each becomes an inline attachment the
 * body refers to by `cid:`, as a mail program would send it. A body Graph
 * would refuse as too large for one request then fits.
 */
export function extractBodyImages(html: string): { html: string; images: BodyImage[] } {
  const images: BodyImage[] = [];
  const rewritten = html.replace(
    DATA_IMAGE,
    (_match, attribute: string, quote: string, type: string, data: string) => {
      const contentType = type.toLowerCase();
      const content = Buffer.from(data.replace(/\s+/g, ""), "base64");
      const index = images.length + 1;
      const contentId = `restow-body-image-${index}@restow.invalid`;
      images.push({
        name: `image-${index}.${IMAGE_EXTENSIONS[contentType] ?? "bin"}`,
        contentType,
        size: content.length,
        isInline: true,
        contentId,
        content,
      });
      return `${attribute}${quote}cid:${contentId}${quote}`;
    },
  );
  return { html: rewritten, images };
}

/**
 * Hand each attachment's decoded content to `visit`, in the order of {@link
 * outlineMime}. `visit` must read or drop the stream; what it leaves is
 * drained before the parser goes on.
 */
export async function forEachMimeAttachment(
  source: Readable,
  visit: (index: number, content: Readable) => Promise<void>,
): Promise<void> {
  const parser = newParser(source);
  let index = 0;
  for await (const data of parser as AsyncIterable<AttachmentStream | MessageText>) {
    if (data.type === "text") {
      continue;
    }
    const content = data.content as Readable;
    try {
      await visit(index++, content);
    } finally {
      content.resume();
      data.release?.();
    }
  }
}

// ---------------------------------------------------------------------------
// Graph message

function flatten(value: readonly EmailAddress[]): EmailAddress[] {
  return value.flatMap((entry) => (entry.group ? flatten(entry.group) : [entry]));
}

function recipientsOf(value: HeaderValue | undefined): Recipient[] {
  if (value === undefined || value === null || typeof value !== "object") {
    return [];
  }
  const objects = (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is AddressObject =>
      typeof entry === "object" && entry !== null && Array.isArray((entry as AddressObject).value),
  );
  return objects
    .flatMap((entry) => flatten(entry.value))
    .filter((address) => (address.address ?? "").trim().length > 0)
    .map((address) => ({
      emailAddress: {
        address: (address.address ?? "").trim(),
        ...(address.name?.trim() ? { name: address.name.trim() } : {}),
      },
    }));
}

function textOf(value: HeaderValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

function importanceOf(headers: Headers): Importance | undefined {
  const importance = textOf(headers.get("importance"))?.trim().toLowerCase();
  if (importance === "high" || importance === "low" || importance === "normal") {
    return importance;
  }
  const priority = Number.parseInt(textOf(headers.get("x-priority")) ?? "", 10);
  if (priority === 1 || priority === 2) {
    return "high";
  }
  if (priority === 4 || priority === 5) {
    return "low";
  }
  return undefined;
}

/** The raw header lines as Graph's `internetMessageHeaders` (unfolded). */
function rawHeaders(lines: HeaderLines): Array<{ name: string; value: string }> {
  return lines.map((entry) => {
    const colon = entry.line.indexOf(":");
    return {
      name: colon === -1 ? entry.key : entry.line.slice(0, colon).trim(),
      value: (colon === -1 ? "" : entry.line.slice(colon + 1)).replace(/\r?\n[ \t]+/g, " ").trim(),
    };
  });
}

/**
 * The message as Graph JSON for a create without attachments: subject, body,
 * sender and recipients, importance, Message-ID, and every header line as
 * `internetMessageHeaders` (prepareMessageCreate keeps only what Graph takes).
 * `receivedDateTime` is the time the backup recorded, else the Date header.
 */
export function graphMessageFromMime(
  outline: MimeOutline,
  recorded: { readonly receivedDateTime?: string; readonly isRead?: boolean },
): Message {
  const { headers } = outline;
  const dateLine = outline.headerLines.find((entry) => entry.key.toLowerCase() === "date");
  const sent = dateLine
    ? parseHeaderDate(dateLine.line.slice(dateLine.line.indexOf(":") + 1))
    : null;
  const from = recipientsOf(headers.get("from"))[0];
  const sender = recipientsOf(headers.get("sender"))[0] ?? from;
  const messageId = textOf(headers.get("message-id"))?.trim();
  const importance = importanceOf(headers);
  const message: Message = {
    subject: textOf(headers.get("subject")) ?? "",
    body:
      outline.html !== undefined
        ? { contentType: "html", content: outline.html }
        : { contentType: "text", content: outline.text ?? "" },
    toRecipients: recipientsOf(headers.get("to")),
    ccRecipients: recipientsOf(headers.get("cc")),
    bccRecipients: recipientsOf(headers.get("bcc")),
    replyTo: recipientsOf(headers.get("reply-to")),
    internetMessageHeaders: rawHeaders(outline.headerLines),
  };
  if (from !== undefined) {
    message.from = from;
  }
  if (sender !== undefined) {
    message.sender = sender;
  }
  if (messageId) {
    message.internetMessageId = messageId;
  }
  if (importance !== undefined) {
    message.importance = importance;
  }
  if (recorded.isRead !== undefined) {
    message.isRead = recorded.isRead;
  }
  const received = recorded.receivedDateTime ?? sent?.toISOString();
  if (received !== undefined) {
    message.receivedDateTime = received;
  }
  if (sent) {
    message.sentDateTime = sent.toISOString();
  }
  return message;
}
