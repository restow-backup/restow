/**
 * ZIP reading over {@link MailInputFile.read}: yauzl runs on a random access
 * reader, so an archive in the encrypted staging area (or a file of the import
 * folder) is read in place. Nothing is extracted to disk; an entry is a stream
 * that the caller consumes and drops.
 *
 * This module knows ZIP only. It yields the entries in central directory order
 * and applies the guards that protect the worker:
 *
 *   - too many entries, too many expanded bytes in total (declared sizes, which
 *     yauzl verifies while it inflates), an implausible compression ratio
 *     -> a `limit` problem;
 *   - encrypted entries and compression methods yauzl cannot decode
 *     -> an `unsupported` problem;
 *   - entry names are sanitised (backslashes are separators, no `..`, no
 *     absolute paths, no drive letters, no control characters), so no name can
 *     point outside the folder tree the import builds.
 *
 * What an entry contains (mail, an inner archive, junk) is decided by the walker.
 */
import { Readable } from "node:stream";
import * as yauzl from "yauzl";
import {
  DEFAULT_MAIL_FILE_LIMITS,
  type MailFileLimits,
  type MailInputFile,
  type MailProblemCode,
} from "./types.js";

/** How much of an entry `head()` returns at most. */
const HEAD_BYTES = 64 * 1024;
/** Size of the reads served to yauzl. */
const READ_CHUNK = 256 * 1024;

export interface ZipDirectoryEvent {
  readonly kind: "directory";
  /** Sanitised path components, never empty. */
  readonly path: readonly string[];
}

export interface ZipEntryEvent {
  readonly kind: "entry";
  /** Sanitised '/'-separated path, never empty. */
  readonly name: string;
  readonly components: readonly string[];
  /** Uncompressed size (verified by yauzl while the entry is read). */
  readonly size: number;
  readonly compressedSize: number;
  /**
   * The first bytes of the entry (up to 64 KiB); opens and closes its own stream.
   * Like `open`, only valid until the iterator is advanced.
   */
  head(): Promise<Buffer>;
  /** A fresh stream over the whole entry; consume it before advancing the iterator. */
  open(): Promise<Readable>;
}

export interface ZipProblemEvent {
  readonly kind: "problem";
  readonly code: MailProblemCode;
  readonly reason: string;
  /** Sanitised path of the entry concerned, null for problems of the archive itself. */
  readonly name: string | null;
}

export type ZipEvent = ZipDirectoryEvent | ZipEntryEvent | ZipProblemEvent;

export interface IterateZipOptions {
  readonly limits?: Partial<MailFileLimits>;
  readonly signal?: AbortSignal;
}

/** An error reading the archive whose message is safe to show to the user. */
export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipReadError";
  }
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * Split an archive entry name into safe path components: backslashes count as
 * separators, empty, "." and ".." components disappear, a leading drive letter
 * component is dropped, control characters are removed.
 */
export function sanitizeArchivePath(name: string): string[] {
  const components: string[] = [];
  for (const raw of name.replace(/\\/g, "/").split("/")) {
    const component = raw.replace(CONTROL_CHARACTERS, "").trim();
    if (component === "" || component === "." || component === "..") {
      continue;
    }
    // A bare drive letter ("C:") in front of an absolute Windows path.
    if (components.length === 0 && /^[A-Za-z]:$/.test(component)) {
      continue;
    }
    components.push(component);
  }
  return components;
}

/** Reads the byte ranges yauzl asks for from a {@link MailInputFile}. */
class InputFileReader extends yauzl.RandomAccessReader {
  constructor(private readonly file: MailInputFile) {
    super();
  }

  _readStreamForRange(start: number, end: number): Readable {
    const file = this.file;
    let position = start;
    return new Readable({
      read() {
        if (position >= end) {
          this.push(null);
          return;
        }
        file.read(position, Math.min(READ_CHUNK, end - position)).then(
          (chunk) => {
            if (chunk.length === 0) {
              this.destroy(new ZipReadError("The archive ends earlier than its headers say."));
              return;
            }
            position += chunk.length;
            this.push(chunk);
          },
          // The reason stays out of the message: storage errors can name internal keys.
          () => this.destroy(new ZipReadError("The file could not be read.")),
        );
      },
    });
  }
}

