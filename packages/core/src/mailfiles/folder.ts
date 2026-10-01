/**
 * The server-side import folder (IMPORT_DIR): safe listing and reading of the
 * files an administrator dropped there.
 *
 * Every path that comes from a client is resolved against the folder's real
 * path: `..` components are refused, and so is anything whose real location
 * (after following symbolic links) is not inside the folder. Only regular files
 * and directories are ever listed, opened or walked; sockets, pipes, devices
 * and links that point outside are skipped.
 */
import { type Stats, createReadStream } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { Readable } from "node:stream";
import type { MailInputFile } from "./types.js";

export interface ImportFolderEntry {
  readonly name: string;
  /** Path relative to the import folder, '/'-separated. */
  readonly path: string;
  readonly type: "file" | "directory";
  readonly size: number | null;
  readonly modifiedAt: Date;
}

export type ImportFolderWalkEntry =
  | { readonly kind: "dir"; readonly path: string }
  | { readonly kind: "file"; readonly file: MailInputFile };

/** Thrown for a path outside the folder, a missing entry or a non-regular file. */
export class ImportFolderError extends Error {
  constructor(
    message: string,
    readonly code: "outside_root" | "not_found" | "not_regular" | "not_a_directory",
  ) {
    super(message);
    this.name = "ImportFolderError";
  }
}

export interface ImportFolderWalkOptions {
  /** Called for an entry the walk had to leave out (unreadable directory, link that points outside, ...). */
  readonly onSkipped?: (path: string, reason: string) => void;
  readonly signal?: AbortSignal;
}

/** Directories deeper than this are not entered (loop and abuse guard). */
const MAX_WALK_DEPTH = 128;

