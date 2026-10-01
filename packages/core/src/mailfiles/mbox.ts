/**
 * Streaming MBOX reader (mboxrd, mboxo and the Thunderbird / Apple Mail flavours).
 *
 * The file is never held in memory: bytes are scanned line by line as they
 * arrive and only the message being assembled is buffered, bounded by
 * `maxMessageBytes`. A message beyond the limit is counted and skipped without
 * buffering it, and items that a resumed run skips are counted without buffering
 * either.
 *
 * Rules (docs/IMPORT.md):
 *   - a message starts at a line beginning with `From ` at the start of the file
 *     or after a blank line;
 *   - the blank separator line in front of the next `From ` line is not part of
 *     the message (the last message loses a trailing blank line as well);
 *   - mboxrd un-escaping: one leading `>` is removed from lines matching
 *     `^>+From `;
 *   - LF and CRLF files both work; a `\r` stays part of the message bytes;
 *   - flags come from the `Status`, `X-Status` and `X-Mozilla-Status` headers,
 *     the `From ` line's date becomes the internal date.
 */
import { flagsFromHeaders, parseFromLineDate, readHeaderBlock } from "./headers.js";
import { isHeaderLine } from "./sniff.js";

export interface SplitMboxOptions {
  /** Largest message that is buffered; bigger ones yield a `too_large` problem. */
  readonly maxMessageBytes: number;
  /** Count the first n items without buffering or yielding them (resume). */
  readonly skipItems?: number;
  readonly signal?: AbortSignal;
  /**
   * Updated while the stream is read: how many items are complete (yielded or
   * skipped). After an error this tells where the stream broke.
   */
  readonly stats?: { completedItems: number };
}

export interface MboxMessageItem {
  readonly kind: "message";
  /** 0-based number among the items (messages and problems) of the file. */
  readonly index: number;
  readonly raw: Buffer;
  readonly flags: readonly string[];
  readonly internalDate: Date | null;
  /** Bytes of the file this item spans, `From ` line and separator included. */
  readonly sourceBytes: number;
}

export interface MboxProblemItem {
  readonly kind: "problem";
  readonly index: number;
  readonly code: "too_large" | "empty" | "unreadable";
  readonly reason: string;
  readonly sourceBytes: number;
}

export type MboxItem = MboxMessageItem | MboxProblemItem;

/** A line longer than this is fed in pieces; classification only needs the start. */
const MAX_CARRY = 1024 * 1024;
const UTF8_BOM = [0xef, 0xbb, 0xbf];
const FROM_BYTES = Buffer.from("From ", "latin1");
const GT = 0x3e;
const LF = 0x0a;
const CR = 0x0d;