/** A short, user-facing description of a yauzl or zlib failure. */
function describeZipError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(CONTROL_CHARACTERS, " ").replace(/[–—]/g, "-").slice(0, 160);
}

function limitMessage(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `${gib.toFixed(gib < 10 ? 1 : 0)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * Iterate the entries of a ZIP archive in central directory order. Never throws
 * except for an abort; a damaged archive ends with an `unreadable` problem.
 */
export async function* iterateZip(
  file: MailInputFile,
  options: IterateZipOptions = {},
): AsyncGenerator<ZipEvent> {
  const limits: MailFileLimits = { ...DEFAULT_MAIL_FILE_LIMITS, ...options.limits };
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromRandomAccessReaderPromise(new InputFileReader(file), file.size, {
      decodeStrings: false,
      validateEntrySizes: true,
      autoClose: false,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw abortError();
    }
    yield {
      kind: "problem",
      code: "unreadable",
      reason: `The ZIP archive is damaged or incomplete (${describeZipError(error)}).`,
      name: null,
    };
    return;
  }

  try {
    if (zip.entryCount > limits.maxZipEntries) {
      yield {
        kind: "problem",
        code: "limit",
        reason: `The ZIP archive holds ${zip.entryCount} entries, which is more than the limit of ${limits.maxZipEntries}.`,
        name: null,
      };
      return;
    }

    let expanded = 0;
    try {
      for await (const entry of zip.eachEntry()) {
        if (options.signal?.aborted) {
          throw abortError();
        }
        const rawName = yauzl.getFileNameLowLevel(
          entry.generalPurposeBitFlag,
          entry.fileNameRaw,
          entry.extraFields,
          false,
        );
        const components = sanitizeArchivePath(rawName);
        const isDirectory = /[\\/]$/.test(rawName);
        if (isDirectory) {
          if (components.length > 0) {
            yield { kind: "directory", path: components };
          }
          continue;
        }
        if (components.length === 0) {
          yield {
            kind: "problem",
            code: "unreadable",
            reason: "An entry of the ZIP archive has no usable file name.",
            name: null,
          };
          continue;
        }
        const name = components.join("/");

        expanded += entry.uncompressedSize;
        if (expanded > limits.maxZipExpandedBytes) {
          yield {
            kind: "problem",
            code: "limit",
            reason: `The ZIP archive expands to more than the limit of ${limitMessage(limits.maxZipExpandedBytes)}. The remaining entries were not read.`,
            name,
          };
          return;
        }
        if (entry.isEncrypted()) {
          yield {
            kind: "problem",
            code: "unsupported",
            reason: "The entry is password protected. Encrypted ZIP entries cannot be imported.",
            name,
          };
          continue;
        }
        if (!entry.canDecodeFileData()) {
          yield {
            kind: "problem",
            code: "unsupported",
            reason: `The entry uses compression method ${entry.compressionMethod}, which is not supported.`,
            name,
          };
          continue;
        }
        if (
          entry.uncompressedSize > 0 &&
          (entry.compressedSize === 0 ||
            entry.uncompressedSize / entry.compressedSize > limits.maxZipRatio)
        ) {
          yield {
            kind: "problem",
            code: "limit",
            reason: `The entry expands by more than ${limits.maxZipRatio} times, which looks like a decompression bomb, so it was not read.`,
            name,
          };
          continue;
        }

        yield {
          kind: "entry",
          name,
          components,
          size: entry.uncompressedSize,
          compressedSize: entry.compressedSize,
          open: () => zip.openReadStreamPromise(entry),
          async head(): Promise<Buffer> {
            const stream = await zip.openReadStreamPromise(entry);
            const chunks: Buffer[] = [];
            let length = 0;
            try {
              for await (const chunk of stream) {
                const buffer = chunk as Buffer;
                chunks.push(buffer);
                length += buffer.length;
                if (length >= HEAD_BYTES) {
                  break;
                }
              }
            } finally {
              stream.destroy();
            }
            const all = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, length);
            return all.length > HEAD_BYTES ? all.subarray(0, HEAD_BYTES) : all;
          },
        };
      }
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw abortError();
      }
      yield {
        kind: "problem",
        code: "unreadable",
        reason: `The ZIP archive is damaged and could not be read to the end (${describeZipError(error)}).`,
        name: null,
      };
    }
  } finally {
    zip.close();
  }
}
