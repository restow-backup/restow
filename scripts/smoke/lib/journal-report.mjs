/**
 * A synthetic Exchange Online journal report (docs/IMAP.md): a plain-text
 * envelope naming the sender and every envelope recipient, plus the original
 * message attached as message/rfc822, the shape the archive's journal parser
 * (packages/core/src/archive/journal.ts) reads.
 */
const CRLF = "\r\n";

export function buildJournalReport({
  journalAddress,
  original,
  sender,
  subject,
  messageId,
  to,
  cc = [],
  bcc = [],
}) {
  const boundary = "RESTOW-SMOKE-JOURNAL-BOUNDARY";
  const envelope = [
    `Sender: ${sender}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    ...to.map((address) => `To: ${address}`),
    ...cc.map((address) => `Cc: ${address}`),
    ...bcc.map((address) => `Bcc: ${address}`),
  ].join(CRLF);
  const head = [
    "From: journal@contoso.onmicrosoft.com",
    `To: ${journalAddress}`,
    "Subject: Journal Report",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    envelope,
    `--${boundary}`,
    "Content-Type: message/rfc822",
    'Content-Disposition: attachment; filename="original.eml"',
    "",
  ].join(CRLF);
  return Buffer.concat([
    Buffer.from(`${head}${CRLF}`, "utf8"),
    original,
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf8"),
  ]);
}
