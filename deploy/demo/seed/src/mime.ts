/**
 * A small RFC 5322 / MIME message builder (no library, no new dependency),
 * for the demo mail generator: a plain-text body, optionally with one or
 * more attachments (multipart/mixed). Messages are written straight into
 * Maildir (maildir.ts), never sent over SMTP, so 8-bit UTF-8 bodies need no
 * quoted-printable or base64 encoding — only attachments are base64.
 */

export interface Correspondent {
  name: string;
  email: string;
}

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer | string;
}

export interface MimeMessageInput {
  from: Correspondent;
  to: Correspondent;
  cc?: readonly Correspondent[];
  subject: string;
  date: Date;
  textBody: string;
  /** The local part of the Message-ID (without "<" ">" or "@domain"). */
  messageId: string;
  attachments?: readonly Attachment[];
  inReplyTo?: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate ASCII range check (0x00-0x7F).
const ASCII_ONLY = /^[\x00-\x7F]*$/;

/** RFC 2047 "B" encoding for a header value that is not plain ASCII. */
function encodeHeaderValue(value: string): string {
  return ASCII_ONLY.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function addressHeader(person: Correspondent): string {
  return `${encodeHeaderValue(person.name)} <${person.email}>`;
}

/** Base64, wrapped at 76 octets per line as RFC 2045 requires. */
function base64Wrapped(data: Buffer): string {
  const encoded = data.toString("base64");
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join("\r\n");
}

function boundaryFrom(messageId: string): string {
  return `----restow-demo-${messageId.replace(/[^a-zA-Z0-9]/g, "")}`;
}

function attachmentContent(attachment: Attachment): Buffer {
  return typeof attachment.content === "string"
    ? Buffer.from(attachment.content, "utf8")
    : attachment.content;
}

/** Build a complete `.eml`-ready RFC 5322 message (CRLF line endings). */
export function buildEmlMessage(input: MimeMessageInput): string {
  const headers = [
    `From: ${addressHeader(input.from)}`,
    `To: ${addressHeader(input.to)}`,
    input.cc && input.cc.length > 0 ? `Cc: ${input.cc.map(addressHeader).join(", ")}` : null,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    `Message-ID: <${input.messageId}>`,
    input.inReplyTo ? `In-Reply-To: <${input.inReplyTo}>` : null,
    "MIME-Version: 1.0",
  ].filter((line): line is string => line !== null);

  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.textBody,
      "",
    ].join("\r\n");
  }

  const boundary = boundaryFrom(input.messageId);
  const parts: string[] = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.textBody,
    "",
  ];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "",
      base64Wrapped(attachmentContent(attachment)),
      "",
    );
  }
  parts.push(`--${boundary}--`, "");

  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join(
    "\r\n",
  );
}
