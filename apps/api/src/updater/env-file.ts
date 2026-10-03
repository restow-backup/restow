import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The project's `.env`, edited precisely. An update changes two variables
 * (RESTOW_IMAGE, RESTOW_WEB_IMAGE); the updater's own image (RESTOW_UPDATER_IMAGE)
 * is written only pinned by digest (self-update.ts). Everything else stays exactly
 * as the operator wrote it: comments, blank lines, order, quoting, line endings, a missing
 * final newline. A rollback puts the two variables back byte for byte, including
 * "the variable was not there".
 *
 * The file is treated as a list of lines that each remember their own terminator
 * (`\n`, `\r\n` or none for a last line without one), so rendering the parsed lines
 * reproduces the input exactly.
 */

export type LineEnding = "" | "\n" | "\r\n";

export interface EnvLine {
  text: string;
  eol: LineEnding;
}

/** What one variable looked like before the update. */
export interface CapturedKey {
  present: boolean;
  /** The last assignment line as written (without its line ending); null when absent. */
  line: string | null;
  /** The parsed value (quotes removed); null when absent. */
  value: string | null;
}

export type CapturedEnv = Record<string, CapturedKey>;

/**
 * The lines of `.env` an update writes: the images of the application roles and of
 * the web edge. Everything else in the file belongs to the operator;
 * {@link EnvFile.apply} refuses it.
 */
export const UPDATER_WRITABLE_KEYS: readonly string[] = ["RESTOW_IMAGE", "RESTOW_WEB_IMAGE"];

/**
 * The updater's own image. Never written by {@link EnvFile.apply}: only
 * {@link EnvFile.pinUpdaterImage} writes it, and only with a reference pinned by
 * digest (self-update.ts: the image the updater runs, or a release image whose
 * signature it verified).
 */
export const UPDATER_IMAGE_KEY = "RESTOW_UPDATER_IMAGE";

/** An image reference that names its content by digest (`name[:tag]@sha256:<64 hex>`). */
const DIGEST_PINNED = /^[a-z0-9][a-z0-9._/:-]{0,199}@sha256:[0-9a-f]{64}$/;

export class EnvFileError extends Error {
  constructor(
    message: string,
    readonly reason: "missing" | "unwritable" | "invalid_value" | "invalid_setting",
  ) {
    super(message);
    this.name = "EnvFileError";
  }
}

function assertWritableKeys(keys: readonly string[]): void {
  const foreign = keys.filter((key) => !UPDATER_WRITABLE_KEYS.includes(key));
  if (foreign.length > 0) {
    throw new EnvFileError(
      `The updater writes only ${UPDATER_WRITABLE_KEYS.join(" and ")} in .env, not ${foreign.join(", ")}.`,
      "invalid_setting",
    );
  }
}

export function parseEnvLines(text: string): EnvLine[] {
  const lines: EnvLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      lines.push({ text: text.slice(start), eol: "" });
      break;
    }
    const crlf = newline > start && text[newline - 1] === "\r";
    lines.push({
      text: text.slice(start, crlf ? newline - 1 : newline),
      eol: crlf ? "\r\n" : "\n",
    });
    start = newline + 1;
  }
  return lines;
}

export function renderEnvLines(lines: readonly EnvLine[]): string {
  return lines.map((line) => line.text + line.eol).join("");
}

function dominantEol(lines: readonly EnvLine[]): "\n" | "\r\n" {
  return lines.some((line) => line.eol === "\r\n") ? "\r\n" : "\n";
}

/** The variable a line assigns (`KEY=...`, `export KEY=...`), or null for comments and other lines. */
export function assignedKey(lineText: string): string | null {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(lineText);
  return match?.[1] ?? null;
}

/** The value part of an assignment line with quotes and inline comment removed. */
export function assignedValue(lineText: string): string {
  const equals = lineText.indexOf("=");
  const raw = lineText.slice(equals + 1).trimStart();
  const quote = raw[0];
  if (quote === '"') {
    let value = "";
    for (let index = 1; index < raw.length; index++) {
      const char = raw[index] as string;
      if (char === "\\" && index + 1 < raw.length) {
        const next = raw[index + 1] as string;
        if (next === '"' || next === "\\") {
          value += next;
          index += 1;
          continue;
        }
      }
      if (char === '"') {
        return value;
      }
      value += char;
    }
    return value;
  }
  if (quote === "'") {
    const end = raw.indexOf("'", 1);
    return end === -1 ? raw.slice(1) : raw.slice(1, end);
  }
  return raw.replace(/\s+#.*$/, "").trim();
}

function lastAssignmentIndex(lines: readonly EnvLine[], key: string): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (assignedKey((lines[index] as EnvLine).text) === key) {
      return index;
    }
  }
  return -1;
}

