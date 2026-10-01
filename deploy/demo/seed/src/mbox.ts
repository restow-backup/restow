/**
 * An mbox file (mboxrd) from complete RFC 5322 messages, for the demo's mail
 * archive: the archive is filled through the product's own mail file import,
 * and one mbox per folder is the smallest upload that keeps the folder
 * structure. Lines end in CRLF throughout (the importer keeps a message's
 * bytes as they are), a line starting with `From ` inside a message gets one
 * more `>` in front, as mboxrd says, and the importer takes it off again.
 */

export interface MboxMessage {
  /** The envelope sender shown on the `From ` line (an address). */
  from: string;
  /** The message's own date, shown on the `From ` line in asctime form. */
  date: Date;
  /** The whole message, headers and body, with any line ending. */
  eml: string;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** `Mon Sep  1 12:00:00 2026` (UTC), the date format of an mbox `From ` line. */
export function asctime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${date.getUTCFullYear()}`;
}

/** mboxrd quoting: one `>` more in front of every `From ` or `>...>From ` line. */
export function quoteFromLines(text: string): string {
  return text.replace(/^(>*From )/gm, ">$1");
}

export function buildMbox(messages: readonly MboxMessage[]): Buffer {
  const parts: string[] = [];
  for (const message of messages) {
    const body = quoteFromLines(message.eml.replace(/\r?\n/g, "\r\n")).replace(/(\r\n)+$/, "");
    parts.push(`From ${message.from} ${asctime(message.date)}\r\n${body}\r\n\r\n`);
  }
  return Buffer.from(parts.join(""), "utf8");
}
