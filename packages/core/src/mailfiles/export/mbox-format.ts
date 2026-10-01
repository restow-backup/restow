/**
 * The mboxrd format, byte-wise and without ever decoding a message as text.
 *
 * A message in an mbox file is preceded by a separator line
 * `From <sender> <asctime UTC>` and followed by one blank line. To keep a body
 * line that itself starts with `From ` from being read as a separator, every
 * line of the message that matches `^>*From ` gets one more `>` in front
 * (mboxrd; the older mboxo and mboxcl variants lose information here). Reading
 * removes one `>` from lines matching `^>+From `, which restores the message
 * exactly.
 *
 * The message bytes are otherwise copied verbatim, including CRLF line ends and
 * 8-bit content. The one documented change: a message that does not end with a
 * line break gets one (CRLF or LF, following the message), because the blank
 * line after it must start on a new line. Separator and blank lines are LF.
 *
 * {@link MboxEscaper} works on arbitrary chunk boundaries with a state of a few
 * integers: memory does not depend on the length of a line, so a hostile
 * message made of one endless line cannot exhaust it.
 */

const LF = 0x0a;
const CR = 0x0d;
const GT = 0x3e;
const FROM = Buffer.from("From ", "latin1");
const ESCAPE = Buffer.from(">", "latin1");

enum State {
  /** Nothing of the current line seen yet. */
  LineStart = 0,
  /** Only `>` seen so far in this line. */
  Quotes = 1,
  /** `>*` followed by the first `matched` bytes of `From `, which are held back. */
  Matching = 2,
  /** The line cannot match any more. */
  InLine = 3,
}

export class MboxEscaper {
  private state: State = State.LineStart;
  private matched = 0;
  private eol: "\n" | "\r\n" = "\n";
  private lastByte = -1;
  private total = 0;

  /** Bytes consumed so far (the message size before escaping). */
  get bytes(): number {
    return this.total;
  }

  private noteBreak(chunk: Buffer, index: number): void {
    const before = index > 0 ? chunk[index - 1] : this.lastByte;
    this.eol = before === CR ? "\r\n" : "\n";
  }

  /**
   * Escape the next chunk of the message. The result is a list of pieces to be
   * written in order (mostly slices of `chunk` itself, so nothing is copied).
   */
  push(chunk: Buffer): Buffer[] {
    const out: Buffer[] = [];
    const length = chunk.length;
    if (length === 0) {
      return out;
    }
    let start = 0;
    let i = 0;
    while (i < length) {
      switch (this.state) {
        case State.InLine: {
          const newline = chunk.indexOf(LF, i);
          if (newline === -1) {
            i = length;
          } else {
            this.noteBreak(chunk, newline);
            i = newline + 1;
            this.state = State.LineStart;
          }
          break;
        }
        case State.LineStart:
        case State.Quotes: {
          const byte = chunk[i] as number;
          if (byte === GT) {
            this.state = State.Quotes;
            i++;
          } else if (byte === FROM[0]) {
            if (i > start) {
              out.push(chunk.subarray(start, i));
            }
            this.state = State.Matching;
            this.matched = 1;
            i++;
          } else if (byte === LF) {
            this.noteBreak(chunk, i);
            this.state = State.LineStart;
            i++;
          } else {
            this.state = State.InLine;
            i++;
          }
          break;
        }
        case State.Matching: {
          const byte = chunk[i] as number;
          if (byte === FROM[this.matched]) {
            this.matched++;
            i++;
            if (this.matched === FROM.length) {
              // `>*From `: the extra quote goes right in front of `From `.
              out.push(ESCAPE, FROM);
              this.matched = 0;
              this.state = State.InLine;
              start = i;
            }
          } else {
            // Not a separator look-alike: release the held-back bytes and rescan this byte.
            out.push(FROM.subarray(0, this.matched));
            this.matched = 0;
            this.state = State.InLine;
            start = i;
          }
          break;
        }
      }
    }
    if (this.state !== State.Matching && start < length) {
      out.push(chunk.subarray(start, length));
    }
    this.lastByte = chunk[length - 1] as number;
    this.total += length;
    return out;
  }

