/**
 * Turns one input file into the events the import engine stores: folders,
 * messages and problems (docs/IMPORT.md, "Readers contract").
 *
 * What a file is comes from its bytes (./sniff.ts), never from its name; the
 * name only decides the folder a message lands in. The events of a file are
 * numbered deterministically: every message and every problem is an item, in
 * file order (MBOX messages in file order, ZIP entries in central directory
 * order), and `WalkOptions.skipItems` resumes after item n without parsing the
 * items before it. Folder events do not count as items. A folder event is
 * yielded when the walk is at or beyond item `skipItems`, so a resumed walk
 * yields exactly the events a full walk yields after its first n items.
 *
 * Nothing is dropped silently: operating system and mail program leftovers
 * (`.DS_Store`, `Thumbs.db`, AppleDouble `._x` files, Thunderbird `.msf` indexes,
 * `__MACOSX` entries) are reported as `not_mail` problems, which the import
 * counts as skipped, not as failed. Only the empty `__MACOSX` directory itself
 * creates no folder.
 *
 * Folder mapping:
 *   - `a.eml` / `a.msg` at the top: ["Imported"]; `dir/sub/a.eml`: ["dir", "sub"];
 *   - MBOX `Inbox`, `x.mbox`: ["Inbox"], ["x"]; `dir/x.mbox`: ["dir", "x"];
 *   - directory components lose a `.sbd` suffix (Thunderbird) and a `.mbox`
 *     suffix (Apple Mail); Apple Mail's `X.mbox/mbox` maps to ["X"];
 *   - inside a ZIP the entry path gives the folder, root-level entries go to
 *     [<zip base name>]; the directories of the ZIP file's own path come first.
 */
import type { Readable } from "node:stream";
import { flagsFromHeaders, readHeaderBlock, receivedOrSentDate } from "./headers.js";
import { splitMbox } from "./mbox.js";
import { readMsg } from "./msg.js";
import {
  SNIFF_HEAD_BYTES,
  archiveKindLabel,
  detectMailFormat,
  detectOtherArchive,
} from "./sniff.js";
import {
  DEFAULT_MAIL_FILE_LIMITS,
  type MailFileFormat,
  type MailFileLimits,
  type MailInputFile,
  type MailProblemCode,
  type MailWalkEvent,
  type MailWalkProblem,
  type WalkOptions,
} from "./types.js";
import { iterateZip, sanitizeArchivePath } from "./zip.js";

export const PST_NOT_SUPPORTED_REASON =
  "PST and OST import is planned for a later release. Export the mailbox from Outlook as .msg or .eml files (or convert it to MBOX) and import those.";

export const OS_METADATA_REASON = "Operating system metadata file, not a mail message.";
export const MAIL_INDEX_REASON =
  "Thunderbird index file (.msf), not a mail message. The mailbox itself is imported from its own file.";

const DEFAULT_FOLDER = "Imported";
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return (signal?.aborted ?? false) || (error instanceof Error && error.name === "AbortError");
}

// ---------------------------------------------------------------------------
// Names and folders

const IGNORED_FILE_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function endsWithIgnoreCase(text: string, suffix: string): boolean {
  return text.length >= suffix.length && text.slice(-suffix.length).toLowerCase() === suffix;
}

function stripSuffix(name: string, suffix: string): string {
  return endsWithIgnoreCase(name, suffix) ? name.slice(0, -suffix.length) : name;
}

/** A directory name as a folder name: Thunderbird's `.sbd` and Apple Mail's `.mbox` suffix go. */
function folderNameOfDirectory(name: string): string {
  const stripped = stripSuffix(stripSuffix(name, ".sbd"), ".mbox").trim();
  return stripped === "" ? name : stripped;
}

function folderNameOfMbox(name: string): string {
  const stripped = stripSuffix(stripSuffix(name, ".mbox"), ".mbx").trim();
  return stripped === "" ? name : stripped;
}

/** Where an item sits, for the folder mapping. */
interface Placement {
  /** Mapped folder components in front of everything (the directories of a ZIP file's own path). */
  readonly prefix: readonly string[];
  /** Raw directory components of the file or entry. */
  readonly dirs: readonly string[];
  readonly base: string;
  /** Folder of a message file without directories. */
  readonly fallback: readonly string[];
}

