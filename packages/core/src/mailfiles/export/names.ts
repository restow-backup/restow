/**
 * Portable, deterministic and unique names for the entries of an export.
 *
 * Message subjects and folder names are arbitrary text: they contain
 * characters Windows refuses, control characters, bidirectional overrides that
 * make `invoice.exe` look like `invoice.pdf`, names such as `CON`, trailing
 * dots and spaces, and they can be far longer than a file system allows. This
 * module turns them into names that extract cleanly on Windows, macOS and
 * Linux, and hands out each name once per folder (compared case-insensitively
 * and in Unicode normal form, because Windows and macOS treat `Inbox` and
 * `inbox`, or an accented letter written composed and decomposed, as the same file).
 *
 * The result depends only on the input and its order, never on the clock or
 * on randomness: exporting the same messages twice yields the same names.
 */
import type { ExportMessage } from "./types.js";

/** Longest name, in UTF-8 bytes, before the extension and the ` (2)` suffix. */
export const MAX_NAME_BYTES = 120;

/** Characters Windows refuses in file names, plus both path separators. */
const NOT_PORTABLE = /[<>:"/\\|?*]/g;
/**
 * Characters that must not appear in a name: C0 and C1 controls, DEL, the soft
 * hyphen, zero-width and bidirectional formatting characters, line and
 * paragraph separators, byte order mark and interlinear annotation marks.
 */
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed here
  /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{ad}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{206f}\u{feff}\u{fff9}-\u{fffb}]/gu;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** Device names Windows reserves regardless of the extension. */
const RESERVED_WINDOWS_NAME =
  /^(?:con|prn|aux|nul|com[0-9\u{b9}\u{b2}\u{b3}]|lpt[0-9\u{b9}\u{b2}\u{b3}])$/iu;

/** Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let bytes = 0;
  let end = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    end += codePoint.length;
  }
  return text.slice(0, end);
}

/**
 * One path component as a portable file or folder name. Returns "" when
 * nothing usable is left (callers pick their own fallback).
 */
export function sanitizeName(text: string, maxBytes: number = MAX_NAME_BYTES): string {
  let name = text
    .replace(LONE_SURROGATE, "\u{fffd}")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .replace(INVISIBLE, "")
    .replace(NOT_PORTABLE, "_")
    .trim();
  name = truncateUtf8(name, maxBytes)
    .replace(/[. ]+$/, "")
    .replace(/^ +/, "");
  if (name === "." || name === "..") {
    return "";
  }
  const stem = name.split(".", 1)[0]?.trimEnd() ?? "";
  return RESERVED_WINDOWS_NAME.test(stem) ? `_${name}` : name;
}

/** A folder name that is never empty, never `.` or `..` and never contains a separator. */
export function sanitizeFolderComponent(text: string): string {
  return sanitizeName(text) || "_";
}

/** `yyyy-mm-dd` (UTC) of a usable date, otherwise null. */
function isoDay(date: Date | null): string | null {
  if (date === null || Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** Prefix of the name of a message without a usable date. */
export const UNDATED = "undated";
/** Name part of a message without a subject. */
export const NO_SUBJECT = "(no subject)";

/**
 * The name of a message without extension: `<yyyy-mm-dd> <subject>` (UTC day),
 * cut to {@link MAX_NAME_BYTES}. A missing date reads `undated`, a missing or
 * unusable subject `(no subject)`.
 */
export function messageNameBase(message: Pick<ExportMessage, "date" | "subject">): string {
  const day = isoDay(message.date) ?? UNDATED;
  const room = MAX_NAME_BYTES - Buffer.byteLength(day, "utf8") - 1;
  const subject = sanitizeName(message.subject ?? "", room) || NO_SUBJECT;
  return `${day} ${subject}`;
}

/** Key under which two names count as the same file: case- and normalisation-insensitive. */
function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** Root-level files every ZIP export ends with. */
export const RESERVED_ROOT_NAMES = ["MANIFEST.csv", "SHA256SUMS"] as const;

/**
 * Hands out the names of one export. Files and folders share the namespace of
 * their parent folder (a ZIP cannot hold `A.mbox` as a file and as a folder).
 */
export class ExportNames {
  private readonly taken = new Map<string, Set<string>>();
  private readonly folders = new Map<string, readonly string[]>();

  constructor(reservedRootNames: readonly string[] = RESERVED_ROOT_NAMES) {
    for (const name of reservedRootNames) {
      this.take("", name);
    }
  }

  private take(parent: string, name: string): boolean {
    let names = this.taken.get(parent);
    if (names === undefined) {
      names = new Set();
      this.taken.set(parent, names);
    }
    const key = nameKey(name);
    if (names.has(key)) {
      return false;
    }
    names.add(key);
    return true;
  }

  /** `name` (plus `extension`) unique inside `parent`: `name (2).ext`, `name (3).ext`, ... */
  private claim(parent: string, name: string, extension: string): string {
    for (let counter = 1; ; counter++) {
      const candidate = `${counter === 1 ? name : `${name} (${counter})`}${extension}`;
      if (this.take(parent, candidate)) {
        return candidate;
      }
    }
  }

  /**
   * The portable, unique components of a folder path. The same folder always
   * maps to the same components; two folders that only differ in characters
   * the file system would merge (case, `:` versus `_`) get a ` (2)` suffix.
   */
  folder(path: readonly string[]): readonly string[] {
    let resolved: readonly string[] = [];
    for (let depth = 1; depth <= path.length; depth++) {
      const key = JSON.stringify(path.slice(0, depth));
      const known = this.folders.get(key);
      if (known !== undefined) {
        resolved = known;
        continue;
      }
      const parent = resolved.join("/");
      const leaf = this.claim(parent, sanitizeFolderComponent(path[depth - 1] ?? ""), "");
      resolved = [...resolved, leaf];
      this.folders.set(key, resolved);
    }
    return resolved;
  }

  /** Entry path (`a/b/<name>.eml`) of a message inside the resolved `folder` components. */
  messageEntry(
    folder: readonly string[],
    message: Pick<ExportMessage, "date" | "subject">,
    extension = ".eml",
  ): string {
    const parent = folder.join("/");
    const file = this.claim(parent, messageNameBase(message), extension);
    return parent === "" ? file : `${parent}/${file}`;
  }

  /**
   * Entry path of the MBOX file of a folder: `Inbox/2019` becomes
   * `Inbox/2019.mbox`, so a folder with messages and subfolders reads
   * `Inbox.mbox` next to `Inbox/`. Messages at the root go to `Messages.mbox`.
   */
  mboxEntry(path: readonly string[]): string {
    const resolved = this.folder(path);
    const leaf = resolved[resolved.length - 1];
    const parent = resolved.slice(0, -1).join("/");
    const file = this.claim(parent, leaf ?? "Messages", ".mbox");
    return parent === "" ? file : `${parent}/${file}`;
  }
}
