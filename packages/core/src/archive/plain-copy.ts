/**
 * Plain copies at the archive receiver (0.4.4, docs/IMAP.md "Weiterleitung"): mail a provider
 * forwards to an archive address as it is (Postfix BCC maps, mailcow, Sieve `redirect :copy`,
 * Google Workspace routing), as opposed to an Exchange journal report (./journal.ts).
 *
 * {@link isJournalReport} tells the two apart by the header Exchange Online puts on every
 * journal report (`X-MS-Journal-Report`), reading the header block only (bounded, on the
 * event loop). {@link parsePlainCopy} reads what the archive keeps of a plain copy: its own
 * headers' envelope (From, To, Cc and the Bcc a copy rarely carries), the headers that name
 * whom the provider delivered it to (`Delivered-To`, `X-Original-To` ...), Message-ID,
 * subject, body text, attachments and date. It runs in the receiver's isolated parser
 * processes (./journal-isolated.ts `parsePlainCopyIsolated`), never on the event loop.
 *
 * A forwarded copy has no recipient envelope of its own: the transaction's RCPT TO is the
 * archive address. Who received a mail as Bcc is therefore not visible in a copy unless the
 * provider wrote it into a header (docs/IMAP.md).
 */
import {
  type ArchiveFields,
  extractArchiveFieldsInProcess,
} from "../mailfiles/archive-fields-parse.js";

/** Most header bytes {@link isJournalReport} reads before it gives up. */
const HEADER_SCAN_BYTES = 256 * 1024;

/** The header block of a message (up to the first empty line, bounded), unfolded. */
export function headerBlock(raw: Buffer, limit = HEADER_SCAN_BYTES): string {
  const scan = raw.subarray(0, Math.min(raw.length, limit)).toString("latin1");
  const end = scan.search(/\r?\n\r?\n/);
  const block = end >= 0 ? scan.slice(0, end) : scan;
  return block.replace(/\r?\n[ \t]+/g, " ");
}

/**
 * Whether `raw` is an Exchange journal report: the `X-MS-Journal-Report` header Exchange
 * Online puts on every report, or (a report relayed without it) the report's structure, a
 * multipart message whose first part is the envelope text (`Sender:`, `Message-ID:` and a
 * recipient line). Reads at most the first {@link HEADER_SCAN_BYTES}.
 */
export function isJournalReport(raw: Buffer): boolean {
  const headers = headerBlock(raw);
  if (/^x-ms-journal-report\s*:/im.test(headers)) {
    return true;
  }
  const type = /^content-type\s*:\s*multipart\/[^;]*;(.*)$/im.exec(headers);
  const boundary = type ? /boundary\s*=\s*"?([^";\s]+)"?/i.exec(type[1] ?? "")?.[1] : undefined;
  if (!boundary) {
    return false;
  }
  const scan = raw.subarray(0, Math.min(raw.length, HEADER_SCAN_BYTES)).toString("latin1");
  const delimiter = `--${boundary}`;
  const start = scan.indexOf(delimiter);
  if (start < 0) {
    return false;
  }
  const end = scan.indexOf(delimiter, start + delimiter.length);
  const part = scan.slice(start + delimiter.length, end < 0 ? undefined : end);
  const bodyAt = part.search(/\r?\n\r?\n/);
  const text = bodyAt < 0 ? "" : part.slice(bodyAt);
  return (
    /^sender\s*:\s*\S/im.test(text) &&
    /^message-id\s*:\s*\S/im.test(text) &&
    /^(recipient|to|cc|bcc)\s*:\s*\S/im.test(text)
  );
}

/** Headers a provider adds to name the mailbox it delivered a copy for. */
const DELIVERED_TO_HEADERS = [
  "delivered-to",
  "x-original-to",
  "x-original-delivered-to",
  "x-gm-original-to",
  "envelope-to",
  "x-envelope-to",
];

const ADDRESS = /[^\s<>"',;:()[\]]+@[^\s<>"',;:()[\]]+/g;

/** Lowercase addresses of the delivered-to headers of a header block, once each. */
export function deliveredToAddresses(headers: string): string[] {
  const found = new Set<string>();
  for (const line of headers.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    if (!DELIVERED_TO_HEADERS.includes(line.slice(0, colon).trim().toLowerCase())) {
      continue;
    }
    for (const match of line.slice(colon + 1).matchAll(ADDRESS)) {
      found.add(match[0].toLowerCase());
      if (found.size >= 100) {
        return [...found];
      }
    }
  }
  return [...found];
}

export interface PlainCopy extends ArchiveFields {
  /** Who the provider delivered the copy for, from its delivered-to headers. */
  readonly deliveredTo: readonly string[];
}

/** Never throws (a message that cannot be parsed yields empty fields, `unavailable`). */
export async function parsePlainCopy(raw: Buffer): Promise<PlainCopy> {
  const fields = await extractArchiveFieldsInProcess(raw);
  return { ...fields, deliveredTo: deliveredToAddresses(headerBlock(raw)) };
}

/**
 * Entry point of the isolated child process (../mailfiles/isolate.ts): {@link parsePlainCopy}.
 * Use `parsePlainCopyIsolated` (./journal-isolated.ts) outside of it.
 */
export async function parsePlainCopyTask(input: Buffer): Promise<PlainCopy> {
  return parsePlainCopy(input);
}
