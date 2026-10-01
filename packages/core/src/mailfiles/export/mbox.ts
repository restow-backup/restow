import { createHash } from "node:crypto";
/**
 * MBOX export (mboxrd).
 *
 * {@link createMbox} writes ONE mbox stream, whatever the folders of the
 * messages are (a single mbox has no folders); {@link createMboxZip} writes one
 * `<folder path>.mbox` per folder into a ZIP, next to `MANIFEST.csv` and
 * `SHA256SUMS`. The format details (separator line, `>From ` escaping, the
 * final line break) are in mbox-format.ts.
 *
 * Both process a message chunk by chunk as Buffers, never as text, and never
 * hold more than one chunk of it: memory stays bounded however large a
 * message or an mbox file is.
 *
 * Failure handling is the one of the other writers (errors.ts): a message that
 * cannot be opened is listed as failed and skipped before a single byte of it
 * is written; a hash mismatch, a read error after the first byte, and a
 * cancellation end the export.
 */
import { once } from "node:events";
import { PassThrough, type Writable } from "node:stream";
import { describeExportError, isFatalExportError, statusOfError } from "./errors.js";
import { MboxEscaper, mboxSeparator } from "./mbox-format.js";
import { ExportNames } from "./names.js";
import { ExportScope, messageIterator } from "./scope.js";
import { type OpenedMessage, openVerified } from "./source.js";
import type {
  ExportEntry,
  ExportMessage,
  ExportOptions,
  ExportResult,
  ExportSummary,
} from "./types.js";
import {
  DIRECTORY_DATE,
  type Row,
  ZipBuilder,
  finishWithManifest,
  newRow,
  summarize,
} from "./zip-writer.js";

const noop = (): void => undefined;

type Sink = (chunk: Buffer) => Promise<void>;

/** A sink that writes to `out`, waits for `drain` when it is full, and gives up when the export ends. */
function sinkFor(out: Writable, scope: ExportScope, observe?: (chunk: Buffer) => void): Sink {
  return async (chunk) => {
    if (chunk.length === 0) {
      return;
    }
    observe?.(chunk);
    if (!out.write(chunk)) {
      const drained = once(out, "drain");
      // If the stream dies while we wait, the rejection belongs to the export failure, not to a crash.
      drained.catch(noop);
      await scope.race(drained);
    }
  };
}

