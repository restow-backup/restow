import { htmlToPlainText } from "@restow/core/html-text";
import type {
  AddressObject,
  Attachment,
  EmailAddress,
  HeaderValue,
  ParsedMail,
  StructuredHeader,
} from "mailparser";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import { type MailProtection, mailSummaryOf, splitAddressList } from "./tree.js";

/**
 * Turns the raw bytes of one backed-up message into the mail preview
 * (routes.ts `GET .../preview`), and locates one of its attachments for
 * download. Pure and storage-free: everything here operates on a Buffer
 * already read from the chunk store (content.ts), so it is unit-tested with
 * fixture bytes, never a live backend.
 *
 * The parse is hostile-input work: mailparser and the sanitiser are not linear
 * for every message (a quoted-printable body of soft line breaks took 48 seconds
 * for 18 MB, deeply nested markup minutes), a text turned into HTML is one
 * allocation of several times its size, and the message may be one that was
 * imported from a file somebody else made. The API never calls these functions on
 * its own event loop for stored mail: ./preview-isolated.ts runs them in a child
 * process with a memory and a time limit. The functions here are the process's code
 * (`buildPreviewTask`, `findAttachmentTask`) and the unit tests' entry points.
 *
 * Rights-protected (IRM/Purview) and S/MIME-encrypted mail is opaque to
 * mailparser by design (it cannot decrypt either), so it is detected from the
 * message structure itself (never assumed from a missing flag) and never
 * reaches the HTML sanitiser: there is nothing safe to render.
 */

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

/**
 * Messages above this are not previewed: parsing and sanitising happens in
 * memory, and a mailbox can hold messages far larger than anyone reads inline
 * (docs/MICROSOFT.md: Graph itself falls back to a JSON/attachments export
 * above its own MIME export limit, handled separately below). 15 MiB comfortably
 * covers ordinary mail with a few embedded images while keeping one preview
 * request's memory use bounded.
 */
export const PREVIEW_SIZE_CAP_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface PreviewHeaders {
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  /** ISO-8601; the `Date:` header (parsed mail) or the manifest's recorded date. */
  date: string | null;
  messageId: string | null;
}

export interface PreviewAttachmentDto {
  /** `att-<index>`: this attachment's position in the message; stable for one snapshot. */
  id: string;
  filename: string | null;
  contentType: string;
  size: number;
  inline: boolean;
}

export type MailPreviewUnavailableReason =
  | "rights-protected"
  | "smime-encrypted"
  | "too-large"
  /** The Graph JSON/attachments fallback for a message too large to export as MIME. */
  | "unsupported-format"
  /** Parsing the message ran over its time or memory limit, or the parser gave up on it. */
  | "unreadable";

export type MailPreviewDto =
  | {
      previewable: true;
      headers: PreviewHeaders;
      body: { kind: "html" | "text"; content: string };
      attachments: PreviewAttachmentDto[];
      /**
       * True when the formatted view was not prepared (it ran over its limits, or the HTML is too
       * long to sanitise) and the plain text of the message is shown instead (the HTML turned into
       * text by a linear converter).
       */
      simplified?: true;
    }
  | {
      previewable: false;
      reason: MailPreviewUnavailableReason;
      headers: PreviewHeaders;
      attachments: [];
    };

// ---------------------------------------------------------------------------
// Headers without reading content (metadata shortcut / too-large / protected)
// ---------------------------------------------------------------------------