/** True when the buffer holds a byte above the space (a plain loop: `Buffer.some` calls back per byte). */
function hasVisibleByte(buffer: Buffer): boolean {
  for (let i = 0; i < buffer.length; i++) {
    if ((buffer[i] as number) > 0x20) {
      return true;
    }
  }
  return false;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Runs of message bytes that are not merged yet. A run is as short as one line when the
 * lines alternate between ones that need un-escaping (`>From `) and ones that do not, and a
 * Buffer view costs about 100 bytes of heap: 64 MiB of eight-byte lines would take a
 * gigabyte. Past this many, the loose runs are copied into one Buffer.
 */
const MAX_LOOSE_PARTS = 4096;

interface Current {
  readonly index: number;
  readonly fromText: string;
  mode: "skip" | "collect" | "oversize";
  parts: Buffer[];
  /** Parts before this index are merged chunks; the ones from here on are runs still to merge. */
  compacted: number;
  /** Message bytes seen (also counted in skip and oversize mode). */
  messageBytes: number;
  /** Source bytes of the item including the `From ` line. */
  sourceBytes: number;
  /** Length of the blank line that ended the collected content, 0 if the last line is not blank. */
  lastBlankLength: number;
}

/**
 * The push-style core: feed chunks, get finished items. Exposed for the
 * generator below and for tests.
 */
export class MboxSplitter {
  private carry: Buffer | null = null;
  private midLine = false;
  private prevBlank = true;
  private started = false;
  private bomChecked = false;
  private nextIndex = 0;
  private current: Current | null = null;
  private preambleBytes = 0;
  private preambleNonBlank = false;
  private ready: MboxItem[] = [];
  private completed = 0;

  // Open run of contiguous bytes inside one buffer, flushed into the message parts.
  private runBuffer: Buffer | null = null;
  private runStart = 0;
  private runEnd = 0;

  constructor(private readonly options: SplitMboxOptions) {}

  /** Feed a chunk; returns the items that became complete. */
  push(chunk: Buffer): MboxItem[] {
    let data = chunk;
    if (!this.bomChecked) {
      const head = this.carry ? Buffer.concat([this.carry, data]) : data;
      this.carry = null;
      if (
        head.length < UTF8_BOM.length &&
        UTF8_BOM.slice(0, head.length).every((b, i) => head[i] === b)
      ) {
        // Too short to know yet whether this is a byte order mark.
        this.carry = Buffer.from(head);
        return this.take();
      }
      this.bomChecked = true;
      data = UTF8_BOM.every((b, i) => head[i] === b) ? head.subarray(UTF8_BOM.length) : head;
    }
    const buffer = this.carry && this.carry.length > 0 ? Buffer.concat([this.carry, data]) : data;
    this.carry = null;
    let position = 0;
    for (;;) {
      const newline = buffer.indexOf(LF, position);
      if (newline === -1) {
        break;
      }
      this.line(buffer, position, newline + 1, true);
      position = newline + 1;
    }
    if (position < buffer.length) {
      const rest = buffer.length - position;
      if (this.midLine || rest > MAX_CARRY) {
        this.line(buffer, position, buffer.length, false);
      } else {
        this.carry = Buffer.from(buffer.subarray(position));
      }
    }
    this.flushRun();
    return this.take();
  }

  /** Signal the end of the file; returns the last items. */
  end(): MboxItem[] {
    if (!this.bomChecked && this.carry) {
      // A file shorter than a byte order mark.
      const rest = this.carry;
      this.carry = null;
      this.bomChecked = true;
      this.line(rest, 0, rest.length, false);
    } else if (this.carry && this.carry.length > 0) {
      const rest = this.carry;
      this.carry = null;
      this.line(rest, 0, rest.length, false);
    }
    this.flushRun();
    this.finishCurrent();
    if (!this.started && this.preambleNonBlank) {
      this.emitPreambleProblem();
    }
    return this.take();
  }

  /** Bytes currently held in memory for the message being assembled (for tests and diagnostics). */
  bufferedBytes(): number {
    const parts = this.current?.parts.reduce((sum, part) => sum + part.length, 0) ?? 0;
    return parts + (this.runBuffer ? this.runEnd - this.runStart : 0) + (this.carry?.length ?? 0);
  }

  /** Items that are finished so far (yielded, skipped or failed). */
  get completedItems(): number {
    return this.completed;
  }

  private take(): MboxItem[] {
    const items = this.ready;
    this.ready = [];
    if (this.options.stats) {
      this.options.stats.completedItems = this.completed;
    }
    return items;
  }

  private isBlank(buffer: Buffer, start: number, end: number, complete: boolean): boolean {
    const length = end - start;
    return (
      complete &&
      ((length === 1 && buffer[start] === LF) ||
        (length === 2 && buffer[start] === CR && buffer[start + 1] === LF))
    );
  }

  private startsWithFrom(buffer: Buffer, start: number, end: number): boolean {
    return (
      end - start >= FROM_BYTES.length &&
      buffer[start] === 0x46 &&
      buffer.compare(FROM_BYTES, 0, 5, start, start + 5) === 0
    );
  }

  private line(buffer: Buffer, start: number, end: number, complete: boolean): void {
    if (this.midLine) {
      // The rest of a line whose start was classified already.
      if (this.current) {
        this.append(buffer, start, end, 0, false);
      } else {
        this.notePreamble(buffer, start, end);
      }
      if (complete) {
        this.midLine = false;
        this.prevBlank = false;
      }
      return;
    }
    const blank = this.isBlank(buffer, start, end, complete);
    if (this.prevBlank && this.startsWithFrom(buffer, start, end)) {
      this.flushRun();
      this.finishCurrent();
      this.beginMessage(buffer, start, end);
      this.prevBlank = false;
      this.midLine = !complete;
      return;
    }
    if (!this.current) {
      this.notePreamble(buffer, start, end);
    } else {
      // mboxrd: `>From ` -> `From `, `>>From ` -> `>From `.
      let skip = 0;
      if (buffer[start] === GT) {
        let k = start;
        while (k < end && buffer[k] === GT) {
          k++;
        }
        if (this.startsWithFrom(buffer, k, end)) {
          skip = 1;
        }
      }
      this.append(buffer, start, end, skip, blank);
    }
    this.prevBlank = blank;
    this.midLine = !complete;
  }

  private notePreamble(buffer: Buffer, start: number, end: number): void {
    this.preambleBytes += end - start;
    if (!this.preambleNonBlank) {
      for (let i = start; i < end; i++) {
        const byte = buffer[i] as number;
        if (byte !== LF && byte !== CR && byte !== 0x20 && byte !== 0x09) {
          this.preambleNonBlank = true;
          break;
        }
      }
    }
  }

  private beginMessage(buffer: Buffer, start: number, end: number): void {
    if (!this.started) {
      this.started = true;
      if (this.preambleNonBlank) {
        this.emitPreambleProblem();
      }
    }
    const index = this.nextIndex++;
    const skipping = index < (this.options.skipItems ?? 0);
    const fromText = skipping
      ? ""
      : buffer
          .toString("latin1", start + FROM_BYTES.length, Math.min(end, start + 1024))
          .replace(/\r?\n$/, "");
    this.current = {
      index,
      fromText,
      mode: skipping ? "skip" : "collect",
      parts: [],
      compacted: 0,
      messageBytes: 0,
      sourceBytes: end - start,
      lastBlankLength: 0,
    };
  }

  private emitPreambleProblem(): void {
    const index = this.nextIndex++;
    this.completed++;
    if (index < (this.options.skipItems ?? 0)) {
      return;
    }
    this.ready.push({
      kind: "problem",
      index,
      code: "unreadable",
      reason: `The file has ${this.preambleBytes} bytes of content in front of the first message, which were ignored.`,
      sourceBytes: this.preambleBytes,
    });
  }

  private append(buffer: Buffer, start: number, end: number, skip: number, blank: boolean): void {
    const current = this.current;
    if (!current) {
      return;
    }
    current.sourceBytes += end - start;
    const length = end - start - skip;
    current.messageBytes += length;
    if (current.mode === "skip") {
      return;
    }
    current.lastBlankLength = blank ? end - start : 0;
    if (current.mode === "oversize") {
      return;
    }
    // A little slack for the blank separator line, which is not part of the message.
    if (current.messageBytes > this.options.maxMessageBytes + 2) {
      current.mode = "oversize";
      current.parts = [];
      current.compacted = 0;
      this.runBuffer = null;
      return;
    }
    const from = start + skip;
    if (this.runBuffer === buffer && this.runEnd === from) {
      this.runEnd = end;
    } else {
      this.flushRun();
      this.runBuffer = buffer;
      this.runStart = from;
      this.runEnd = end;
    }
  }

  private flushRun(): void {
    if (
      this.runBuffer &&
      this.current &&
      this.current.mode === "collect" &&
      this.runEnd > this.runStart
    ) {
      const current = this.current;
      current.parts.push(this.runBuffer.subarray(this.runStart, this.runEnd));
      if (current.parts.length - current.compacted >= MAX_LOOSE_PARTS) {
        const loose = current.parts.splice(current.compacted);
        current.parts.push(Buffer.concat(loose));
        current.compacted = current.parts.length;
      }
    }
    this.runBuffer = null;
  }

  private finishCurrent(): void {
    const current = this.current;
    this.current = null;
    if (!current) {
      return;
    }
    this.completed++;
    if (current.mode === "skip") {
      return;
    }
    const messageSize = current.messageBytes - current.lastBlankLength;
    if (current.mode === "oversize" || messageSize > this.options.maxMessageBytes) {
      this.ready.push({
        kind: "problem",
        index: current.index,
        code: "too_large",
        reason: `The message is ${formatSize(messageSize)}, which is more than the limit of ${formatSize(this.options.maxMessageBytes)} for one message.`,
        sourceBytes: current.sourceBytes,
      });
      return;
    }
    let raw =
      current.parts.length === 1 ? (current.parts[0] as Buffer) : Buffer.concat(current.parts);
    if (current.lastBlankLength > 0) {
      raw = raw.subarray(0, raw.length - current.lastBlankLength);
    }
    if (!hasVisibleByte(raw)) {
      this.ready.push({
        kind: "problem",
        index: current.index,
        code: "empty",
        reason: "The MBOX message has no content.",
        sourceBytes: current.sourceBytes,
      });
      return;
    }
    const firstLineEnd = raw.indexOf(LF);
    const firstLine = raw
      .toString("latin1", 0, Math.min(firstLineEnd === -1 ? raw.length : firstLineEnd, 998))
      .replace(/\r$/, "");
    if (!isHeaderLine(firstLine)) {
      this.ready.push({
        kind: "problem",
        index: current.index,
        code: "empty",
        reason: "The MBOX message has no headers.",
        sourceBytes: current.sourceBytes,
      });
      return;
    }
    // Copy so the message no longer pins the (possibly large) chunks it was cut from.
    const owned = Buffer.from(raw);
    this.ready.push({
      kind: "message",
      index: current.index,
      raw: owned,
      flags: flagsFromHeaders(readHeaderBlock(owned)),
      internalDate: parseFromLineDate(current.fromText),
      sourceBytes: current.sourceBytes,
    });
  }
}

/**
 * Split an MBOX byte stream into messages and problems, streaming.
 * Aborting throws an `AbortError`.
 */
export async function* splitMbox(
  stream: AsyncIterable<Buffer | Uint8Array | string>,
  options: SplitMboxOptions,
): AsyncGenerator<MboxItem> {
  const splitter = new MboxSplitter(options);
  for await (const chunk of stream) {
    if (options.signal?.aborted) {
      throw abortError();
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string);
    for (const item of splitter.push(buffer)) {
      yield item;
    }
  }
  if (options.signal?.aborted) {
    throw abortError();
  }
  for (const item of splitter.end()) {
    yield item;
  }
}