function placementOf(
  components: readonly string[],
  prefix: readonly string[],
  fallback: readonly string[],
): Placement {
  return {
    prefix,
    dirs: components.slice(0, -1),
    base: components[components.length - 1] ?? "",
    fallback,
  };
}

function folderFor(placement: Placement, format: "eml" | "msg" | "mbox"): string[] {
  const dirs = placement.dirs.map(folderNameOfDirectory);
  const messageFolder = (): string[] =>
    placement.dirs.length > 0 ? [...placement.prefix, ...dirs] : [...placement.fallback];
  if (format !== "mbox") {
    return messageFolder();
  }
  const lastDirectory = placement.dirs[placement.dirs.length - 1];
  if (
    placement.base.toLowerCase() === "mbox" &&
    lastDirectory !== undefined &&
    endsWithIgnoreCase(lastDirectory, ".mbox")
  ) {
    // Apple Mail: X.mbox/mbox is the mailbox X.
    return [...placement.prefix, ...dirs];
  }
  if (endsWithIgnoreCase(placement.base, ".eml")) {
    // A single message stored in mbox form (Thunderbird saves "From -" in front of it).
    return messageFolder();
  }
  return [...placement.prefix, ...dirs, folderNameOfMbox(placement.base)];
}

function nameIsIgnorable(components: readonly string[]): boolean {
  if (components.some((component) => component.toLowerCase() === "__macosx")) {
    return true;
  }
  const base = components[components.length - 1] ?? "";
  return IGNORED_FILE_NAMES.has(base.toLowerCase());
}

/** Why a file is a known leftover of the operating system or a mail program, judged by its content. */
function leftoverReason(base: string, head: Buffer): string | null {
  // AppleDouble resource fork ("._name").
  if (base.startsWith("._") && head.length >= 4 && head.readUInt32BE(0) === 0x00051607) {
    return OS_METADATA_REASON;
  }
  // Thunderbird's Mork summary file (.msf).
  if (head.subarray(0, 17).toString("latin1") === "// <!-- <mdb:mork") {
    return MAIL_INDEX_REASON;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Walk state

class WalkState {
  index = 0;

  constructor(
    readonly limits: MailFileLimits,
    readonly skip: number,
    readonly signal: AbortSignal | undefined,
  ) {}

  next(): number {
    return this.index++;
  }

  get atOrBeyondSkip(): boolean {
    return this.index >= this.skip;
  }

  checkAbort(): void {
    if (this.signal?.aborted) {
      throw abortError();
    }
  }
}

/** One thing to read: the top-level file or an entry of a ZIP. */
interface Source {
  readonly size: number;
  /** Reference prefix for the report ("a.eml", "export.zip!Inbox/a.eml"). */
  readonly ref: string;
  readonly placement: Placement;
  readonly nested: boolean;
  /** Set for the top-level file, so a ZIP can be opened by random access. */
  readonly file?: MailInputFile;
  head(): Promise<Buffer>;
  open(): Promise<Readable> | Readable;
}

function problem(
  index: number,
  ref: string,
  code: MailProblemCode,
  reason: string,
  format: MailFileFormat | undefined,
): MailWalkProblem {
  return format === undefined
    ? { type: "problem", ref, index, code, reason }
    : { type: "problem", ref, index, code, reason, format };
}

class TooLargeError extends Error {
  constructor(readonly bytes: number) {
    super("too large");
  }
}

async function readAll(
  stream: Readable,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        throw abortError();
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > maxBytes) {
        throw new TooLargeError(total);
      }
      chunks.push(buffer);
    }
  } finally {
    stream.destroy();
  }
  return chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, total);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function tooLargeReason(bytes: number, limit: number): string {
  return `The file is ${formatBytes(bytes)}, which is more than the limit of ${formatBytes(limit)} for one message.`;
}

function stripBom(buffer: Buffer): Buffer {
  return buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM) ? buffer.subarray(3) : buffer;
}

const EMLX_START = /^\d{1,10}\r?\n[\x21-\x39\x3b-\x7e]+:/;

// ---------------------------------------------------------------------------
// One source

