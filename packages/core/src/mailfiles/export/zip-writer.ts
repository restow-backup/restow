/**
 * The ZIP machinery the export writers share: an `archiver` wrapper that
 * appends one entry at a time and waits until it is fully written (so memory
 * stays bounded by one entry), the trailing `MANIFEST.csv` and `SHA256SUMS`,
 * and the loop that turns a sequence of messages into named entries.
 *
 * The failure pattern is the one of the restore download (restore/download.ts):
 * any error, a cancellation, or the consumer destroying the stream ends the
 * export at once, the archive is destroyed, and `completed` rejects. Nothing
 * is left dangling, nothing becomes an unhandled rejection.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { type Archiver, ZipArchive } from "archiver";
import { describeExportError, isFatalExportError, statusOfError } from "./errors.js";
import {
  EXPORT_MANIFEST_NAME,
  EXPORT_SUMS_NAME,
  type ManifestMessage,
  checksumChunks,
  manifestChunks,
  manifestRow,
} from "./manifest.js";
import { ExportNames } from "./names.js";
import { ExportScope, messageIterator } from "./scope.js";
import type {
  ExportEntry,
  ExportEntryStatus,
  ExportMessage,
  ExportOptions,
  ExportResult,
  ExportSummary,
} from "./types.js";

const noop = (): void => undefined;

/** ZIP (DOS) time stamps start in 1980 and end in 2107. */
const DOS_MIN = Date.UTC(1980, 0, 1, 12);
const DOS_MAX = Date.UTC(2107, 11, 31, 12);

/** Time stamp of the folder entries: fixed, so the archive does not depend on the clock. */
export const DIRECTORY_DATE = new Date(DOS_MIN);

/** The ZIP time stamp of a message: its date clamped into the range ZIP can store. */
export function zipDate(date: Date | null): Date {
  if (date === null || Number.isNaN(date.getTime())) {
    return DIRECTORY_DATE;
  }
  return new Date(Math.min(Math.max(date.getTime(), DOS_MIN), DOS_MAX));
}

/** A readable over string or Buffer parts that reports the SHA-256 and size of what it delivered. */
export function hashedSource(parts: Iterable<Buffer | string>): {
  stream: Readable;
  result(): { sha256: string; bytes: number };
} {
  const hash = createHash("sha256");
  let bytes = 0;
  let digest: string | null = null;
  async function* generate(): AsyncGenerator<Buffer, void, undefined> {
    for (const part of parts) {
      const chunk = typeof part === "string" ? Buffer.from(part, "utf8") : part;
      hash.update(chunk);
      bytes += chunk.length;
      yield chunk;
    }
    digest = hash.digest("hex");
  }
  return {
    stream: Readable.from(generate(), { objectMode: false }),
    result: () => {
      if (digest === null) {
        throw new Error("the source has not been consumed to the end");
      }
      return { sha256: digest, bytes };
    },
  };
}

export interface ZipBuilderOptions {
  readonly level?: number;
  readonly comment?: string;
  readonly forceZip64?: boolean;
}

/** Appends entries to a ZIP one by one and reports when each is completely written. */
export class ZipBuilder {
  readonly archive: Archiver;
  private appended = 0;
  private processed = 0;
  private finished = false;
  private waiters: { target: number; resolve: () => void }[] = [];

  constructor(
    private readonly scope: ExportScope,
    options: ZipBuilderOptions = {},
  ) {
    this.archive = new ZipArchive({
      zlib: { level: options.level ?? 6 },
      ...(options.comment !== undefined ? { comment: options.comment } : {}),
      ...(options.forceZip64 ? { forceZip64: true } : {}),
    });
    this.archive.on("entry", () => {
      this.processed++;
      this.waiters = this.waiters.filter((waiter) => {
        if (this.processed >= waiter.target) {
          waiter.resolve();
          return false;
        }
        return true;
      });
    });
    this.archive.on("error", (error) => scope.raise(error));
    this.archive.on("warning", (error) => scope.raise(error));
    this.archive.on("close", () => {
      if (!this.finished) {
        scope.raise(new Error("the archive stream was closed before it was complete"));
      }
    });
    // The consumer may already be gone when the writer fails; that must not crash.
    this.archive.on("error", noop);
  }

