import { basename } from "node:path/posix";
import { Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { compareDirectoryEntries } from "../endpoints/restic-cli.js";
import { safeEntryName, UniqueNames } from "../endpoints/zip.js";
import { type FsEntry, GuestFsError } from "./guestfs/source.js";

/**
 * The ZIP of files and folders of a VM restore point (docs/PVE.md, "Files of a VM"), read
 * through the sandboxed guest file system reader. Files the reader cannot read (an
 * NTFS-compressed or damaged file) do not break the download: they are named, with the reason,
 * in `_not-restored.txt` at its end, and so are symbolic links (never followed). Names are made
 * safe for every extractor (`safeEntryName`), unique within the archive, and a folder walk ends
 * at fixed limits of depth and entries. Nothing is held in memory beyond one piece of a file.
 */

/** What the ZIP needs of the reader (GuestFsSandbox, or GuestFiles in tests). */
export interface GuestFileReader {
  list(path: string): Promise<FsEntry[]>;
  stat(path: string): Promise<FsEntry | null>;
  open(path: string): Promise<{ size: number }>;
  read(path: string, offset: number, length: number): Promise<Buffer>;
  /** True once the reader ended: nothing more comes, the ZIP must break. */
  readonly failed: boolean;
}

/** The name of the list of what a ZIP could not hold. */
export const NOT_RESTORED_NAME = "_not-restored.txt";
const PIECE = 1024 * 1024;
export const MAX_GUEST_ZIP_ENTRIES = 200_000;
const MAX_ZIP_DEPTH = 64;

export function streamGuestZip(options: {
  reader: GuestFileReader;
  selection: readonly { path: string; type: "file" | "dir" }[];
  comment?: string;
  signal?: AbortSignal;
  /** Called once when the archive ended, whichever way. */
  onEnd?: () => void;
}): Readable {
  const sandbox = options.reader;
  const archive = new ZipArchive({ zlib: { level: 1 }, comment: options.comment });
  const names = new UniqueNames();
  const missing: string[] = [];
  let entries = 0;
  const added = () =>
    new Promise<void>((resolve, reject) => {
      const onEntry = () => {
        archive.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        archive.off("entry", onEntry);
        reject(error);
      };
      archive.once("entry", onEntry);
      archive.once("error", onError);
    });
  const addFile = async (path: string, name: string, entry: FsEntry) => {
    let body: Readable;
    try {
      const { size } = await sandbox.open(path);
      // The first piece is read before the entry starts: a file the reader cannot read never
      // becomes a broken entry, it goes to the list of what was not restored.
      const first = size > 0 ? await sandbox.read(path, 0, Math.min(PIECE, size)) : Buffer.alloc(0);
      body = Readable.from(
        (async function* () {
          yield first;
          for (let at = PIECE; at < size; at += PIECE) {
            yield await sandbox.read(path, at, Math.min(PIECE, size - at));
          }
        })(),
      );
    } catch (error) {
      if (sandbox.failed) {
        throw error;
      }
      if (error instanceof GuestFsError && error.code === "unsupported") {
        missing.push(`${path}\t${error.message}`);
        return;
      }
      if (
        error instanceof GuestFsError &&
        (error.code === "damaged" || error.code === "not_a_file")
      ) {
        missing.push(`${path}\t${error.message}`);
        return;
      }
      throw error;
    }
    const done = added();
    archive.append(body, {
      name: names.claim(name || "file"),
      date: entry.mtime ? new Date(entry.mtime) : undefined,
    });
    await done;
  };
  const walk = async (path: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_ZIP_DEPTH) {
      missing.push(`${path}\ttoo deep`);
      return;
    }
    let list: FsEntry[];
    try {
      list = await sandbox.list(path);
    } catch (error) {
      if (sandbox.failed) throw error;
      missing.push(`${path}\t${error instanceof Error ? error.message : "not readable"}`);
      return;
    }
    if (prefix) {
      const done = added();
      archive.append(Buffer.alloc(0), { name: safeEntryName(prefix, true) });
      await done;
    }
    for (const entry of list.sort(compareDirectoryEntries)) {
      if (++entries > MAX_GUEST_ZIP_ENTRIES) {
        throw new GuestFsError("limit", "the selection holds too many files");
      }
      const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === "dir") {
        await walk(child, name, depth + 1);
      } else if (entry.type === "file") {
        await addFile(child, safeEntryName(name), entry);
      } else {
        missing.push(
          `${child}\t${entry.type === "symlink" ? "a symbolic link, not followed" : "not a regular file"}`,
        );
      }
    }
  };
  const pump = async () => {
    for (const item of options.selection) {
      if (item.type === "file") {
        const entry = (await sandbox.stat(item.path)) ?? {
          name: basename(item.path),
          type: "file" as const,
          size: null,
          mtime: null,
        };
        await addFile(item.path, safeEntryName(basename(item.path)), entry);
      } else {
        const base = item.path === "/" ? "" : safeEntryName(basename(item.path));
        await walk(item.path, base, 0);
      }
    }
    if (missing.length > 0) {
      const done = added();
      archive.append(Buffer.from(`${missing.join("\n")}\n`, "utf8"), {
        name: names.claim(NOT_RESTORED_NAME),
      });
      await done;
    }
    await archive.finalize();
  };
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    options.onEnd?.();
  };
  archive.once("close", finish);
  archive.once("end", finish);
  archive.once("error", finish);
  options.signal?.addEventListener("abort", () => archive.destroy(new Error("aborted")), {
    once: true,
  });
  pump().catch((error: unknown) => {
    archive.destroy(error instanceof Error ? error : new Error(String(error)));
    finish();
  });
  return archive;
}
