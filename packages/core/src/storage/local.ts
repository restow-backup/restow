/**
 * Local filesystem storage backend.
 *
 * The default in-container target (a Docker volume) and also how a mounted
 * NFS share is used: give it the mount path as the root. Uses node:fs streams
 * so large packs never need to be fully buffered.
 *
 * Writes are atomic and durable: the bytes go to a temporary file next to the
 * key, which is fsynced, renamed over the key, and the directory is fsynced
 * too. A key therefore holds either its previous content or the complete new
 * content, also after a crash or power loss, and once `put` resolves the
 * object survives one. The chunk writer relies on this: a pack is recorded in
 * the chunk index only after `put` resolved on every target.
 */
import { randomBytes } from "node:crypto";
import { type Dirent, createReadStream } from "node:fs";
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { HeadResult, PutOptions, StorageBackend } from "./backend.js";

/** Suffix of the temporary files a write goes through; never a key, never listed. */
const TEMP_SUFFIX = ".restow-tmp";

/**
 * Errors of fsync on a directory that only mean the filesystem does not
 * support it (some network filesystems); the rename is as durable as that
 * filesystem makes it.
 */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EPERM"]);

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isTempName(name: string): boolean {
  return name.startsWith(".") && name.endsWith(TEMP_SUFFIX);
}

/** Make the entries of a directory (a renamed or created name) durable. */
async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(errorCode(error) ?? "")) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

/** Write every byte of a buffer or stream to an open file. */
async function writeAll(handle: FileHandle, data: Buffer | Readable): Promise<void> {
  if (Buffer.isBuffer(data)) {
    await handle.writeFile(data);
    return;
  }
  for await (const piece of data) {
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array | string);
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
      offset += bytesWritten;
    }
  }
}

export class LocalStorageBackend implements StorageBackend {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Resolve a key to an absolute path, refusing anything that escapes the root. */
  private pathFor(key: string): string {
    const target = resolve(this.root, key);
    const rel = relative(this.root, target);
    if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) {
      throw new Error(`storage key escapes the root: ${key}`);
    }
    if (isTempName(basename(target))) {
      throw new Error(`storage key uses a reserved name: ${key}`);
    }
    return target;
  }

  async put(key: string, data: Buffer | Readable, _options?: PutOptions): Promise<void> {
    // Object-lock/retention (_options.retainUntil) is not enforceable on a plain
    // filesystem; archive WORM guarantees require an object-lock capable target.
    const target = this.pathFor(key);
    const directory = dirname(target);
    const created = await mkdir(directory, { recursive: true });
    const temp = join(
      directory,
      `.${basename(target)}.${randomBytes(8).toString("hex")}${TEMP_SUFFIX}`,
    );
    try {
      const handle = await open(temp, "wx");
      try {
        await writeAll(handle, data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, target);
    } catch (error) {
      if (!Buffer.isBuffer(data)) {
        data.destroy();
      }
      await rm(temp, { force: true });
      throw error;
    }
    await syncDirectory(directory);
    // Directories this write created must be durable in their parents as well.
    if (created !== undefined) {
      let current = directory;
      while (current !== created && dirname(current) !== current) {
        current = dirname(current);
        await syncDirectory(current);
      }
      await syncDirectory(dirname(created));
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async getStream(key: string): Promise<Readable> {
    return createReadStream(this.pathFor(key));
  }

  async getRange(key: string, start: number, end: number): Promise<Readable> {
    return createReadStream(this.pathFor(key), { start, end });
  }

  async listWithSizes(prefix: string): Promise<{ key: string; size: number }[]> {
    const entries: { key: string; size: number }[] = [];
    await this.walkSizes(this.root, prefix, entries);
    return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  private async walkSizes(
    dir: string,
    prefix: string,
    out: { key: string; size: number }[],
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const key = relative(this.root, full).split(sep).join("/");
      if (entry.isDirectory()) {
        // Only descend where the prefix can still match.
        if (prefix.startsWith(`${key}/`) || key.startsWith(prefix)) {
          await this.walkSizes(full, prefix, out);
        }
      } else if (entry.isFile() && !isTempName(entry.name) && key.startsWith(prefix)) {
        try {
          out.push({ key, size: (await stat(full)).size });
        } catch (error) {
          if (!isNotFound(error)) {
            throw error;
          }
        }
      }
    }
  }

  async head(key: string): Promise<HeadResult | null> {
    try {
      const info = await stat(this.pathFor(key));
      return { size: info.size, lastModified: info.mtime };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    await this.walk(this.root, keys);
    return keys.filter((key) => key.startsWith(prefix)).sort();
  }

  private async walk(dir: string, out: string[]): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(full, out);
      } else if (entry.isFile() && !isTempName(entry.name)) {
        // A temporary file is a write in flight, or one a crash interrupted.
        out.push(relative(this.root, full).split(sep).join("/"));
      }
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.pathFor(key));
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
  }
}