/** Separator line, the escaped message, and the blank line after it. */
async function writeMboxMessage(
  opened: OpenedMessage,
  message: Pick<ExportMessage, "from" | "date">,
  sink: Sink,
): Promise<void> {
  await sink(Buffer.from(`${mboxSeparator(message.from, message.date)}\n`, "utf8"));
  const escaper = new MboxEscaper();
  for await (const chunk of opened.chunks) {
    const pieces = escaper.push(chunk);
    if (pieces.length === 1) {
      await sink(pieces[0] as Buffer);
    } else if (pieces.length > 1) {
      await sink(Buffer.concat(pieces));
    }
  }
  await sink(escaper.finish());
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** One MBOX stream with all messages, in the order given. */
export function createMbox(
  messages: AsyncIterable<ExportMessage> | Iterable<ExportMessage>,
  options: ExportOptions = {},
): ExportResult {
  const scope = new ExportScope(options.signal);
  const out = new PassThrough({ highWaterMark: 64 * 1024 });
  out.on("error", noop);
  let finished = false;
  scope.failure.catch((error) => out.destroy(asError(error)));
  out.once("close", () => {
    if (!finished) {
      scope.raise(new Error("the MBOX stream was closed before it was complete"));
    }
  });

  const entries: ExportEntry[] = [];
  const record = (entry: ExportEntry): void => {
    entries.push(entry);
    options.onEntry?.(entry);
  };

  const completed = (async (): Promise<ExportSummary> => {
    const iterator = messageIterator(messages);
    const write = sinkFor(out, scope);
    try {
      for (let ordinal = 1; ; ordinal++) {
        scope.throwIfFailed();
        const next = await scope.race(iterator.next());
        if (next.done) {
          break;
        }
        const message = next.value;
        const name = `#${ordinal}`;
        let opened: OpenedMessage;
        try {
          opened = await openVerified(message, scope);
        } catch (error) {
          if (isFatalExportError(error)) {
            throw error;
          }
          record({
            name,
            status: statusOfError(error),
            sha256: null,
            bytes: 0,
            note: describeExportError(error),
          });
          continue;
        }
        await writeMboxMessage(opened, message, write);
        scope.release(opened.source);
        const streamed = opened.result();
        record({ name, status: "added", sha256: streamed.sha256, bytes: streamed.bytes });
      }
      finished = true;
      out.end();
      return summarize(entries);
    } catch (error) {
      scope.raise(error);
      throw scope.error ?? error;
    } finally {
      iterator.close();
      scope.dispose();
    }
  })();
  completed.catch(noop);

  return { stream: out, completed };
}

interface OpenFile {
  readonly key: string;
  readonly name: string;
  readonly pass: PassThrough;
  readonly hash: ReturnType<typeof createHash>;
  readonly finishing: Promise<void>;
  readonly failedRows: Row[];
  readonly note: string | null;
  bytes: number;
  /** Messages written. */
  count: number;
  /** Messages tried, written or not; the `#n` of the entry names. */
  ordinal: number;
}

/**
 * One `<folder path>.mbox` per folder inside a ZIP. Messages of a folder must
 * follow each other (an mbox file is written in one go); if a folder shows up
 * again later it continues in `<name> (2).mbox` and the manifest says so.
 * Folders in `extraFolders` that received no message become empty mbox files.
 * `MANIFEST.csv` lists every mbox file with its SHA-256, size and message
 * count, plus one row per message that failed.
 */
export function createMboxZip(
  messages: AsyncIterable<ExportMessage> | Iterable<ExportMessage>,
  options: ExportOptions = {},
): ExportResult {
  const scope = new ExportScope(options.signal);
  // An mbox file can exceed 4 GiB; declare ZIP64 up front instead of relying on
  // a data descriptor that a strict reader may not expect without it.
  const builder = new ZipBuilder(scope, { ...options, forceZip64: true });
  const names = new ExportNames();
  const rows: Row[] = [];
  const entries: ExportEntry[] = [];
  const directories = new Set<string>();
  const seenFolders = new Set<string>();

  const ensureDirectories = (components: readonly string[]): void => {
    for (let depth = 1; depth <= components.length; depth++) {
      const path = components.slice(0, depth).join("/");
      if (!directories.has(path)) {
        directories.add(path);
        builder.directory(path);
      }
    }
  };

  const record = (entry: ExportEntry): void => {
    entries.push(entry);
    options.onEntry?.(entry);
  };

  const completed = (async (): Promise<ExportSummary> => {
    const iterator = messageIterator(messages);
    let current: OpenFile | null = null;

    const openFile = (folder: readonly string[], key: string): OpenFile => {
      const continued = seenFolders.has(key);
      seenFolders.add(key);
      const name = names.mboxEntry(folder);
      ensureDirectories(name.split("/").slice(0, -1));
      const pass = new PassThrough();
      scope.track(pass);
      const finishing = builder.stream(name, pass, DIRECTORY_DATE);
      // Awaited when the file is closed; if the export dies first, the error is reported there.
      finishing.catch(noop);
      return {
        key,
        name,
        pass,
        hash: createHash("sha256"),
        finishing,
        failedRows: [],
        note: continued
          ? "the messages of this folder were not consecutive in the input, so it continues here"
          : null,
        bytes: 0,
        count: 0,
        ordinal: 0,
      };
    };

    const closeFile = async (file: OpenFile): Promise<void> => {
      file.pass.end();
      await file.finishing;
      scope.release(file.pass);
      const sha256 = file.hash.digest("hex");
      const noun = file.count === 1 ? "message" : "messages";
      const note = [`${file.count} ${noun}`, file.note].filter((part) => part !== null).join("; ");
      rows.push(
        newRow({ name: file.name, status: "added", sha256, bytes: file.bytes, note }, null),
        ...file.failedRows,
      );
    };

    try {
      for (const folder of options.extraFolders ?? []) {
        names.folder(folder);
      }
      for (;;) {
        scope.throwIfFailed();
        const next = await scope.race(iterator.next());
        if (next.done) {
          break;
        }
        const message = next.value;
        const key = JSON.stringify(message.folder);
        if (current === null || current.key !== key) {
          if (current !== null) {
            await closeFile(current);
          }
          current = openFile(message.folder, key);
        }
        const file: OpenFile = current;
        file.ordinal++;
        const name = `${file.name}#${file.ordinal}`;
        let opened: OpenedMessage;
        try {
          opened = await openVerified(message, scope);
        } catch (error) {
          if (isFatalExportError(error)) {
            throw error;
          }
          const entry: ExportEntry = {
            name,
            status: statusOfError(error),
            sha256: null,
            bytes: 0,
            note: describeExportError(error),
          };
          file.failedRows.push(newRow(entry, message));
          record(entry);
          continue;
        }
        const write = sinkFor(file.pass, scope, (chunk) => {
          file.hash.update(chunk);
          file.bytes += chunk.length;
        });
        await writeMboxMessage(opened, message, write);
        scope.release(opened.source);
        file.count++;
        const streamed = opened.result();
        record({ name, status: "added", sha256: streamed.sha256, bytes: streamed.bytes });
      }
      if (current !== null) {
        await closeFile(current);
        current = null;
      }
      for (const folder of options.extraFolders ?? []) {
        const key = JSON.stringify(folder);
        if (folder.length === 0 || seenFolders.has(key)) {
          continue;
        }
        seenFolders.add(key);
        const name = names.mboxEntry(folder);
        ensureDirectories(name.split("/").slice(0, -1));
        await builder.buffer(name, Buffer.alloc(0), DIRECTORY_DATE);
        rows.push(
          newRow(
            {
              name,
              status: "added",
              sha256: createHash("sha256").digest("hex"),
              bytes: 0,
              note: "0 messages",
            },
            null,
          ),
        );
      }
      await finishWithManifest(builder, rows, options.now?.() ?? new Date());
      return summarize(entries);
    } catch (error) {
      scope.raise(error);
      builder.destroy(scope.error ?? error);
      throw scope.error ?? error;
    } finally {
      iterator.close();
      scope.dispose();
    }
  })();
  completed.catch(noop);

  return { stream: builder.archive, completed };
}