  /** The held-back bytes of an unfinished `From ` look-alike at the end of the message. */
  flush(): Buffer {
    if (this.state !== State.Matching) {
      return Buffer.alloc(0);
    }
    const held = Buffer.from(FROM.subarray(0, this.matched));
    this.matched = 0;
    this.state = State.InLine;
    return held;
  }

  /**
   * What follows the message: the held-back bytes of an unfinished `From `
   * look-alike, a line break in the message's own style if it does not end with
   * one, and the blank line that separates it from the next message. The blank
   * line is a bare LF whatever the message uses, like the separator line: that
   * is what mbox readers such as Python's mailbox module expect.
   */
  finish(): Buffer {
    const parts: Buffer[] = [this.flush()];
    if (this.total > 0 && this.lastByte !== LF) {
      parts.push(Buffer.from(this.eol, "latin1"));
    }
    parts.push(Buffer.from("\n", "latin1"));
    return Buffer.concat(parts);
  }
}

/** Escape a whole message (no separator line, no trailer). For tests and small inputs. */
export function mboxEscape(message: Buffer): Buffer {
  const escaper = new MboxEscaper();
  return Buffer.concat([...escaper.push(message), escaper.flush()]);
}

/**
 * Undo {@link mboxEscape}: remove one `>` from every line matching `^>+From `.
 * A whole-buffer reference implementation; readers of large files stream.
 */
export function mboxUnescape(message: Buffer): Buffer {
  const parts: Buffer[] = [];
  let lineStart = 0;
  while (lineStart < message.length) {
    const newline = message.indexOf(LF, lineStart);
    const lineEnd = newline === -1 ? message.length : newline + 1;
    let cursor = lineStart;
    while (message[cursor] === GT) {
      cursor++;
    }
    const quoted =
      cursor > lineStart && message.subarray(cursor, cursor + FROM.length).equals(FROM);
    parts.push(message.subarray(quoted ? lineStart + 1 : lineStart, lineEnd));
    lineStart = lineEnd;
  }
  return Buffer.concat(parts);
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

/** `Tue Mar  5 10:20:30 2024` (ctime/asctime layout, UTC). Unknown dates read as the epoch. */
export function asctime(date: Date | null): string {
  const usable = date !== null && !Number.isNaN(date.getTime()) ? date : new Date(0);
  const two = (value: number): string => String(value).padStart(2, "0");
  return [
    DAYS[usable.getUTCDay()],
    MONTHS[usable.getUTCMonth()],
    String(usable.getUTCDate()).padStart(2, " "),
    `${two(usable.getUTCHours())}:${two(usable.getUTCMinutes())}:${two(usable.getUTCSeconds())}`,
    String(usable.getUTCFullYear()).padStart(4, "0"),
  ].join(" ");
}

/** What stands in place of an unknown sender. */
export const MBOX_UNKNOWN_SENDER = "MAILER-DAEMON";

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters must never reach the separator line
const ANGLE_ADDRESS = /<([^<>\s\u0000-\u001f\u007f]+)>/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters must never reach the separator line
const BARE_ADDRESS = /([^\s<>"(),;:\\\u0000-\u001f\u007f]+@[^\s<>"(),;:\\\u0000-\u001f\u007f]+)/;

/** The bare address out of a `From` value (`Anna <anna@example.test>` gives `anna@example.test`). */
export function mboxSender(from: string | null): string {
  if (from === null) {
    return MBOX_UNKNOWN_SENDER;
  }
  const address = ANGLE_ADDRESS.exec(from)?.[1] ?? BARE_ADDRESS.exec(from)?.[1];
  return address !== undefined && address.length <= 256 ? address : MBOX_UNKNOWN_SENDER;
}

/** The separator line of a message, without line break. */
export function mboxSeparator(from: string | null, date: Date | null): string {
  return `From ${mboxSender(from)} ${asctime(date)}`;
}