async function* walkSource(source: Source, state: WalkState): AsyncGenerator<MailWalkEvent> {
  state.checkAbort();
  const components = [...source.placement.dirs, source.placement.base];
  const { ref, placement } = source;
  if (nameIsIgnorable(components)) {
    const index = state.next();
    if (index >= state.skip) {
      yield problem(index, ref, "not_mail", OS_METADATA_REASON, "unknown");
    }
    return;
  }

  if (source.size === 0) {
    const index = state.next();
    if (index >= state.skip) {
      yield problem(index, ref, "empty", "The file is empty.", undefined);
    }
    return;
  }

  let head: Buffer;
  try {
    head = await source.head();
  } catch (error) {
    if (isAbort(error, state.signal)) {
      throw abortError();
    }
    const index = state.next();
    if (index >= state.skip) {
      yield problem(index, ref, "unreadable", "The file could not be read.", undefined);
    }
    return;
  }
  const leftover = leftoverReason(placement.base, head);
  if (leftover !== null) {
    const index = state.next();
    if (index >= state.skip) {
      yield problem(index, ref, "not_mail", leftover, "unknown");
    }
    return;
  }

  const detection = detectMailFormat(head);
  switch (detection.format) {
    case "pst": {
      const index = state.next();
      if (index >= state.skip) {
        yield problem(index, ref, "pst_not_supported", PST_NOT_SUPPORTED_REASON, "pst");
      }
      return;
    }
    case "zip": {
      if (source.file && !source.nested) {
        yield* walkZip(source.file, state, ref);
        return;
      }
      const index = state.next();
      if (index >= state.skip) {
        yield problem(
          index,
          ref,
          "unsupported",
          "Nested ZIP archives are not imported. Extract the inner archive and import it as a file of its own.",
          "zip",
        );
      }
      return;
    }
    case "unknown": {
      const index = state.next();
      if (index < state.skip) {
        return;
      }
      const archive = detectOtherArchive(head);
      if (archive !== null) {
        yield problem(
          index,
          ref,
          "unsupported",
          `This is a ${archiveKindLabel(archive)} archive. Only ZIP archives can be imported, so extract it first or pack the mail files into a ZIP.`,
          "unknown",
        );
      } else if (EMLX_START.test(head.toString("latin1", 0, 512))) {
        yield problem(
          index,
          ref,
          "unsupported",
          "Apple Mail .emlx files are not supported. Export the mailbox from Apple Mail as MBOX and import that.",
          "unknown",
        );
      } else {
        yield problem(
          index,
          ref,
          "not_mail",
          "The file is not a mail message (EML or MSG), a mailbox (MBOX) or a ZIP archive.",
          "unknown",
        );
      }
      return;
    }
    case "mbox":
      yield* walkMbox(source, state);
      return;
    case "eml":
    case "msg":
      yield* walkMessageFile(source, state, detection.format);
      return;
    default:
      return;
  }
}

async function* walkMessageFile(
  source: Source,
  state: WalkState,
  format: "eml" | "msg",
): AsyncGenerator<MailWalkEvent> {
  const { ref, placement } = source;
  const index = state.next();
  if (index < state.skip) {
    return;
  }
  const limit = state.limits.maxMessageBytes;
  if (source.size > limit) {
    yield problem(index, ref, "too_large", tooLargeReason(source.size, limit), format);
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await readAll(await source.open(), limit, state.signal);
  } catch (error) {
    if (isAbort(error, state.signal)) {
      throw abortError();
    }
    if (error instanceof TooLargeError) {
      yield problem(index, ref, "too_large", tooLargeReason(error.bytes, limit), format);
    } else {
      yield problem(index, ref, "unreadable", "The file could not be read.", format);
    }
    return;
  }
  if (bytes.length !== source.size && !source.nested) {
    yield problem(
      index,
      ref,
      "unreadable",
      "The file ended earlier than expected, it may be incomplete.",
      format,
    );
    return;
  }
  const folder = folderFor(placement, format);
  if (format === "eml") {
    const raw = stripBom(bytes);
    const headers = readHeaderBlock(raw);
    yield {
      type: "message",
      ref,
      index,
      folder,
      sourceName: placement.base,
      format,
      raw,
      synthesized: false,
      flags: flagsFromHeaders(headers),
      internalDate: receivedOrSentDate(headers),
      sourceBytes: source.size,
    };
    return;
  }
  const converted = await readMsg(bytes, state.signal ? { signal: state.signal } : {});
  if (!converted.ok) {
    yield problem(index, ref, converted.code, converted.reason, "msg");
    return;
  }
  yield {
    type: "message",
    ref,
    index,
    folder,
    sourceName: placement.base,
    format,
    raw: converted.raw,
    synthesized: true,
    flags: converted.flags,
    internalDate: converted.internalDate,
    sourceBytes: source.size,
  };
}

