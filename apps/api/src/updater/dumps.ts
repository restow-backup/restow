import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DumpInfo } from "./protocol.js";

/**
 * Database dumps taken before an update, in `<state>/dumps`. The updater is the
 * only writer. Names are `restow-<UTC yyyymmdd-hhmmss>-<from>-to-<to>.dump`; only
 * files with exactly that shape are ever listed or deleted, so nothing else the
 * operator (or a mistake) put into the directory can be touched.
 */

/** How many dumps are kept. */
export const KEEP_DUMPS = 3;

const VERSION_PART = "[0-9A-Za-z._-]{1,64}";
const DUMP_NAME = new RegExp(
  `^restow-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})-(${VERSION_PART})-to-(${VERSION_PART})\\.dump$`,
);

/** A version as it appears in a file name: characters outside the safe set become `_`. */
export function versionForFileName(version: string | null): string {
  if (!version) {
    return "unknown";
  }
  const cleaned = version.replace(/[^0-9A-Za-z._-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "unknown";
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function dumpFileName(at: Date, from: string | null, to: string): string {
  const stamp = `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}-${pad(at.getUTCHours(), 2)}${pad(at.getUTCMinutes(), 2)}${pad(at.getUTCSeconds(), 2)}`;
  return `restow-${stamp}-${versionForFileName(from)}-to-${versionForFileName(to)}.dump`;
}

/** The moment a dump file name encodes; null when the name is not one of ours. */
export function parseDumpFileName(
  name: string,
): { createdAt: Date; from: string; to: string } | null {
  const match = DUMP_NAME.exec(name);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second, from, to] = match;
  const createdAt = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }
  return { createdAt, from: from as string, to: to as string };
}

export function isDumpFileName(name: string): boolean {
  return parseDumpFileName(name) !== null;
}

export class DumpStore {
  constructor(readonly directory: string) {}

  async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  /** Absolute path of a dump; throws for a name that is not one of ours (no path traversal). */
  pathOf(name: string): string {
    if (!isDumpFileName(name)) {
      throw new Error("Not a dump file name.");
    }
    return path.join(this.directory, name);
  }

  /** Newest first. */
  async list(): Promise<DumpInfo[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const dumps: DumpInfo[] = [];
    for (const name of names) {
      const parsed = parseDumpFileName(name);
      if (!parsed) {
        continue;
      }
      try {
        const stat = await fs.stat(path.join(this.directory, name));
        if (stat.isFile()) {
          dumps.push({
            file: name,
            bytes: stat.size,
            createdAt: parsed.createdAt.toISOString(),
          });
        }
      } catch {
        // Vanished between readdir and stat.
      }
    }
    return dumps.sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0));
  }

  async sizeOf(name: string): Promise<number | null> {
    try {
      return (await fs.stat(this.pathOf(name))).size;
    } catch {
      return null;
    }
  }

  /**
   * Delete all but the newest `keep` dumps. Names in `protect` (the dump a
   * `needs_attention` run still refers to) are never deleted and do not count
   * towards `keep`. Returns the deleted file names.
   */
  async prune(
    keep: number = KEEP_DUMPS,
    protect: ReadonlySet<string> = new Set(),
  ): Promise<string[]> {
    const removable = (await this.list()).filter((dump) => !protect.has(dump.file));
    const deleted: string[] = [];
    for (const dump of removable.slice(keep)) {
      await fs.rm(this.pathOf(dump.file), { force: true });
      deleted.push(dump.file);
    }
    return deleted;
  }

  /** Remove a dump that was not completed. */
  async discard(name: string): Promise<void> {
    await fs.rm(this.pathOf(name), { force: true });
  }
}