/** The parsed value of a variable (the last assignment wins, as in Compose); null when absent. */
export function envValueOf(text: string, key: string): string | null {
  const lines = parseEnvLines(text);
  const index = lastAssignmentIndex(lines, key);
  return index === -1 ? null : assignedValue((lines[index] as EnvLine).text);
}

export function captureKeys(text: string, keys: readonly string[]): CapturedEnv {
  const lines = parseEnvLines(text);
  const captured: CapturedEnv = {};
  for (const key of keys) {
    const index = lastAssignmentIndex(lines, key);
    if (index === -1) {
      captured[key] = { present: false, line: null, value: null };
    } else {
      const line = (lines[index] as EnvLine).text;
      captured[key] = { present: true, line, value: assignedValue(line) };
    }
  }
  return captured;
}

/** A value the updater may write: an image reference, nothing that Compose or a shell would interpret. */
export function assertSafeEnvValue(key: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,299}$/.test(value)) {
    throw new EnvFileError(`The value for ${key} is not a plain image reference.`, "invalid_value");
  }
}

function assertKnownKey(key: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new EnvFileError(`Unsupported variable name ${key}.`, "invalid_setting");
  }
}

function removeLine(lines: EnvLine[], index: number): void {
  const [removed] = lines.splice(index, 1);
  // A last line without a terminator: the line before it gives up its terminator too,
  // so the file ends the way it did before that line was added.
  if (removed && removed.eol === "" && index > 0) {
    (lines[index - 1] as EnvLine).eol = "";
  }
}

function appendLine(lines: EnvLine[], text: string): void {
  const eol = dominantEol(lines);
  const last = lines[lines.length - 1];
  if (!last) {
    lines.push({ text, eol });
    return;
  }
  if (last.eol === "") {
    // The file had no final newline: keep it that way.
    last.eol = eol;
    lines.push({ text, eol: "" });
    return;
  }
  lines.push({ text, eol: last.eol });
}

/**
 * Set variables. An existing assignment (the last one, when there are several) is
 * replaced in place; a missing one is appended. Everything else stays untouched.
 */
export function setKeys(text: string, assignments: Readonly<Record<string, string>>): string {
  const lines = parseEnvLines(text);
  for (const [key, value] of Object.entries(assignments)) {
    assertKnownKey(key);
    assertSafeEnvValue(key, value);
    const index = lastAssignmentIndex(lines, key);
    const previous = index === -1 ? null : (lines[index] as EnvLine).text;
    const prefix = previous && /^\s*export\s+/.test(previous) ? "export " : "";
    const assignment = `${prefix}${key}=${value}`;
    if (index === -1) {
      appendLine(lines, assignment);
    } else {
      (lines[index] as EnvLine).text = assignment;
    }
  }
  return renderEnvLines(lines);
}

/**
 * Put captured variables back exactly as they were: the original line where the
 * variable existed, no line at all where it did not.
 */
export function restoreKeys(text: string, captured: CapturedEnv): string {
  const lines = parseEnvLines(text);
  for (const [key, before] of Object.entries(captured)) {
    assertKnownKey(key);
    if (before.present && before.line !== null) {
      const index = lastAssignmentIndex(lines, key);
      if (index === -1) {
        appendLine(lines, before.line);
      } else {
        (lines[index] as EnvLine).text = before.line;
      }
      // Earlier duplicate assignments were never touched by setKeys; nothing else to do.
    } else {
      for (let index = lines.length - 1; index >= 0; index--) {
        if (assignedKey((lines[index] as EnvLine).text) === key) {
          removeLine(lines, index);
        }
      }
    }
  }
  return renderEnvLines(lines);
}

const POSTGRES_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;

export interface PostgresSettings {
  user: string;
  db: string;
}