function pickMessageId(metadata: Record<string, unknown> | null): string | null {
  const value = metadata?.messageId ?? metadata?.internetMessageId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Headers from the manifest's own metadata, for a preview that never opens the content. */
export function headersFromMetadata(metadata: Record<string, unknown> | null): PreviewHeaders {
  const mail = mailSummaryOf(metadata);
  return {
    subject: mail.subject,
    from: mail.from,
    to: splitAddressList(mail.to),
    cc: splitAddressList(mail.cc),
    date: mail.sentDateTime ?? mail.date,
    messageId: pickMessageId(metadata),
  };
}

/** A not-previewable result built from the manifest alone (no chunk read needed). */
export function unavailablePreview(
  reason: MailPreviewUnavailableReason,
  metadata: Record<string, unknown> | null,
): MailPreviewDto {
  return { previewable: false, reason, headers: headersFromMetadata(metadata), attachments: [] };
}

// ---------------------------------------------------------------------------
// Protection detection
// ---------------------------------------------------------------------------

export interface TopLevelContentType {
  readonly type: string;
  readonly params: Record<string, string>;
}

/**
 * The Content-Type of the outermost MIME part, read directly off the raw
 * header block (before the first blank line), tolerant of folded header
 * lines. Used to recognise an S/MIME-enveloped message
 * (`application/pkcs7-mime`) without asking mailparser to decode content it
 * cannot decrypt.
 */
export function parseTopLevelContentType(bytes: Buffer): TopLevelContentType | null {
  const head = bytes.subarray(0, Math.min(bytes.length, 64 * 1024)).toString("latin1");
  const blankLine = head.search(/\r?\n\r?\n/);
  const headerBlock = blankLine >= 0 ? head.slice(0, blankLine) : head;
  // A folded header continues on a following line that starts with whitespace.
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const match = /^content-type:[ \t]*(.*)$/im.exec(unfolded);
  if (!match) {
    return null;
  }
  const segments = (match[1] ?? "")
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const type = (segments.shift() ?? "").toLowerCase();
  if (type.length === 0) {
    return null;
  }
  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const name = segment.slice(0, eq).trim().toLowerCase();
    let value = segment.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    params[name] = value;
  }
  return { type, params };
}

/** An attachment that carries an IRM/Purview rights-protected message ("message.rpmsg"). */
const RPMSG_CONTENT_TYPE = /^application\/(x-microsoft-rpmsg-message|x-microsoft-rms-message)$/i;

/**
 * An S/MIME enveloped (encrypted) message's outermost type. RFC 8551 asks
 * receivers to also accept the legacy `x-pkcs7-mime` spelling, which older
 * senders (and some gateways) still use.
 */
const SMIME_ENVELOPE_CONTENT_TYPE = /^application\/(x-)?pkcs7-mime$/i;

/** The conventional file name of an S/MIME enveloped part, as a last-resort signal. */
const SMIME_ENVELOPE_FILENAME = /^smime\.p7m$/i;

/**
 * An S/MIME `smime-type` value that means the part is actually encrypted
 * (RFC 8551 §3.2 `enveloped-data`, or RFC 8551bis `authEnveloped-data`).
 * Mirrors `ENVELOPED_SMIME_TYPES` in
 * `packages/core/src/backup/imap/imapflow-connector.ts` and
 * `packages/core/src/backup/exchange/mail.ts`: an explicit `smime-type` is
 * authoritative, so `signed-data`, `compressed-data` or any other value is
 * *not* encrypted even though `application/pkcs7-mime` conventionally
 * carries all of them, and must not be flagged.
 */
const ENVELOPED_SMIME_TYPES = new Set(["enveloped-data", "authenveloped-data"]);

/**
 * Whether one `application/(x-)pkcs7-mime` part (top-level or nested) is
 * itself S/MIME-enveloped data, by the same rule the backup engines apply to
 * BODYSTRUCTURE: an explicit `smime-type` decides it outright (only
 * {@link ENVELOPED_SMIME_TYPES} counts as encrypted); a part with no
 * `smime-type` at all falls back to the conventional `smime.p7m` name.
 * Returns `null` outright for anything that is not a pkcs7-mime part.
 */
function protectionOfPkcs7Part(
  contentType: string,
  params: Record<string, string>,
  filename: string,
): MailProtection | null {
  if (!SMIME_ENVELOPE_CONTENT_TYPE.test(contentType)) {
    return null;
  }
  const smimeType = params["smime-type"];
  if (smimeType !== undefined) {
    return ENVELOPED_SMIME_TYPES.has(smimeType.toLowerCase()) ? "smime-encrypted" : null;
  }
  return SMIME_ENVELOPE_FILENAME.test(filename) ? "smime-encrypted" : null;
}

