/**
 * Metadata derived from RFC 5322 bytes: the same envelope fields the IMAP backup
 * stores (see backup/imap/imapflow-connector.ts, `deriveEnvelopeMeta`), plus the
 * plain text of the body for the archive search.
 *
 * The parse streams the message through mailparser and throws every attachment
 * away as it goes, so a message with a large attachment costs memory for its
 * text only, not for the attachment twice.
 *
 * This is the code that touches the bytes of an imported message. mailparser and
 * its HTML conversion are not linear for every input (a crafted quoted-printable
 * body or a deeply nested table takes seconds to minutes), so the import runs it
 * in a child process with a time and memory limit: `parseMessageMeta` of ./meta.ts.
 * Use that, not this module, outside the child. What is not needed is not asked
 * for: mailparser's text to HTML conversion (a 30 MB text becomes a 120 MB string
 * in one allocation), its link and image rewriting and its HTML to text conversion
 * stay off, and the text and HTML it hands over are cut at what the search keeps.
 */
import type { Readable } from "node:stream";
import {
  type AddressObject,
  type AttachmentStream,
  type EmailAddress,
  type HeaderLines,
  type HeaderValue,
  type Headers,
  MailParser,
  type MessageText,
} from "mailparser";
import { parseHeaderDate } from "./headers.js";
import { HTML_TEXT_DEFAULT_LIMIT, htmlToPlainText } from "./html-text.js";
import type { MessageMeta } from "./types.js";

/** Longest body text kept for the search index, in characters. */
export const MAX_BODY_TEXT_CHARS = 200_000;
/** Same cap the IMAP envelope uses for the address lists. */
const MAX_ADDRESS_LIST_ENTRIES = 20;

const RPMSG_CONTENT_TYPE = "application/x-microsoft-rpmsg-message";
const PKCS7_MIME_TYPES = new Set(["application/pkcs7-mime", "application/x-pkcs7-mime"]);
const ENVELOPED_SMIME_TYPES = new Set(["enveloped-data", "authenveloped-data"]);
/** Leaf types that are part of an ordinary message, never counted as an attachment. */
const NON_ATTACHMENT_LEAF_TYPES = new Set([
  "text/plain",
  "text/html",
  "text/calendar",
  "application/pkcs7-signature",
  "application/pgp-signature",
]);

export const EMPTY_MESSAGE_META: MessageMeta = {
  messageId: null,
  subject: "",
  from: null,
  to: [],
  toCount: 0,
  cc: [],
  ccCount: 0,
  hasAttachments: false,
  attachmentCount: 0,
  sentAt: null,
  protection: null,
  bodyText: "",
};

