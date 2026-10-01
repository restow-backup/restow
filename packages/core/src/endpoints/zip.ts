/**
 * Download of snapshot files as a ZIP, streamed from `restic dump`
 * (docs/AGENT.md).
 *
 * A selected file is dumped and added under its own name; a selected folder is
 * dumped as a tar archive, which is read on the fly and re-packed entry by
 * entry, so the ZIP shows the folder the way the user chose it (`docs/a.txt`,
 * not `home/anna/docs/a.txt`). Nothing is written to disk and nothing is held
 * in memory beyond one block: restic's output flows through the tar reader and
 * the ZIP writer into the HTTP response, and a slow client slows restic down.
 *
 * An error while streaming (restic fails, the client leaves) destroys the
 * stream, so the client sees a broken download, never a ZIP that looks whole
 * and is not. Symbolic links and special files carry no content and are left out.
 */
import { basename } from "node:path/posix";
import type { Readable } from "node:stream";
import archiver from "archiver";
import {
  type ResticSession,
  normaliseSnapshotPath,
  resticDump,
  resticStatMany,
} from "./restic-cli.js";
import { readTar } from "./tar.js";

export interface SnapshotZipOptions {
  session: ResticSession;
  snapshotId: string;
  /** Files and folders inside the snapshot (absolute, `/`-separated). */
  paths: readonly string[];
  signal?: AbortSignal;
  /** ZIP comment (snapshot id, endpoint). */
  comment?: string;
}

export interface SnapshotZip {
  readonly stream: Readable;
  /** A file name for the download. */
  readonly fileName: string;
}

/**
 * Characters a Windows extractor reads as a path (`\` as a separator, `:` for a
 * drive or an NTFS stream) or that no file system takes (control characters).
 * A Linux or macOS file name may contain them; in the ZIP they become `_`.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is replaced
const UNSAFE_NAME_CHARACTERS = /[\\:\u0000-\u001f\u007f]/g;

/**
 * Path segments without empty, `.`, `..` and other dots-only parts, and without
 * a character a Windows extractor treats as a path separator or drive: nothing
 * can climb out of the archive, whichever tool unpacks it (`..\..\x` is one
 * file name `.._.._x`, not a way up two folders).
 */
export function safeEntryName(name: string, directory = false): string {
  const parts = name
    .split("/")
    .map((part) => part.replace(UNSAFE_NAME_CHARACTERS, "_"))
    .filter((part) => part !== "" && !/^\.+$/.test(part));
  const joined = parts.join("/");
  return directory && joined ? `${joined}/` : joined;
}

/** Names that stay unique within one archive: `x.txt`, `x (2).txt`, ... */
export class UniqueNames {
  private readonly used = new Set<string>();

  claim(name: string): string {
    if (!this.used.has(name)) {
      this.used.add(name);
      return name;
    }
    const dot = name.lastIndexOf(".");
    const slash = name.lastIndexOf("/");
    const stem = dot > slash + 1 ? name.slice(0, dot) : name;
    const extension = dot > slash + 1 ? name.slice(dot) : "";
    for (let counter = 2; ; counter++) {
      const candidate = `${stem} (${counter})${extension}`;
      if (!this.used.has(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
  }
}

/** The part of a tar entry name that `requested` (a folder) adds in front of its own name. */
export function parentPrefix(requested: string): string {
  const parts = normaliseSnapshotPath(requested).split("/").filter(Boolean);
  return parts.length <= 1 ? "" : `${parts.slice(0, -1).join("/")}/`;
}

function nextEntry(archive: archiver.Archiver): Promise<void> {
  return new Promise((resolve, reject) => {
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
}

/**
 * Check that every path exists in the snapshot before any bytes are sent, so a
 * bad request is a clean 404 and not a truncated download. The paths are
 * normalised and listed once each, in the order they were asked for; one
 * `restic ls` covers up to a few hundred of them (`resticStatMany`).
 */
export async function resolveSelection(
  session: ResticSession,
  snapshotId: string,
  paths: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<{ path: string; type: "file" | "dir" }[]> {
  const requested = [...new Set(paths.map(normaliseSnapshotPath))];
  const nodes = await resticStatMany(
    session,
    snapshotId,
    requested.filter((path) => path !== "/"),
    options,
  );
  return requested.map((path) => {
    if (path === "/") {
      return { path, type: "dir" as const };
    }
    const node = nodes.get(path);
    if (!node || (node.type !== "file" && node.type !== "dir")) {
      throw new SelectionError(path);
    }
    return { path, type: node.type };
  });
}

/** A requested path is not a file or folder of the snapshot. */
export class SelectionError extends Error {
  constructor(readonly path: string) {
    super("the path is not a file or folder of the snapshot");
    this.name = "SelectionError";
  }
}

/** Build the ZIP of `selection` (from {@link resolveSelection}) as a stream. */
export function streamSnapshotZip(
  options: SnapshotZipOptions & { selection: { path: string; type: "file" | "dir" }[] },
): SnapshotZip {
  const { session, snapshotId, selection, signal } = options;
  const archive = archiver("zip", { zlib: { level: 1 }, comment: options.comment });
  const names = new UniqueNames();

  const pump = async (): Promise<void> => {
    for (const item of selection) {
      if (item.type === "file") {
        const dump = resticDump(session, snapshotId, item.path, { signal });
        const name = names.claim(safeEntryName(basename(item.path)) || "file");
        const added = nextEntry(archive);
        archive.append(dump.stream, { name });
        await added;
        await dump.done;
        continue;
      }
      const dump = resticDump(session, snapshotId, item.path, { archive: "tar", signal });
      const prefix = parentPrefix(item.path);
      for await (const entry of readTar(dump.stream)) {
        const relative = entry.name.startsWith(prefix)
          ? entry.name.slice(prefix.length)
          : entry.name;
        if (entry.type === "directory") {
          const name = safeEntryName(relative, true);
          if (name) {
            const added = nextEntry(archive);
            archive.append(Buffer.alloc(0), { name, date: entry.mtime ?? undefined });
            await added;
          }
        } else if (entry.type === "file") {
          const name = names.claim(safeEntryName(relative) || "file");
          const added = nextEntry(archive);
          archive.append(entry.body, {
            name,
            date: entry.mtime ?? undefined,
            mode: entry.mode || undefined,
          });
          await added;
        }
      }
      await dump.done;
    }
    await archive.finalize();
  };

  pump().catch((error: unknown) => {
    archive.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  signal?.addEventListener("abort", () => archive.destroy(new Error("aborted")), { once: true });

  const only = selection.length === 1 ? selection[0] : undefined;
  const base =
    only && only.path !== "/" ? basename(only.path) : `snapshot-${snapshotId.slice(0, 8)}`;
  return { stream: archive, fileName: `${base}.zip` };
}