function compareNames(a: string, b: string): number {
  // Plain UTF-16 code unit order, independent of locale and platform.
  return a < b ? -1 : a > b ? 1 : 0;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * Split a client-supplied relative path into safe components. Leading and
 * repeated slashes and "." components are ignored; ".." and NUL are refused.
 */
export function splitRelativePath(input: string): string[] {
  if (input.includes("\0")) {
    throw new ImportFolderError("The path contains a NUL character", "outside_root");
  }
  const components: string[] = [];
  for (const component of input.split("/")) {
    if (component === "" || component === ".") {
      continue;
    }
    if (component === ".." || (process.platform === "win32" && /[\\:]/.test(component))) {
      throw new ImportFolderError("The path leaves the import folder", "outside_root");
    }
    components.push(component);
  }
  return components;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** A regular file on disk as an input file. Reads open the file per call, so nothing stays open. */
function localFile(realPath: string, displayPath: string, size: number): MailInputFile {
  return {
    path: displayPath,
    size,
    open(): Readable {
      if (size === 0) {
        return Readable.from([], { objectMode: false });
      }
      // Bounded to the size seen at listing time so `size` stays truthful if the file grows.
      return createReadStream(realPath, { start: 0, end: size - 1 });
    },
    async read(offset: number, length: number): Promise<Buffer> {
      if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length < 0) {
        throw new RangeError("negative read");
      }
      const wanted = Math.min(length, size - offset);
      if (wanted <= 0) {
        return Buffer.alloc(0);
      }
      const handle = await open(realPath, "r");
      try {
        const buffer = Buffer.allocUnsafe(wanted);
        let filled = 0;
        while (filled < wanted) {
          const { bytesRead } = await handle.read(buffer, filled, wanted - filled, offset + filled);
          if (bytesRead === 0) {
            break;
          }
          filled += bytesRead;
        }
        return filled === wanted ? buffer : buffer.subarray(0, filled);
      } finally {
        await handle.close();
      }
    },
  };
}

interface ResolvedPath {
  readonly components: string[];
  readonly real: string;
  readonly rootReal: string;
  readonly stats: Stats;
}

export class ImportFolder {
  constructor(readonly root: string) {}

  /** True when the root exists and is a readable directory. */
  async isAvailable(): Promise<boolean> {
    try {
      const real = await realpath(this.root);
      const stats = await stat(real);
      if (!stats.isDirectory()) {
        return false;
      }
      await readdir(real);
      return true;
    } catch {
      return false;
    }
  }

  private async rootReal(): Promise<string> {
    try {
      return await realpath(this.root);
    } catch {
      throw new ImportFolderError("The import folder does not exist", "not_found");
    }
  }

  /** Resolve a client path to a real location inside the root. */
  private async resolve(relativePath: string): Promise<ResolvedPath> {
    const components = splitRelativePath(relativePath);
    const rootReal = await this.rootReal();
    const candidate = join(rootReal, ...components);
    let real: string;
    try {
      real = await realpath(candidate);
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "ENAMETOOLONG") {
        throw new ImportFolderError("No such file or directory in the import folder", "not_found");
      }
      throw new ImportFolderError(
        `The path could not be read (${code ?? "unknown error"})`,
        "not_found",
      );
    }
    if (!isInside(rootReal, real)) {
      throw new ImportFolderError("The path leaves the import folder", "outside_root");
    }
    let stats: Stats;
    try {
      stats = await stat(real);
    } catch {
      throw new ImportFolderError("No such file or directory in the import folder", "not_found");
    }
    return { components, real, rootReal, stats };
  }

  /** One directory level, sorted by name (plain UTF-16 code unit order). */
  async list(relativeDirectory: string, limit?: number): Promise<ImportFolderEntry[]> {
    const resolved = await this.resolve(relativeDirectory);
    if (!resolved.stats.isDirectory()) {
      throw new ImportFolderError("The path is not a directory", "not_a_directory");
    }
    let names: string[];
    try {
      names = await readdir(resolved.real);
    } catch {
      throw new ImportFolderError("The directory could not be read", "not_found");
    }
    names.sort(compareNames);
    const entries: ImportFolderEntry[] = [];
    const prefix = resolved.components.length > 0 ? `${resolved.components.join("/")}/` : "";
    for (const name of names) {
      if (limit !== undefined && entries.length >= limit) {
        break;
      }
      const target = await this.classify(resolved.real, name, resolved.rootReal);
      if (target === null) {
        continue;
      }
      entries.push({
        name,
        path: `${prefix}${name}`,
        type: target.stats.isDirectory() ? "directory" : "file",
        size: target.stats.isDirectory() ? null : target.stats.size,
        modifiedAt: target.stats.mtime,
      });
    }
    return entries;
  }

  /**
   * The regular file or directory a directory entry stands for, or null when it
   * is something else or a link that leaves the folder.
   */
  private async classify(
    directoryReal: string,
    name: string,
    rootReal: string,
  ): Promise<{ real: string; stats: Stats } | null> {
    try {
      const path = join(directoryReal, name);
      const real = await realpath(path);
      if (!isInside(rootReal, real)) {
        return null;
      }
      const stats = await stat(real);
      return stats.isFile() || stats.isDirectory() ? { real, stats } : null;
    } catch {
      return null;
    }
  }

  /** A regular file of the folder as an input file (path = the relative path given). */
  async file(relativePath: string): Promise<MailInputFile> {
    const resolved = await this.resolve(relativePath);
    if (resolved.components.length === 0 || !resolved.stats.isFile()) {
      throw new ImportFolderError("The path is not a regular file", "not_regular");
    }
    return localFile(resolved.real, resolved.components.join("/"), resolved.stats.size);
  }

  /**
   * Everything below `relativeDirectory`, recursively, in a deterministic order:
   * per directory the names in UTF-16 code unit order, files and directories
   * interleaved by name, a directory before its content.
   * `file.path` is relative to `relativeDirectory`.
   */
  async *walk(
    relativeDirectory: string,
    options: ImportFolderWalkOptions = {},
  ): AsyncGenerator<ImportFolderWalkEntry> {
    const resolved = await this.resolve(relativeDirectory);
    if (!resolved.stats.isDirectory()) {
      throw new ImportFolderError("The path is not a directory", "not_a_directory");
    }
    const { rootReal, real } = resolved;
    const ancestors = new Set<string>([real]);
    const self = this;

    async function* walkDirectory(
      directoryReal: string,
      prefix: string,
      depth: number,
    ): AsyncGenerator<ImportFolderWalkEntry> {
      if (options.signal?.aborted) {
        throw abortError();
      }
      let names: string[];
      try {
        names = await readdir(directoryReal);
      } catch (error) {
        options.onSkipped?.(
          prefix.replace(/\/$/, ""),
          `The directory could not be read (${errnoCode(error) ?? "unknown error"})`,
        );
        return;
      }
      names.sort(compareNames);
      for (const name of names) {
        const relative = `${prefix}${name}`;
        const target = await self.classify(directoryReal, name, rootReal);
        if (target === null) {
          options.onSkipped?.(
            relative,
            "Not a regular file or directory, or a link that leaves the import folder",
          );
          continue;
        }
        if (target.stats.isDirectory()) {
          if (ancestors.has(target.real)) {
            options.onSkipped?.(relative, "A link that points back to a parent directory");
            continue;
          }
          if (depth >= MAX_WALK_DEPTH) {
            options.onSkipped?.(relative, "The directory tree is nested too deeply");
            continue;
          }
          yield { kind: "dir", path: relative };
          ancestors.add(target.real);
          try {
            yield* walkDirectory(target.real, `${relative}/`, depth + 1);
          } finally {
            ancestors.delete(target.real);
          }
        } else {
          yield { kind: "file", file: localFile(target.real, relative, target.stats.size) };
        }
      }
    }

    yield* walkDirectory(real, "", 0);
  }
}
