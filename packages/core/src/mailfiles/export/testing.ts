/**
 * Helpers for the export tests (and for the coordinator's cross tests): build
 * `ExportMessage`s from bytes, read ZIPs back with a real ZIP reader (yauzl,
 * which checks names, sizes and CRCs), parse the manifest, and run the
 * `sha256sum -c` check on the checksum list.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import yauzl from "yauzl";
import type { ExportMessage } from "./types.js";

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function collect(stream: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) {
    parts.push(typeof part === "string" ? Buffer.from(part) : Buffer.from(part));
  }
  return Buffer.concat(parts);
}

export interface TestMessageOptions {
  folder?: readonly string[];
  date?: Date | null;
  subject?: string | null;
  from?: string | null;
  to?: string | null;
  messageId?: string | null;
  /** Bytes per chunk the stream yields (default: everything at once). */
  chunkSize?: number;
  /** Put the correct SHA-256 on the message (default true). */
  withHash?: boolean;
  /** Override the recorded SHA-256 (to provoke an integrity failure). */
  sha256?: string;
  /** Replace `open` (to provoke failures). */
  open?: () => Readable;
}

/** An in-memory message. */
export function testMessage(raw: Buffer | string, options: TestMessageOptions = {}): ExportMessage {
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  const chunkSize = options.chunkSize ?? Math.max(bytes.length, 1);
  const withHash = options.withHash ?? true;
  const sha256 = options.sha256 ?? (withHash ? sha256Hex(bytes) : undefined);
  return {
    folder: options.folder ?? ["Inbox"],
    date: options.date === undefined ? new Date(Date.UTC(2024, 2, 5, 10, 20, 30)) : options.date,
    size: bytes.length,
    messageId: options.messageId === undefined ? null : options.messageId,
    subject: options.subject === undefined ? "Hello" : options.subject,
    from: options.from === undefined ? "Anna Example <anna@example.test>" : options.from,
    to: options.to === undefined ? "bob@example.test" : options.to,
    ...(sha256 !== undefined ? { sha256 } : {}),
    open:
      options.open ??
      (() => {
        function* pieces(): Generator<Buffer> {
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            yield bytes.subarray(offset, offset + chunkSize);
          }
        }
        return Readable.from(pieces(), { objectMode: false });
      }),
  };
}

/** A small, valid RFC 5322 message. */
export function sampleEml(
  options: { subject?: string; body?: string; messageId?: string; crlf?: boolean } = {},
): string {
  const eol = options.crlf === false ? "\n" : "\r\n";
  return [
    "From: Anna Example <anna@example.test>",
    "To: bob@example.test",
    `Subject: ${options.subject ?? "Hello"}`,
    "Date: Tue, 05 Mar 2024 10:20:30 +0000",
    `Message-ID: ${options.messageId ?? "<m1@example.test>"}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.body ?? "Hello Bob.",
    "",
  ].join(eol);
}

export interface UnzippedEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly data: Buffer;
  readonly modified: Date;
  /** True when the ZIP marks the name as UTF-8 (general purpose bit 11). */
  readonly utf8Name: boolean;
}

/** Read every entry of a ZIP in central directory order (yauzl validates names, sizes and CRCs). */
export function unzip(archive: Buffer): Promise<UnzippedEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(error ?? new Error("cannot open the ZIP"));
        return;
      }
      const entries: UnzippedEntry[] = [];
      zipfile.on("error", reject);
      zipfile.on("end", () => resolve(entries));
      zipfile.on("entry", (entry: yauzl.Entry) => {
        const base = {
          name: entry.fileName,
          isDirectory: entry.fileName.endsWith("/"),
          modified: entry.getLastModDate(),
          utf8Name: (entry.generalPurposeBitFlag & 0x800) !== 0,
        };
        if (base.isDirectory) {
          entries.push({ ...base, data: Buffer.alloc(0) });
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (openError, stream) => {
          if (openError || !stream) {
            reject(openError ?? new Error("cannot read an entry"));
            return;
          }
          collect(stream).then((data) => {
            entries.push({ ...base, data });
            zipfile.readEntry();
          }, reject);
        });
      });
      zipfile.readEntry();
    });
  });
}

/** RFC 4180 parser (quoted fields, doubled quotes, line breaks inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      started = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      started = true;
    } else if (char === "\r" && text[i + 1] === "\n") {
      // handled at the "\n"
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
    } else {
      field += char;
      started = true;
    }
  }
  if (started || field.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface ManifestRecord {
  readonly entry: string;
  readonly sha256: string;
  readonly size: string;
  readonly message_id: string;
  readonly date: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly status: string;
  readonly note: string;
}

/** The rows of a MANIFEST.csv as objects keyed by column name. */
export function parseManifest(text: string): ManifestRecord[] {
  const [header, ...rows] = parseCsv(text);
  return rows.map(
    (row) =>
      Object.fromEntries(
        (header ?? []).map((name, index) => [name, row[index] ?? ""]),
      ) as unknown as ManifestRecord,
  );
}

/**
 * What `sha256sum -c` does: every line must be `<64 hex>  <path>`, LF terminated,
 * and the hash of the named entry must match. Returns the checked paths.
 */
export function checkSha256Sums(sums: string, entries: readonly UnzippedEntry[]): string[] {
  if (sums.length > 0 && !sums.endsWith("\n")) {
    throw new Error("SHA256SUMS does not end with a line feed");
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const checked: string[] = [];
  for (const line of sums.split("\n").filter((l) => l.length > 0)) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      throw new Error(`bad SHA256SUMS line: ${line}`);
    }
    const path = match[2] as string;
    const entry = byName.get(path);
    if (!entry) {
      throw new Error(`SHA256SUMS names a missing entry: ${path}`);
    }
    if (sha256Hex(entry.data) !== match[1]) {
      throw new Error(`hash mismatch for ${path}`);
    }
    checked.push(path);
  }
  return checked;
}
