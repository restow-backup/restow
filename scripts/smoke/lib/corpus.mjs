/**
 * Deterministic synthetic mail for the smoke. Everything derives from a seed,
 * so a run is reproducible and the messages carry no real person or data: the
 * addresses are on the reserved domain smoke.test, the text is generic. The
 * messages exercise what a mail backup must keep byte for byte: non-ASCII
 * headers and bodies, an HTML alternative, binary attachments, long lines and
 * a folder structure.
 */
import { createHash } from "node:crypto";

/** mulberry32: a small seeded generator, good enough for test data. */
export function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJECTS = [
  "Quarterly numbers",
  "Angebot für Größe M",
  "Meeting moved to Thursday",
  "Rechnung 2026-0042",
  "Re: shipping schedule",
  "Fwd: contract draft",
  "Lunch on Friday?",
  "Wartungsfenster am Wochenende",
];

const PARAGRAPHS = [
  "The figures for the last quarter are attached. Please check them before Friday.",
  "Bitte bestätigen Sie den Termin. Die Größenangaben finden Sie im Anhang.",
  "We moved the maintenance window to the weekend so the office stays unaffected.",
  "Vielen Dank für Ihre Nachricht. Wir melden uns, sobald die Prüfung abgeschlossen ist.",
];

const CRLF = "\r\n";

function foldBase64(buffer) {
  return (
    buffer
      .toString("base64")
      .match(/.{1,76}/gu)
      ?.join(CRLF) ?? ""
  );
}

function encodedWord(text) {
  return /^[\x20-\x7e]*$/u.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/**
 * Build message number `index` of a corpus. `withAttachment` messages carry a
 * pseudo-random binary attachment of `attachmentBytes` bytes.
 */
export function buildMessage({
  seed,
  index,
  mailbox,
  domain = "smoke.test",
  attachmentBytes = 4096,
}) {
  const random = prng(seed * 7919 + index);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const subject = `${pick(SUBJECTS)} #${index}`;
  const date = new Date(Date.UTC(2026, 0, 5 + (index % 120), 8 + (index % 9), index % 60, 0));
  const boundary = `----smoke-${seed}-${index}`;
  const altBoundary = `----smoke-alt-${seed}-${index}`;
  const text = `${pick(PARAGRAPHS)}${CRLF}${CRLF}${pick(PARAGRAPHS)}${CRLF}${"x".repeat(200 + Math.floor(random() * 700))}${CRLF}`;
  const html = `<html><body><p>${pick(PARAGRAPHS)}</p><p><b>${subject}</b></p></body></html>${CRLF}`;
  const withAttachment = index % 3 === 0;
  const headers = [
    `From: Sender ${index % 5} <sender${index % 5}@${domain}>`,
    `To: ${mailbox}`,
    `Subject: ${encodedWord(subject)}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <smoke-${seed}-${index}@${domain}>`,
    "MIME-Version: 1.0",
  ];
  const alternative = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    foldBase64(Buffer.from(text, "utf8")),
    `--${altBoundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    foldBase64(Buffer.from(html, "utf8")),
    `--${altBoundary}--`,
  ].join(CRLF);
  let body;
  if (withAttachment) {
    const attachment = Buffer.alloc(attachmentBytes);
    for (let at = 0; at < attachment.length; at += 1) {
      attachment[at] = Math.floor(random() * 256);
    }
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      alternative,
      `--${boundary}`,
      `Content-Type: application/octet-stream; name="data-${index}.bin"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="data-${index}.bin"`,
      "",
      foldBase64(attachment),
      `--${boundary}--`,
      "",
    ].join(CRLF);
  } else {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    body = `${alternative}${CRLF}`;
  }
  return Buffer.from(`${headers.join(CRLF)}${CRLF}${CRLF}${body}`, "utf8");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Normalise line endings to CRLF: what IMAP transports, whatever a server stores. */
export function toCrlf(bytes) {
  return Buffer.from(bytes.toString("latin1").replace(/\r?\n/gu, "\r\n"), "latin1");
}

/**
 * The corpus of a mailbox: `count` messages, the first `inboxCount` for INBOX
 * and the rest for the folder "Archive 2026", so folders are covered.
 */
export function buildCorpus({
  seed,
  mailbox,
  count,
  folders = { INBOX: 0.7, "Archive 2026": 0.3 },
}) {
  const names = Object.keys(folders);
  const messages = [];
  let assigned = 0;
  for (const [position, folder] of names.entries()) {
    const share =
      position === names.length - 1 ? count - assigned : Math.round(count * folders[folder]);
    for (let n = 0; n < share; n += 1) {
      const index = assigned + n + 1;
      messages.push({ folder, index, bytes: buildMessage({ seed, index, mailbox }) });
    }
    assigned += share;
  }
  return messages.map((message) => ({ ...message, sha256: sha256(message.bytes) }));
}