  private processedAtLeast(target: number): Promise<void> {
    if (this.processed >= target) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push({ target, resolve });
    });
  }

  /** Queue an empty folder entry; it is written before anything appended later. */
  directory(path: string): void {
    this.appended++;
    this.archive.append(Buffer.alloc(0), {
      name: path.endsWith("/") ? path : `${path}/`,
      date: DIRECTORY_DATE,
    });
  }

  /** Append a small entry whose content is already in memory and wait until it is written. */
  async buffer(name: string, data: Buffer, date: Date): Promise<void> {
    const target = ++this.appended;
    this.archive.append(data, { name, date });
    await this.scope.race(this.processedAtLeast(target));
  }

  /** Append a stream and wait until it is completely written. A stream error ends the export. */
  async stream(name: string, source: Readable, date: Date): Promise<void> {
    const target = ++this.appended;
    source.once("error", (error) => this.scope.raise(error));
    this.archive.append(source, { name, date });
    await this.scope.race(this.processedAtLeast(target));
  }

  /** Write the central directory and wait until the archive has produced its last byte. */
  async finish(): Promise<void> {
    await this.scope.race(this.archive.finalize());
    this.finished = true;
  }

  /** Stop producing: the archive errors and closes. */
  destroy(error: unknown): void {
    if (!this.finished) {
      this.archive.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export interface Row {
  readonly entry: ExportEntry;
  readonly csv: string;
}

/** What a writer decided about one message. */
export type PreparedEntry =
  | {
      readonly kind: "stream";
      readonly source: Readable;
      /** Called after the stream was written to the end. */
      result(): { sha256: string; bytes: number };
    }
  | { readonly kind: "buffer"; readonly data: Buffer; readonly sha256: string }
  | { readonly kind: "failed"; readonly status: ExportEntryStatus; readonly note: string };

export interface MessageZipStrategy {
  /** Extension of the entries, with the dot. */
  readonly extension: string;
  /** Turn a message into the content of its entry. Errors before content exists mark it failed. */
  prepare(message: ExportMessage, scope: ExportScope): Promise<PreparedEntry>;
  /** Note of an entry that was written. */
  readonly addedNote?: string;
}

export function summarize(entries: readonly ExportEntry[]): ExportSummary {
  let messages = 0;
  let failed = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.status === "added") {
      messages++;
      bytes += entry.bytes;
    } else {
      failed++;
    }
  }
  return { entries, messages, failed, bytes };
}

/** Append `MANIFEST.csv` and `SHA256SUMS` (which also vouches for the manifest) and finish the ZIP. */
export async function finishWithManifest(
  builder: ZipBuilder,
  rows: readonly Row[],
  now: Date,
): Promise<void> {
  const manifest = hashedSource(manifestChunks(rows.map((row) => row.csv)));
  await builder.stream(EXPORT_MANIFEST_NAME, manifest.stream, now);
  const manifestHash = manifest.result().sha256;
  function* lines() {
    for (const row of rows) {
      if (row.entry.status === "added" && row.entry.sha256 !== null) {
        yield { sha256: row.entry.sha256, path: row.entry.name };
      }
    }
    yield { sha256: manifestHash, path: EXPORT_MANIFEST_NAME };
  }
  const sums = hashedSource(checksumChunks(lines()));
  await builder.stream(EXPORT_SUMS_NAME, sums.stream, now);
  await builder.finish();
}

export function newRow(entry: ExportEntry, message: ManifestMessage | null): Row {
  return { entry, csv: manifestRow(entry, message) };
}

/**
 * Write `messages` as a ZIP: folders as directories, one entry per message
 * (named by {@link ExportNames}), `MANIFEST.csv` and `SHA256SUMS` at the end.
 */
export function runMessageZip(
  messages: AsyncIterable<ExportMessage> | Iterable<ExportMessage>,
  options: ExportOptions,
  strategy: MessageZipStrategy,
): ExportResult {
  const scope = new ExportScope(options.signal);
  const builder = new ZipBuilder(scope, options);
  const names = new ExportNames();
  const rows: Row[] = [];
  const directories = new Set<string>();

  const ensureDirectories = (components: readonly string[]): void => {
    for (let depth = 1; depth <= components.length; depth++) {
      const path = components.slice(0, depth).join("/");
      if (!directories.has(path)) {
        directories.add(path);
        builder.directory(path);
      }
    }
  };

  const record = (entry: ExportEntry, message: ManifestMessage): void => {
    rows.push(newRow(entry, message));
    options.onEntry?.(entry);
  };

  const completed = (async (): Promise<ExportSummary> => {
    const iterator = messageIterator(messages);
    try {
      for (const folder of options.extraFolders ?? []) {
        ensureDirectories(names.folder(folder));
      }
      for (;;) {
        scope.throwIfFailed();
        const next = await scope.race(iterator.next());
        if (next.done) {
          break;
        }
        const message = next.value;
        const folder = names.folder(message.folder);
        ensureDirectories(folder);
        const name = names.messageEntry(folder, message, strategy.extension);

        let prepared: PreparedEntry;
        try {
          prepared = await strategy.prepare(message, scope);
        } catch (error) {
          if (isFatalExportError(error)) {
            throw error;
          }
          prepared = {
            kind: "failed",
            status: statusOfError(error),
            note: describeExportError(error),
          };
        }
        if (prepared.kind === "failed") {
          record(
            { name, status: prepared.status, sha256: null, bytes: 0, note: prepared.note },
            message,
          );
          continue;
        }
        const date = zipDate(message.date);
        let sha256: string;
        let bytes: number;
        if (prepared.kind === "stream") {
          await builder.stream(name, prepared.source, date);
          ({ sha256, bytes } = prepared.result());
        } else {
          await builder.buffer(name, prepared.data, date);
          sha256 = prepared.sha256;
          bytes = prepared.data.length;
        }
        scope.untrack();
        record(
          {
            name,
            status: "added",
            sha256,
            bytes,
            ...(strategy.addedNote !== undefined ? { note: strategy.addedNote } : {}),
          },
          message,
        );
      }
      await finishWithManifest(builder, rows, options.now?.() ?? new Date());
      return summarize(rows.map((row) => row.entry));
    } catch (error) {
      scope.raise(error);
      builder.destroy(scope.error ?? error);
      throw scope.error ?? error;
    } finally {
      iterator.close();
      scope.dispose();
    }
  })();
  // A caller that only pipes the stream may never look at `completed`.
  completed.catch(noop);

  return { stream: builder.archive, completed };
}