function quoteDisplayName(name: string): string {
  return /[,;:<>()[\]@\\"]/.test(name) ? `"${name.replace(/[\\"]/g, "\\$&")}"` : name;
}

/** 'Display Name <address>' or the bare address (or the bare name for a group marker). */
function formatAddress(address: EmailAddress): string | null {
  const name = address.name?.trim();
  const mailbox = address.address?.trim();
  if (name && mailbox) {
    return `${quoteDisplayName(name)} <${mailbox}>`;
  }
  return mailbox || name || null;
}

function flattenAddresses(value: readonly EmailAddress[]): EmailAddress[] {
  const result: EmailAddress[] = [];
  for (const entry of value) {
    if (entry.group) {
      result.push(...flattenAddresses(entry.group));
    } else {
      result.push(entry);
    }
  }
  return result;
}

function addressObjects(value: HeaderValue | undefined): AddressObject[] {
  if (value === undefined || value === null || typeof value !== "object") {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  return list.filter(
    (entry): entry is AddressObject =>
      typeof entry === "object" &&
      entry !== null &&
      "value" in entry &&
      Array.isArray((entry as AddressObject).value),
  );
}

function addressList(value: HeaderValue | undefined): { formatted: string[]; count: number } {
  const all = addressObjects(value).flatMap((entry) => flattenAddresses(entry.value));
  const formatted: string[] = [];
  for (const address of all) {
    if (formatted.length >= MAX_ADDRESS_LIST_ENTRIES) {
      break;
    }
    const text = formatAddress(address);
    if (text) {
      formatted.push(text);
    }
  }
  return { formatted, count: all.length };
}

function headerText(value: HeaderValue | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : null;
  }
  return null;
}

interface ContentTypeInfo {
  readonly type: string;
  readonly params: Readonly<Record<string, string>>;
}

function contentTypeOf(headers: Headers | undefined): ContentTypeInfo | null {
  const value = headers?.get("content-type");
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    const structured = value as { value: unknown; params?: Record<string, string> };
    if (typeof structured.value === "string") {
      return { type: structured.value.toLowerCase(), params: structured.params ?? {} };
    }
  }
  return null;
}

function protectionOfPart(
  type: string,
  params: Readonly<Record<string, string>>,
  fileName: string | undefined,
): MessageMeta["protection"] {
  const name = (params.name ?? fileName ?? "").toLowerCase();
  if (type === RPMSG_CONTENT_TYPE || name.endsWith(".rpmsg")) {
    return "rights-protected";
  }
  if (PKCS7_MIME_TYPES.has(type)) {
    const smimeType = params["smime-type"];
    if (smimeType !== undefined) {
      // An explicit smime-type is authoritative (opaque signing uses the same file name).
      return ENVELOPED_SMIME_TYPES.has(smimeType.toLowerCase()) ? "smime-encrypted" : null;
    }
    if (name === "smime.p7m") {
      return "smime-encrypted";
    }
  }
  return null;
}

interface ParsedParts {
  headers: Headers | undefined;
  headerLines: HeaderLines;
  text: string | undefined;
  html: string | undefined;
  attachments: {
    contentType: string;
    disposition: string;
    contentId: string | undefined;
    fileName: string | undefined;
    params: Readonly<Record<string, string>>;
  }[];
}

function parseParts(raw: Buffer): Promise<ParsedParts> {
  return new Promise<ParsedParts>((resolve, reject) => {
    const parsed: ParsedParts = {
      headers: undefined,
      headerLines: [],
      text: undefined,
      html: undefined,
      attachments: [],
    };
    const parser = new MailParser({
      skipImageLinks: true,
      skipTextToHtml: true,
      skipTextLinks: true,
      // mailparser's own HTML to text conversion grows faster than linearly with deeply nested
      // markup (seconds at half a megabyte, minutes at two) and refuses long HTML with an error
      // that discards the whole parse: the search text of an HTML-only message comes from
      // htmlToPlainText instead.
      skipHtmlToText: true,
    });
    parser.on("error", (error: unknown) => reject(error));
    parser.on("headers", (headers: Headers) => {
      parsed.headers = headers;
      parsed.headerLines = (parser as unknown as { headerLines?: HeaderLines }).headerLines ?? [];
    });
    parser.on("data", (data: AttachmentStream | MessageText) => {
      if (data.type === "text") {
        // Only what the search keeps is held on to: the rest of a huge body is let go at once.
        const text = data.text;
        parsed.text =
          text !== undefined && text.length > MAX_BODY_TEXT_CHARS
            ? text.slice(0, MAX_BODY_TEXT_CHARS)
            : text;
        parsed.html =
          typeof data.html === "string" ? data.html.slice(0, HTML_TEXT_DEFAULT_LIMIT) : undefined;
        return;
      }
      const attachment = data as AttachmentStream;
      const contentType = contentTypeOf(attachment.headers);
      parsed.attachments.push({
        contentType: (
          attachment.contentType ||
          contentType?.type ||
          "application/octet-stream"
        ).toLowerCase(),
        disposition: (attachment.contentDisposition || "").toLowerCase(),
        contentId: attachment.contentId || undefined,
        fileName: attachment.filename,
        params: contentType?.params ?? {},
      });
      const content = attachment.content as Readable;
      content.on("end", () => attachment.release());
      content.on("error", () => attachment.release());
      content.resume();
    });
    parser.on("end", () => resolve(parsed));
    parser.end(raw);
  });
}

/**
 * The Date header, only when it really parses. mailparser substitutes the current
 * time for an unparseable Date header, which must never end up as a sent date.
 */
function sentAtOf(lines: HeaderLines): Date | null {
  const line = lines.find((entry) => entry.key.toLowerCase() === "date");
  return line ? parseHeaderDate(line.line.slice(line.line.indexOf(":") + 1)) : null;
}

function isUserAttachment(attachment: ParsedParts["attachments"][number]): boolean {
  if (attachment.disposition === "attachment") {
    return true;
  }
  if (attachment.contentType === "message/rfc822") {
    return true;
  }
  if (NON_ATTACHMENT_LEAF_TYPES.has(attachment.contentType)) {
    return false;
  }
  // A Content-ID means the HTML body refers to the part (cid:), it is not a user-facing attachment.
  return !attachment.contentId;
}

/** What a message that could not be parsed gets: empty metadata, marked as missing. */
export const UNAVAILABLE_MESSAGE_META: MessageMeta = { ...EMPTY_MESSAGE_META, unavailable: true };

/** Never throws: an unparseable message yields empty metadata. Runs in the child process. */
export async function parseMessageMetaInProcess(raw: Buffer): Promise<MessageMeta> {
  try {
    const parsed = await parseParts(raw);
    const headers = parsed.headers ?? new Map<string, HeaderValue>();

    const rawId = headerText(headers.get("message-id"))?.trim();
    const from = addressObjects(headers.get("from"))
      .flatMap((entry) => flattenAddresses(entry.value))
      .map(formatAddress)
      .find((text): text is string => text !== null);
    const to = addressList(headers.get("to"));
    const cc = addressList(headers.get("cc"));

    const sentAt = sentAtOf(parsed.headerLines);

    const attachmentCount = parsed.attachments.filter(isUserAttachment).length;

    let protection: MessageMeta["protection"] = null;
    const root = contentTypeOf(parsed.headers);
    if (root) {
      protection = protectionOfPart(root.type, root.params, undefined);
    }
    for (const attachment of parsed.attachments) {
      protection ??= protectionOfPart(
        attachment.contentType,
        attachment.params,
        attachment.fileName,
      );
    }

    let bodyText = parsed.text ?? "";
    if (bodyText.length === 0 && parsed.html) {
      bodyText = htmlToPlainText(parsed.html);
    }
    if (bodyText.length > MAX_BODY_TEXT_CHARS) {
      bodyText = bodyText.slice(0, MAX_BODY_TEXT_CHARS);
    }

    return {
      messageId: rawId ? rawId : null,
      subject: headerText(headers.get("subject"))?.trim() ?? "",
      from: from ?? null,
      to: to.formatted,
      toCount: to.count,
      cc: cc.formatted,
      ccCount: cc.count,
      hasAttachments: attachmentCount > 0,
      attachmentCount,
      sentAt,
      protection,
      bodyText,
    };
  } catch {
    return UNAVAILABLE_MESSAGE_META;
  }
}