/** POSTGRES_USER and POSTGRES_DB as Compose resolves them (empty or missing: `restow`). */
export function postgresSettings(text: string): PostgresSettings {
  const read = (key: string): string => {
    const value = envValueOf(text, key);
    return value === null || value === "" ? "restow" : value;
  };
  const user = read("POSTGRES_USER");
  const db = read("POSTGRES_DB");
  for (const [key, value] of [
    ["POSTGRES_USER", user],
    ["POSTGRES_DB", db],
  ] as const) {
    if (!POSTGRES_NAME.test(value)) {
      throw new EnvFileError(
        `${key} in .env is not a plain name (letters, digits, underscore, dot, dash).`,
        "invalid_value",
      );
    }
  }
  return { user, db };
}

/** File access for the project's `.env`. */
export class EnvFile {
  constructor(readonly filePath: string) {}

  async read(): Promise<string> {
    try {
      return await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new EnvFileError("The project has no .env file.", "missing");
      }
      throw error;
    }
  }

  /** `.env` exists and can be replaced: the file is writable and so is its directory. */
  async assertWritable(): Promise<void> {
    try {
      await fs.access(this.filePath, fsConstants.R_OK | fsConstants.W_OK);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new EnvFileError("The project has no .env file.", "missing");
      }
      throw new EnvFileError(`The .env file is not writable (${errnoName(error)}).`, "unwritable");
    }
    try {
      await fs.access(path.dirname(await fs.realpath(this.filePath)), fsConstants.W_OK);
    } catch (error) {
      throw new EnvFileError(
        `The project directory is not writable (${errnoName(error)}).`,
        "unwritable",
      );
    }
  }

  async capture(keys: readonly string[]): Promise<CapturedEnv> {
    return captureKeys(await this.read(), keys);
  }

  async apply(assignments: Readonly<Record<string, string>>): Promise<void> {
    assertWritableKeys(Object.keys(assignments));
    await this.replace(setKeys(await this.read(), assignments));
  }

  async restore(captured: CapturedEnv): Promise<void> {
    assertWritableKeys(Object.keys(captured));
    await this.replace(restoreKeys(await this.read(), captured));
  }

  /**
   * Set RESTOW_UPDATER_IMAGE to an image pinned by digest; any other value is refused.
   * Returns what the line was before, for {@link restoreUpdaterImage}.
   */
  async pinUpdaterImage(reference: string): Promise<CapturedKey> {
    if (!DIGEST_PINNED.test(reference)) {
      throw new EnvFileError(
        `${UPDATER_IMAGE_KEY} is only written with an image pinned by digest.`,
        "invalid_value",
      );
    }
    const text = await this.read();
    const before = captureKeys(text, [UPDATER_IMAGE_KEY])[UPDATER_IMAGE_KEY] as CapturedKey;
    await this.replace(setKeys(text, { [UPDATER_IMAGE_KEY]: reference }));
    return before;
  }

  /** Put RESTOW_UPDATER_IMAGE back as {@link pinUpdaterImage} found it. */
  async restoreUpdaterImage(before: CapturedKey): Promise<void> {
    await this.replace(restoreKeys(await this.read(), { [UPDATER_IMAGE_KEY]: before }));
  }

  /** Atomic replace (temporary file, fsync, rename), keeping mode and owner. */
  async replace(content: string): Promise<void> {
    const target = await fs.realpath(this.filePath);
    const before = await fs.stat(target);
    if (content === (await fs.readFile(target, "utf8"))) {
      return;
    }
    const directory = path.dirname(target);
    const temporary = path.join(directory, `.env.restow-updater-${process.pid}.tmp`);
    const handle = await fs.open(temporary, "wx", before.mode & 0o7777);
    try {
      await handle.writeFile(content, "utf8");
      await handle.chmod(before.mode & 0o7777);
      try {
        await handle.chown(before.uid, before.gid);
      } catch {
        // Not permitted (not root): the file keeps the owner it was created with.
      }
      await handle.sync();
    } catch (error) {
      await handle.close();
      await fs.rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      if (isErrno(error, "EBUSY") || isErrno(error, "EXDEV")) {
        // `.env` is a single-file bind mount: it cannot be replaced, only rewritten.
        await this.rewriteInPlace(target, content);
        return;
      }
      throw error;
    }
    await syncDirectory(directory);
  }

  private async rewriteInPlace(target: string, content: string): Promise<void> {
    const handle = await fs.open(target, "r+");
    try {
      await handle.truncate(0);
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some file systems refuse fsync on directories; the rename itself is already atomic.
  }
}

function errnoName(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "error";
}

function isErrno(error: unknown, code: string): boolean {
  return errnoName(error) === code;
}