/** The `content-type` header's parsed parameters, when mailparser kept it structured. */
function contentTypeParamsOf(header: HeaderValue | undefined): Record<string, string> {
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    "params" in value
    ? (value as StructuredHeader).params
    : {};
}

/**
 * Whether an attachment-list part (nested anywhere in the MIME tree, as
 * mailparser flattens it) is itself rights-protected or S/MIME-enveloped.
 */
function protectionOfAttachment(
  attachment: Pick<Attachment, "contentType" | "filename" | "headers">,
): MailProtection | null {
  const filename = (attachment.filename ?? "").toLowerCase();
  if (RPMSG_CONTENT_TYPE.test(attachment.contentType) || filename.endsWith(".rpmsg")) {
    return "rights-protected";
  }
  const params = contentTypeParamsOf(attachment.headers.get("content-type"));
  return protectionOfPkcs7Part(attachment.contentType, params, filename);
}

/**
 * Whether the message is rights-protected or S/MIME-encrypted, detected from
 * its actual MIME structure so it is found even for a restore point recorded
 * before the backup engines started setting `metadata.protection` — and even
 * when the enveloped part is nested inside an outer `multipart/mixed` (as
 * some gateways do to attach a disclaimer next to the encrypted part), not
 * only at the very top of the message. A signed (not encrypted) S/MIME
 * message is not flagged: its content is still plain MIME and safe to
 * preview, only its signature attachment is opaque.
 */
