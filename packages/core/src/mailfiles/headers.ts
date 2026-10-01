/**
 * Light header helpers for the readers: enough to read status headers and the
 * first Received date from the top of a message without a MIME parse. Everything
 * here works on the header block only and never throws.
 */

export interface RawHeader {
  /** Lower-case field name. */
  readonly name: string;
  /** Unfolded, trimmed value (bytes read as latin1, so 8-bit text is not decoded). */
  readonly value: string;
}

/** The IMAP-style flags the readers derive, in a fixed order. */
const FLAG_ORDER = ["\\Seen", "\\Answered", "\\Flagged", "\\Draft"] as const;

/** Header blocks longer than this are cut (a header that big is not a mail header). */
const MAX_HEADER_BYTES = 1024 * 1024;

/** Read the header block at the start of a message: unfolded `name: value` pairs. */
export function readHeaderBlock(raw: Buffer, maxBytes = MAX_HEADER_BYTES): RawHeader[] {
  const text = raw.toString("latin1", 0, Math.min(raw.length, maxBytes));
  const headers: RawHeader[] = [];
  let name: string | null = null;
  let value = "";
  const flush = (): void => {
    if (name !== null) {
      headers.push({ name, value: value.trim() });
    }
    name = null;
    value = "";
  };
  let position = 0;
  while (position < text.length) {
    const newline = text.indexOf("\n", position);
    let line = newline === -1 ? text.slice(position) : text.slice(position, newline);
    position = newline === -1 ? text.length : newline + 1;
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (line.length === 0) {
      break;
    }
    if ((line[0] === " " || line[0] === "\t") && name !== null) {
      value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      break;
    }
    flush();
    name = line.slice(0, colon).trim().toLowerCase();
    value = line.slice(colon + 1);
  }
  flush();
  return headers;
}

export function headerValues(headers: readonly RawHeader[], name: string): string[] {
  return headers.filter((header) => header.name === name).map((header) => header.value);
}

/**
 * IMAP flags from the status headers mail programs leave in a message:
 * `Status` (mutt, mbox: R read, D deleted), `X-Status` (A answered, F flagged,
 * T draft, D deleted), `X-Mozilla-Status` (Thunderbird: hex bit field) and
 * `X-Unsent: 1` (Outlook draft saved as EML). `\Deleted` is never carried over.
 */
export function flagsFromHeaders(headers: readonly RawHeader[]): string[] {
  const flags = new Set<string>();
  for (const value of headerValues(headers, "status")) {
    if (/r/i.test(value)) {
      flags.add("\\Seen");
    }
  }
  for (const value of headerValues(headers, "x-status")) {
    if (/a/i.test(value)) {
      flags.add("\\Answered");
    }
    if (/f/i.test(value)) {
      flags.add("\\Flagged");
    }
    if (/t/i.test(value)) {
      flags.add("\\Draft");
    }
  }
  for (const value of headerValues(headers, "x-mozilla-status")) {
    if (!/^[0-9a-f]{1,8}$/i.test(value)) {
      continue;
    }
    const bits = Number.parseInt(value, 16);
    if (bits & 0x0001) {
      flags.add("\\Seen");
    }
    if (bits & 0x0002) {
      flags.add("\\Answered");
    }
    if (bits & 0x0004) {
      flags.add("\\Flagged");
    }
  }
  if (headerValues(headers, "x-unsent").some((value) => value.trim() === "1")) {
    flags.add("\\Draft");
  }
  return FLAG_ORDER.filter((flag) => flags.has(flag));
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const CTIME =
  /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([+-]\d{4}))?(?:\s+[A-Z]{2,5})?\s+(\d{4})(?:\s+([+-]\d{4}))?/i;

/**
 * The date of an mbox `From ` separator line (ctime format, e.g.
 * `From - Thu Sep 30 12:00:00 2021`). Without a numeric zone the time is UTC,
 * which is what exporters write.
 */
export function parseFromLineDate(fromLine: string): Date | null {
  const match = CTIME.exec(fromLine);
  if (!match) {
    return null;
  }
  const month = MONTHS[(match[1] ?? "").toLowerCase()];
  const day = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = match[5] === undefined ? 0 : Number(match[5]);
  const year = Number(match[7]);
  if (
    month === undefined ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    year < 1970 ||
    year > 2200
  ) {
    return null;
  }
  const zone = match[6] ?? match[8];
  let offsetMinutes = 0;
  if (zone) {
    const sign = zone.startsWith("-") ? -1 : 1;
    offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  }
  const time = Date.UTC(year, month, day, hour, minute, second) - offsetMinutes * 60_000;
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A date header longer than this is not a date (the longest real ones, with comments, are about 100). */
const MAX_DATE_CHARS = 512;

/** Remove RFC 5322 comments (they nest); linear, whatever the parentheses look like. */
function stripComments(value: string): string {
  let depth = 0;
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i] as string;
    if (char === "(") {
      depth++;
    } else if (char === ")" && depth > 0) {
      depth--;
    } else if (depth === 0) {
      result += char;
    }
  }
  return result;
}

/**
 * Parse an RFC 5322 date value; null when it does not parse. The value of a hostile
 * message can be a megabyte of parentheses, so a long one is refused before anything
 * is done with it.
 */
export function parseHeaderDate(value: string): Date | null {
  if (value.length > MAX_DATE_CHARS) {
    return null;
  }
  const cleaned = stripComments(value).replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) {
    return null;
  }
  const time = Date.parse(cleaned);
  return Number.isNaN(time) ? null : new Date(time);
}

/**
 * When the receiving server got the message: the date after the last `;` of the
 * topmost Received header, else the Date header, else null.
 */
export function receivedOrSentDate(headers: readonly RawHeader[]): Date | null {
  const received = headerValues(headers, "received")[0];
  if (received !== undefined) {
    const semicolon = received.lastIndexOf(";");
    const date = semicolon >= 0 ? parseHeaderDate(received.slice(semicolon + 1)) : null;
    if (date) {
      return date;
    }
  }
  const sent = headerValues(headers, "date")[0];
  return sent === undefined ? null : parseHeaderDate(sent);
}