async function* walkMbox(source: Source, state: WalkState): AsyncGenerator<MailWalkEvent> {
  const { ref, placement } = source;
  const folder = folderFor(placement, "mbox");
  if (state.atOrBeyondSkip) {
    yield { type: "folder", path: folder };
  }
  const start = state.index;
  const stats = { completedItems: 0 };
  const number = (item: { index: number }): number => item.index + 1;
  try {
    const stream = await source.open();
    for await (const item of splitMbox(stream, {
      maxMessageBytes: state.limits.maxMessageBytes,
      skipItems: Math.max(0, state.skip - start),
      ...(state.signal ? { signal: state.signal } : {}),
      stats,
    })) {
      const index = start + item.index;
      if (item.kind === "problem") {
        yield problem(index, `${ref}#${number(item)}`, item.code, item.reason, "mbox");
      } else {
        yield {
          type: "message",
          ref: `${ref}#${number(item)}`,
          index,
          folder,
          sourceName: `${placement.base}#${number(item)}`,
          format: "mbox",
          raw: item.raw,
          synthesized: false,
          flags: item.flags,
          internalDate: item.internalDate,
          sourceBytes: item.sourceBytes,
        };
      }
    }
    state.index = start + stats.completedItems;
  } catch (error) {
    if (isAbort(error, state.signal)) {
      throw abortError();
    }
    // The file broke in the middle: report it once, at the place where reading stopped.
    const index = start + stats.completedItems;
    state.index = index + 1;
    if (index >= state.skip) {
      yield problem(
        index,
        `${ref}#${index - start + 1}`,
        "unreadable",
        "The file could not be read to the end, the rest of it was not imported.",
        "mbox",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// ZIP

async function* walkZip(
  file: MailInputFile,
  state: WalkState,
  topRef: string,
): AsyncGenerator<MailWalkEvent> {
  const components = sanitizeArchivePath(file.path);
  const zipDirectories = components.slice(0, -1).map(folderNameOfDirectory);
  const zipName = components[components.length - 1] ?? "";
  const zipBase = stripSuffix(zipName, ".zip").trim() || DEFAULT_FOLDER;

  for await (const event of iterateZip(file, {
    limits: state.limits,
    ...(state.signal ? { signal: state.signal } : {}),
  })) {
    state.checkAbort();
    switch (event.kind) {
      case "directory": {
        // The (empty) __MACOSX directory of a Finder ZIP is no folder of the mailbox.
        if (event.path.some((part) => part.toLowerCase() === "__macosx")) {
          break;
        }
        if (state.atOrBeyondSkip) {
          yield {
            type: "folder",
            path: [...zipDirectories, ...event.path.map(folderNameOfDirectory)],
          };
        }
        break;
      }
      case "problem": {
        const index = state.next();
        if (index >= state.skip) {
          yield problem(
            index,
            event.name === null ? topRef : `${topRef}!${event.name}`,
            event.code,
            event.reason,
            "zip",
          );
        }
        break;
      }
      case "entry": {
        const placement = placementOf(event.components, zipDirectories, [
          ...zipDirectories,
          zipBase,
        ]);
        yield* walkSource(
          {
            size: event.size,
            ref: `${topRef}!${event.name}`,
            placement,
            nested: true,
            head: () => event.head(),
            open: () => event.open(),
          },
          state,
        );
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point

/**
 * Walk one input file. Never throws for a bad file (that becomes a problem
 * event); the exceptions are an abort, which throws an `AbortError`, and an
 * installation problem (no parser process can run), which throws an `Error`.
 */
export async function* walkMailFile(
  file: MailInputFile,
  options: WalkOptions = {},
): AsyncGenerator<MailWalkEvent> {
  const limits: MailFileLimits = { ...DEFAULT_MAIL_FILE_LIMITS, ...options.limits };
  const state = new WalkState(
    limits,
    Math.max(0, Math.floor(options.skipItems ?? 0)),
    options.signal,
  );
  state.checkAbort();

  const components = sanitizeArchivePath(file.path);
  const topRef = components[components.length - 1] ?? file.path;
  const placement = placementOf(components, [], [DEFAULT_FOLDER]);

  yield* walkSource(
    {
      size: file.size,
      ref: topRef,
      placement,
      nested: false,
      file,
      head: () => file.read(0, SNIFF_HEAD_BYTES),
      open: () => file.open(),
    },
    state,
  );
}