export function detectProtection(
  bytes: Buffer,
  parsed: Pick<ParsedMail, "attachments">,
): MailProtection | null {
  const topLevel = parseTopLevelContentType(bytes);
  if (topLevel) {
    const topLevelFilename = topLevel.params.name ?? topLevel.params.filename ?? "";
    const byPkcs7Type = protectionOfPkcs7Part(topLevel.type, topLevel.params, topLevelFilename);
    if (byPkcs7Type) {
      return byPkcs7Type;
    }
    // A message mislabelled with a generic content type (e.g.
    // application/octet-stream) is still recognised by the conventional
    // smime.p7m name of its one and only part — a fallback the backup
    // engines cannot afford (they only ever see BODYSTRUCTURE, never the
    // full content), but the API reads the whole message anyway. Only when
    // the type is not already a recognised pkcs7-mime type, so this never
    // overrides an explicit non-enveloped `smime-type` such as `signed-data`.
    if (
      !SMIME_ENVELOPE_CONTENT_TYPE.test(topLevel.type) &&
      SMIME_ENVELOPE_FILENAME.test(topLevelFilename)
    ) {
      return "smime-encrypted";
    }
  }
  for (const attachment of parsed.attachments) {
    const found = protectionOfAttachment(attachment);
    if (found) {
      return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML sanitisation
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = [
  "a",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "p",
  "br",
  "hr",
  "div",
  "span",
  "ul",
  "ol",
  "li",
  "table",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "img",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "code",
  "font",
  "center",
  "sub",
  "sup",
  "small",
];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  "*": [
    "style",
    "class",
    "align",
    "valign",
    "width",
    "height",
    "dir",
    "lang",
    "title",
    "border",
    "cellpadding",
    "cellspacing",
    "bgcolor",
  ],
  a: ["href", "name", "target", "rel"],
  img: ["src", "alt", "width", "height", "title"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  font: ["color", "face", "size"],
};

/**
 * The code point a single CSS hex escape (`\XX`) decodes to, per CSS Syntax
 * Level 3 §4.3.7: zero, a surrogate half (U+D800-U+DFFF, never a valid
 * scalar value on its own) or anything above the last Unicode code point
 * (U+10FFFF) is not a valid argument to `String.fromCodePoint` and must map
 * to U+FFFD (REPLACEMENT CHARACTER) instead of throwing. Without this, an
 * attacker-controlled style value such as `color:\FFFFFF` or `\110000`
 * throws a RangeError that escapes sanitize-html and turns the whole preview
 * into an opaque 500 instead of a merely-odd-looking safe render.
 */
function cssEscapedCodePoint(hex: string): string {
  const value = Number.parseInt(hex, 16);
  if (value === 0 || (value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) {
    return "�";
  }
  return String.fromCodePoint(value);
}

/**
 * Decode CSS backslash escapes (a `\XX` hex code point, optionally followed by
 * the one whitespace character that terminates it per the CSS spec, or a
 * literal `\<char>`) once. Without this, `\75 rl(` or `u\rl(` reads as
 * harmless text but every browser decodes it to `url(`, letting a remote
 * image slip past a naive string search. Used by {@link decodeCssEscapesFully}
 * below, which repeats this to a fixpoint.
 */
function decodeCssEscapes(value: string): string {
  return value.replace(
    /\\([0-9a-fA-F]{1,6})\s?|\\(.)/g,
    (_match, hex?: string, literal?: string) => (hex ? cssEscapedCodePoint(hex) : (literal ?? "")),
  );
}

/**
 * {@link decodeCssEscapes}, repeated to a fixpoint (bounded to a handful of
 * passes; each pass only ever shortens the string, so this terminates
 * quickly). One pass can itself produce a new escape sequence: decoding
 * `\5c 75rl(` once yields the literal text `\75rl(` (a backslash from the
 * `\5c` escape, followed by the untouched digits `75rl(`), which still
 * starts with a valid CSS escape (`\75` = `u`) that a second pass — or a
 * browser re-tokenising the same text — turns into `url(`. Returning a
 * once-decoded string that still hides an escape is exactly how a previous
 * version of this function let a doubly-escaped `url(` back in: it decoded
 * once, found no literal "url(" substring, and shipped the partially-decoded
 * (but still escape-bearing) text unchanged.
 *
 * Returns `null` when the value still changed on the final pass, i.e. the
 * loop's own pass budget ran out before a fixpoint was confirmed: nesting
 * the escape one level deeper always costs the attacker only one more
 * `\5c `, so a fixed pass budget can never be raised high enough to promise
 * a fixpoint for every input, and the caller must treat "no fixpoint yet"
 * the same as any other value it cannot safely neuter (see
 * {@link hardenStyleValue}) rather than ship a partially-decoded string that
 * a browser's own CSS tokeniser would go on to decode further.
 */
function decodeCssEscapesFully(value: string): string | null {
  let current = value;
  for (let pass = 0; pass < 10; pass += 1) {
    const next = decodeCssEscapes(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
  return null;
}

const CSS_SINGLE_QUOTED_STRING = String.raw`'(?:[^'\\]|\\.)*'`;
const CSS_DOUBLE_QUOTED_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const CSS_QUOTED_STRING = `(?:${CSS_SINGLE_QUOTED_STRING}|${CSS_DOUBLE_QUOTED_STRING})`;
/**
 * One "safe" character of a `url(...)` argument: anything but a paren or a
 * quote, or an entire quoted string — which may itself contain unescaped
 * parens (`url('https://x/a(1).png')` is valid CSS: the quotes, not
 * parenthesis balancing, delimit the argument there).
 */
const CSS_FUNCTION_ARG_TOKEN = `(?:${CSS_QUOTED_STRING}|[^()'"])`;
/** One level of real (unquoted) paren nesting, e.g. `url(...)` inside `image-set(...)`. */
const CSS_NESTED_PAREN_GROUP = String.raw`\((?:${CSS_FUNCTION_ARG_TOKEN})*\)`;
const CSS_IMAGE_SET_ARG_TOKEN = `(?:${CSS_QUOTED_STRING}|${CSS_NESTED_PAREN_GROUP}|[^()'"])`;

/**
 * A CSS `url(...)`, `image-set(...)` or `-webkit-image-set(...)` function
 * call. Quote-aware (a quoted argument's own parentheses do not end the
 * match early) and tolerant of one level of real nesting (`image-set(url(...) 1x)`).
 */
const CSS_URL_FUNCTION = new RegExp(
  `(?:-webkit-)?image-set\\((?:${CSS_IMAGE_SET_ARG_TOKEN})*\\)|url\\((?:${CSS_FUNCTION_ARG_TOKEN})*\\)`,
  "gi",
);

/** Old Internet Explorer's `expression()` (arbitrary script in a CSS value) or a nested stylesheet import. */
const CSS_UNNEUTERABLE = /@import\b|expression\s*\(/i;

/**
 * Defence in depth after the precise `url()`/`image-set()` neutering below:
 * any of these function names still followed by real content means either
 * the extent-matching regex above did not fully consume a call it should
 * have, or the value carries a CSS image function this sanitiser does not
 * explicitly neuter (`image()`, `cross-fade()`, `element()`, all of which can
 * also fetch a remote resource). The already-neutered placeholders
 * (`url()`, `image-set()`) never match: `[^)]` requires a character between
 * the parens, and theirs are immediately closed.
 */
const CSS_DANGEROUS_FUNCTION_WITH_ARGS =
  /\b(?:url|image-set|-webkit-image-set|image|cross-fade|element)\s*\([^)]/i;

/**
 * Removes every remote resource reference from one element's inline `style=`
 * value: `url(...)`/`image-set(...)` calls are replaced with their empty,
 * argument-less form (still invalid CSS, so the browser drops the whole
 * declaration, but nothing is fetched); a value that carries `@import` or
 * `expression(...)`, that still looks like a live function call after
 * neutering (see {@link CSS_DANGEROUS_FUNCTION_WITH_ARGS}), or whose escapes
 * {@link decodeCssEscapesFully} could not decode to a confirmed fixpoint
 * within its pass budget, is dropped outright — the same treatment as an
 * un-neuterable `@import`, and for the same reason: a value still capable of
 * changing under one more decode pass is a value this function has not
 * actually finished reading. Escapes are decoded to a fixpoint first and the
 * *decoded* text is what gets shipped: emitting a once-decoded string that
 * still contains a backslash lets a browser's own CSS tokeniser decode it a
 * second time, reconstituting the very call this function is trying to
 * remove. Applied only to the `style` attribute, never to the message body
 * at large, so ordinary text or link targets that happen to contain the
 * text "url(" are left untouched.
 */
function hardenStyleValue(value: string): string {
  const decoded = decodeCssEscapesFully(value);
  if (decoded === null) {
    return "";
  }
  if (CSS_UNNEUTERABLE.test(decoded)) {
    return "";
  }
  const neutered = decoded.replace(CSS_URL_FUNCTION, (match) =>
    /image-set/i.test(match) ? "image-set()" : "url()",
  );
  return CSS_DANGEROUS_FUNCTION_WITH_ARGS.test(neutered) ? "" : neutered;
}

/** An `<img src>` this preview will render: an embedded (`cid:`-inlined) image, nothing fetched over the network. */
function isInlineImageSource(src: string | undefined): boolean {
  return typeof src === "string" && src.toLowerCase().startsWith("data:image/");
}

/**
 * Sanitises one message's HTML body for the browser: no script, no
 * event-handler attribute, no form or interactive control, no iframe/object/
 * embed, no `<style>` block, no remote image and no CSS `url()`/`image-set()`
 * in an inline style (including the protocol-relative, backslash-escaped,
 * relative-path and CSS-escaped forms browsers still resolve to a remote
 * fetch), links open in a new tab without leaking a referrer. `<style>` is
 * not in the allowlist at all (sanitize-html's own advice: a style block is a
 * bigger attack surface than it is worth for a read-only preview);
 * per-element `style=` attributes still carry ordinary formatting.
 * `allowProtocolRelative: false` closes the `//host` and `\\host` forms of a
 * remote image (browsers normalise a backslash to a slash here); an image
 * whose `src` is not an embedded `data:image/…` URI is dropped outright,
 * which also closes a same-origin relative path that could resolve against
 * whichever page ends up hosting this preview. `cid:` images are already
 * inlined as `data:` URIs by mailparser before this runs (it does so by
 * default), so nothing legitimate is lost.
 */
export function sanitizeMailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    exclusiveFilter: (frame) => frame.tag === "img" && !isInlineImageSource(frame.attribs.src),
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }, true),
      "*": (tagName, attribs) => {
        if (typeof attribs.style !== "string") {
          return { tagName, attribs };
        }
        const hardened = hardenStyleValue(attribs.style);
        if (hardened.trim().length > 0) {
          return { tagName, attribs: { ...attribs, style: hardened } };
        }
        // No `delete`: build the attributes fresh instead, without `style`.
        const { style: _droppedStyle, ...withoutStyle } = attribs;
        return { tagName, attribs: withoutStyle };
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Headers and body from a parsed message
// ---------------------------------------------------------------------------

function formatAddress(address: EmailAddress): string {
  if (address.group && address.group.length > 0) {
    return address.group
      .map(formatAddress)
      .filter((s) => s.length > 0)
      .join(", ");
  }
  const name = address.name?.trim();
  return name ? `${name} <${address.address ?? ""}>` : (address.address ?? "");
}

function addressListOf(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) {
    return [];
  }
  const objects = Array.isArray(value) ? value : [value];
  return objects
    .flatMap((object) => object.value)
    .map(formatAddress)
    .filter((entry) => entry.length > 0);
}

function headersFromParsed(parsed: ParsedMail): PreviewHeaders {
  const from = addressListOf(parsed.from ? [parsed.from] : undefined);
  return {
    subject: parsed.subject ?? null,
    from: from[0] ?? null,
    to: addressListOf(parsed.to),
    cc: addressListOf(parsed.cc),
    date: parsed.date ? parsed.date.toISOString() : null,
    messageId: parsed.messageId ?? null,
  };
}

function bodyOf(parsed: ParsedMail): { kind: "html" | "text"; content: string } {
  if (typeof parsed.html === "string" && parsed.html.trim().length > 0) {
    return { kind: "html", content: sanitizeMailHtml(parsed.html) };
  }
  return { kind: "text", content: parsed.text ?? "" };
}

function attachmentIdOf(index: number): string {
  return `att-${index}`;
}

/** The array index encoded in an `att-<n>` id, or null when it is not one. */
export function attachmentIndexOf(attachmentId: string): number | null {
  const match = /^att-(\d+)$/.exec(attachmentId);
  return match ? Number(match[1]) : null;
}

function attachmentDtoOf(attachment: Attachment, index: number): PreviewAttachmentDto {
  return {
    id: attachmentIdOf(index),
    filename: attachment.filename ?? null,
    contentType: attachment.contentType,
    size: attachment.size,
    inline: attachment.contentDisposition === "inline" || attachment.related === true,
  };
}

/** `full`: sanitised HTML with inline images; `text`: the plain text only, the fallback for a message the full view cannot handle in time. */
export type PreviewMode = "full" | "text";

export interface BuildPreviewOptions {
  readonly mode?: PreviewMode;
}

/**
 * HTML longer than this (in characters, inlined images included) is not sanitised: the sanitiser
 * builds a string of about the same size several times over, and a body of this size is not read
 * as formatted mail anyway. The text of it is shown instead.
 */
export const MAX_SANITIZED_HTML_CHARS = 12 * 1024 * 1024;

/** The text of the message: its text part, or its HTML turned into text by the linear converter. */
function plainBodyOf(parsed: ParsedMail): { kind: "text"; content: string } {
  if (typeof parsed.text === "string" && parsed.text.trim().length > 0) {
    return { kind: "text", content: parsed.text };
  }
  return {
    kind: "text",
    content:
      typeof parsed.html === "string" ? htmlToPlainText(parsed.html, Number.POSITIVE_INFINITY) : "",
  };
}

/**
 * Parse raw MIME bytes into the preview DTO. mailparser inlines `cid:`
 * embedded images as `data:` URIs by default (not disabled here), which is
 * exactly the "cid: images inlined" behaviour the preview promises. In `text`
 * mode nothing is inlined and nothing is sanitised: the body is plain text.
 * Nothing is asked of mailparser that is not shown: no text to HTML conversion
 * (`textAsHtml`: a 30 MB text becomes a 125 MB string in one allocation), no HTML to
 * text conversion, no link rewriting. Runs in a child process
 * (./preview-isolated.ts); never call it on the event loop for stored mail.
 */
export async function buildPreviewFromMime(
  bytes: Buffer,
  options: BuildPreviewOptions = {},
): Promise<MailPreviewDto> {
  const textOnly = options.mode === "text";
  const parsed = await simpleParser(bytes, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    ...(textOnly ? { skipImageLinks: true } : {}),
  });
  const headers = headersFromParsed(parsed);
  const protection = detectProtection(bytes, parsed);
  if (protection) {
    return { previewable: false, reason: protection, headers, attachments: [] };
  }
  const plain =
    textOnly || (typeof parsed.html === "string" && parsed.html.length > MAX_SANITIZED_HTML_CHARS);
  return {
    previewable: true,
    headers,
    body: plain ? plainBodyOf(parsed) : bodyOf(parsed),
    attachments: parsed.attachments.map((attachment, index) => attachmentDtoOf(attachment, index)),
    ...(plain ? { simplified: true as const } : {}),
  };
}

/** The task of the preview process. */
export function buildPreviewTask(
  bytes: Buffer,
  options?: BuildPreviewOptions,
): Promise<MailPreviewDto> {
  return buildPreviewFromMime(bytes, options);
}

// ---------------------------------------------------------------------------
// Attachment download
// ---------------------------------------------------------------------------

/**
 * Content types the browser would render as a page rather than offer to
 * save: HTML, XSLT and any XML-family type. `+xml` is a standard structured
 * syntax suffix (RFC 6839) that every `application/…+xml` or `text/…+xml`
 * type shares (`application/xhtml+xml`, `image/svg+xml`,
 * `application/rss+xml`, `application/atom+xml`, `application/mathml+xml`,
 * and any future one), so it is matched generically instead of one type at a
 * time. This is defence in depth only: `Content-Disposition: attachment` and
 * `X-Content-Type-Options: nosniff` already stop a browser from rendering
 * the response inline.
 */
const RENDERABLE_CONTENT_TYPES = new Set(["text/html", "text/xsl", "application/xml", "text/xml"]);
const RENDERABLE_EXTENSIONS = /\.(html?|xhtml|xht|mht|mhtml|xsl|svg|xml)$/i;

/** The MIME type without any `; charset=…` parameters, lower-cased for comparison. */
function baseContentType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The `Content-Type` an attachment download is served with: the declared type,
 * unless the browser would render it as a page (HTML, SVG, XML, and any other
 * `+xml` type), in which case `application/octet-stream` forces a save even
 * without `X-Content-Type-Options`.
 */
export function downloadContentType(
  attachment: Pick<Attachment, "contentType" | "filename">,
): string {
  const type = baseContentType(attachment.contentType);
  const risky =
    RENDERABLE_CONTENT_TYPES.has(type) ||
    type.endsWith("+xml") ||
    (attachment.filename !== undefined && RENDERABLE_EXTENSIONS.test(attachment.filename));
  return risky ? "application/octet-stream" : attachment.contentType;
}

/** An attachment as the download needs it: plain data, so it crosses the process boundary. */
export interface FoundAttachment {
  readonly filename?: string;
  readonly contentType: string;
  readonly size: number;
  readonly content: Buffer;
}

/**
 * One attachment of a message, by the id its preview listed it under.
 * Protected mail has no downloadable attachments (its preview lists none),
 * so it is refused here too, even if an old link is replayed.
 * Runs in a child process (./preview-isolated.ts).
 */
export async function findAttachment(
  bytes: Buffer,
  attachmentId: string,
): Promise<FoundAttachment | null> {
  const index = attachmentIndexOf(attachmentId);
  if (index === null) {
    return null;
  }
  const parsed = await simpleParser(bytes, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
  });
  if (detectProtection(bytes, parsed)) {
    return null;
  }
  const attachment = parsed.attachments[index];
  return attachment
    ? {
        ...(attachment.filename !== undefined ? { filename: attachment.filename } : {}),
        contentType: attachment.contentType,
        size: attachment.size,
        content: attachment.content,
      }
    : null;
}

/** The task of the preview process. */
export function findAttachmentTask(
  bytes: Buffer,
  options: { attachmentId: string },
): Promise<FoundAttachment | null> {
  return findAttachment(bytes, options.attachmentId);
}
