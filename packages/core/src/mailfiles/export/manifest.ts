/**
 * `MANIFEST.csv` and `SHA256SUMS`, the two files at the end of every ZIP export.
 *
 * `MANIFEST.csv` (RFC 4180, CRLF) describes each entry for people:
 * `entry,sha256,size,message_id,date,from,to,subject,status,note`. Text cells
 * that would be read as a formula by a spreadsheet (they start with `=`, `+`,
 * `-`, `@`, a tab or a carriage return) get a leading apostrophe, because the
 * subject and sender of a message are chosen by strangers. `SHA256SUMS` is for
 * machines: exactly the format `sha256sum -c` reads, one `<hex>  <path>` line
 * per file with a LF at the end, paths verbatim.
 */
import { csvField } from "../../restore/download.js";
import type { ExportEntry, ExportMessage } from "./types.js";

export const EXPORT_MANIFEST_NAME = "MANIFEST.csv";
export const EXPORT_SUMS_NAME = "SHA256SUMS";

export const EXPORT_MANIFEST_COLUMNS = [
  "entry",
  "sha256",
  "size",
  "message_id",
  "date",
  "from",
  "to",
  "subject",
  "status",
  "note",
] as const;

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** One text cell, quoted for CSV and defused against spreadsheet formulas. */
export function manifestText(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return csvField(FORMULA_TRIGGER.test(value) ? `'${value}` : value);
}

export type ManifestMessage = Pick<ExportMessage, "messageId" | "date" | "from" | "to" | "subject">;

/** The CSV line (without line break) of one entry; `message` fills the descriptive columns. */
export function manifestRow(entry: ExportEntry, message: ManifestMessage | null): string {
  const date = message?.date ?? null;
  return [
    manifestText(entry.name),
    csvField(entry.sha256),
    csvField(entry.status === "added" ? entry.bytes : 0),
    manifestText(message?.messageId),
    csvField(date !== null && !Number.isNaN(date.getTime()) ? date.toISOString() : null),
    manifestText(message?.from),
    manifestText(message?.to),
    manifestText(message?.subject),
    csvField(entry.status),
    manifestText(entry.note),
  ].join(",");
}

/** A hint for the size of the strings the generators below hand to a stream. */
const TARGET_CHUNK_CHARS = 64 * 1024;

/** The lines joined with CRLF in chunks of moderate size, header first. */
export function* manifestChunks(rows: readonly string[]): Generator<string, void, undefined> {
  let pending = `${EXPORT_MANIFEST_COLUMNS.join(",")}\r\n`;
  for (const row of rows) {
    pending += `${row}\r\n`;
    if (pending.length >= TARGET_CHUNK_CHARS) {
      yield pending;
      pending = "";
    }
  }
  if (pending.length > 0) {
    yield pending;
  }
}

export interface ChecksumLine {
  readonly sha256: string;
  readonly path: string;
}

/** `sha256sum -c` input: `<hex>  <path>` per line, LF terminated. */
export function* checksumChunks(lines: Iterable<ChecksumLine>): Generator<string, void, undefined> {
  let pending = "";
  for (const line of lines) {
    pending += `${line.sha256}  ${line.path}\n`;
    if (pending.length >= TARGET_CHUNK_CHARS) {
      yield pending;
      pending = "";
    }
  }
  if (pending.length > 0) {
    yield pending;
  }
}
