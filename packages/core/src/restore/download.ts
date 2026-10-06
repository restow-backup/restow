/**
 * Download restore: a ZIP of the selected objects, streamed straight from the
 * chunk store into the storage target (or an HTTP response) without a
 * temporary file (docs/ARCHITECTURE.md, download restore).
 *
 * Messages become `.eml` files, events and contacts `.json`, files keep their
 * name, attachments their real file name, a historical file version gets its
 * version in the name; every entry sits at its logical path so the folder
 * structure of the source is visible in the archive. Entry names are made
 * portable (no characters Windows refuses, no `..`) and unique. `MANIFEST.csv`
 * at the end lists every selected object with the SHA-256 computed while it
 * was written, so a recipient can verify the archive with standard tools.
 *
 * Entries are added one at a time and each one is fully consumed before the
 * next is opened, which keeps memory bounded by one object's largest chunk.
 * An object whose chunks are missing from the index is listed as missing
 * instead of aborting the whole archive; an integrity failure while streaming
 * (a chunk that fails authentication, a hash mismatch) does abort it, because
 * a silently corrupt file would be worse than no archive at all.
 */
import { createHash } from "node:crypto";
import { PassThrough, type Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipArchive } from "archiver";
import { type ChunkReader, JobAbortedError } from "../engine/chunkstore.js";
import { downloadKey } from "../engine/layout.js";
import type { JobContext, RestoreEngine, RestoreRequest } from "../engine/types.js";
import { FailureError } from "../failures/classify.js";
import type { ManifestObject } from "../manifest.js";
import { chunkReaderFor, restoreRequestOptions } from "./common.js";
import {
  attachmentFactsOf,
  messageFormatOf,
  objectTypeOf,
  pathSegments,
  versionFactsOf,
} from "./conventions.js";
import {
  RestoreLedger,
  type RestoreReport,
  describeRestoreError,
  isAbortError,
} from "./results.js";
import { planRestore, resolveRestoreSource } from "./selection.js";

/** Name of the checksum list at the end of every archive. */
export const ARCHIVE_MANIFEST_NAME = "MANIFEST.csv";

export type ArchiveEntryStatus = "added" | "missing" | "directory" | "not-included";

export interface ArchiveEntry {
  readonly object: ManifestObject;
  /** Entry name inside the ZIP (empty for objects that are not included). */
  readonly name: string;
  readonly status: ArchiveEntryStatus;
  /** SHA-256 (hex) of the bytes written for an added entry. */
  readonly sha256: string | null;
  readonly bytes: number;
  readonly note?: string;
}

export interface ArchiveSummary {
  readonly entries: readonly ArchiveEntry[];
  readonly added: number;
  readonly missing: number;
  readonly bytes: number;
}

export interface CreateRestoreArchiveOptions {
  readonly reader: ChunkReader;
  readonly objects: readonly ManifestObject[];
  readonly signal?: AbortSignal;
  /** Called after each entry (including missing ones) so callers can report progress. */
  readonly onEntry?: (entry: ArchiveEntry) => void;
  /** Deflate level 0–9 (default 6). */
  readonly level?: number;
  /** ZIP comment, e.g. the snapshot and restore job ids. */
  readonly comment?: string;
}

// ---------------------------------------------------------------------------
// Entry names

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
/** Characters Windows refuses in file names. */
const NOT_PORTABLE = /[<>:"|?*]/g;

/** One path segment as a portable file name; empty when nothing usable is left. */
function portableSegment(segment: string): string {
  const cleaned = segment
    .replace(CONTROL_CHARACTERS, "")
    .replace(NOT_PORTABLE, "_")
    .trim()
    .replace(/[. ]+$/, "");
  return cleaned === "." || cleaned === ".." ? "" : cleaned;
}

function portableSegments(path: string): string[] {
  return pathSegments(path.replace(/\\/g, "/"))
    .map(portableSegment)
    .filter((segment) => segment.length > 0);
}

function withExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
}

/** `report.docx` + ` (version 3.0)` -> `report (version 3.0).docx`. */
function insertBeforeExtension(name: string, insert: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}${insert}${name.slice(dot)}` : `${name}${insert}`;
}

/**
 * The entry name of an object inside the archive: its logical path made
 * portable, with a file name that says what the bytes are.
 */
export function archiveEntryName(object: ManifestObject): string {
  const type = objectTypeOf(object);
  const segments = portableSegments(
    type === "version" ? versionFactsOf(object).filePath : object.path,
  );
  if (segments.length === 0) {
    segments.push(portableSegment(object.id ?? "") || "object");
  }
  if (type === "folder") {
    return `${segments.join("/")}/`;
  }
  const last = segments.length - 1;
  const name = segments[last] as string;
  switch (type) {
    case "mail":
      segments[last] = withExtension(name, messageFormatOf(object) === "json" ? ".json" : ".eml");
      break;
    case "event":
    case "contact":
      segments[last] = withExtension(name, ".json");
      break;
    case "attachment": {
      const facts = attachmentFactsOf(object);
      const fileName = portableSegment(facts.name) || name;
      segments[last] =
        facts.kind === "reference"
          ? withExtension(fileName, ".json")
          : facts.kind === "item" && !/\.[A-Za-z0-9]{1,8}$/.test(fileName)
            ? `${fileName}.eml`
            : fileName;
      break;
    }
    case "version": {
      const versionId = portableSegment(versionFactsOf(object).versionId);
      segments[last] = insertBeforeExtension(
        name,
        versionId ? ` (version ${versionId})` : " (version)",
      );
      break;
    }
    default:
      break;
  }
  return segments.join("/");
}

/** Hands out entry names that are unique in the archive, case-insensitively. */
export class EntryNamer {
  private readonly used = new Set<string>();

  unique(name: string): string {
    const isDirectory = name.endsWith("/");
    const base = isDirectory ? name.slice(0, -1) : name;
    let candidate = name;
    for (let counter = 2; this.used.has(candidate.toLowerCase()); counter++) {
      const slash = base.lastIndexOf("/");
      const dir = base.slice(0, slash + 1);
      const leaf = base.slice(slash + 1);
      const suffixed = isDirectory
        ? `${leaf} (${counter})`
        : insertBeforeExtension(leaf, ` (${counter})`);
      candidate = `${dir}${suffixed}${isDirectory ? "/" : ""}`;
    }
    this.used.add(candidate.toLowerCase());
    return candidate;
  }
}

// ---------------------------------------------------------------------------
// MANIFEST.csv

/** RFC 4180 quoting for one CSV field. */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const ARCHIVE_MANIFEST_COLUMNS = [
  "entry",
  "source_path",
  "type",
  "status",
  "size",
  "sha256",
  "mtime",
  "id",
  "note",
] as const;

/** The `MANIFEST.csv` content for a list of entries (in the order given). */
export function renderManifestCsv(entries: readonly ArchiveEntry[]): string {
  const lines = [ARCHIVE_MANIFEST_COLUMNS.join(",")];
  for (const entry of entries) {
    const object = entry.object;
    lines.push(
      [
        csvField(entry.name),
        csvField(object.path),
        csvField(object.type ?? "file"),
        csvField(entry.status),
        csvField(entry.status === "added" ? entry.bytes : 0),
        csvField(entry.sha256),
        csvField(object.mtime > 0 ? new Date(object.mtime).toISOString() : ""),
        csvField(object.id),
        csvField(entry.note),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Archive

/** A pass-through that computes SHA-256 of everything it forwards. */
function hashingPassThrough(): Transform & { digestHex(): string } {
  const hash = createHash("sha256");
  const stream = new PassThrough({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  }) as PassThrough & { digestHex(): string };
  let cached: string | null = null;
  stream.digestHex = () => {
    cached ??= hash.digest("hex");
    return cached;
  };
  return stream;
}

function entryDate(object: ManifestObject): Date {
  // ZIP (DOS) dates start in 1980; older or unknown times are clamped there.
  return new Date(Math.max(object.mtime, Date.UTC(1980, 0, 1, 12)));
}

/** Formats that are compressed already; deflating them again only costs CPU. */
const STORED_EXTENSIONS = new Set([
  "7z",
  "avi",
  "bz2",
  "docx",
  "gif",
  "gz",
  "heic",
  "jpeg",
  "jpg",
  "m4a",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "odp",
  "ods",
  "odt",
  "png",
  "pptx",
  "rar",
  "webm",
  "webp",
  "xlsx",
  "xz",
  "zip",
  "zst",
]);

function isCompressed(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && STORED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function notIncludedReason(object: ManifestObject): string | null {
  switch (objectTypeOf(object)) {
    case "package":
      return "OneNote notebooks and other packages are recorded without content";
    case "shortcut":
      return "shortcuts to items in other drives are recorded without content";
    default:
      return null;
  }
}

/**
 * Build the archive. `stream` is the ZIP bytes, to be piped wherever they go;
 * `completed` resolves with the summary once the last byte has been produced,
 * or rejects if the archive had to be aborted.
 */
export function createRestoreArchive(options: CreateRestoreArchiveOptions): {
  stream: Readable;
  completed: Promise<ArchiveSummary>;
} {
  const archive = new ZipArchive({
    zlib: { level: options.level ?? 6 },
    ...(options.comment !== undefined ? { comment: options.comment } : {}),
  });
  let finished = false;
  // Rejects when the archive dies for any reason, including its consumer
  // destroying it (a failed upload). A close after normal completion is not
  // awaited by anyone, so it is harmless.
  const failure = new Promise<never>((_, reject) => {
    archive.on("error", reject);
    archive.on("warning", reject);
    archive.on("close", () => {
      if (!finished) {
        reject(new Error("the archive stream was closed before it was complete"));
      }
    });
  });
  failure.catch(() => undefined);

  const completed = (async (): Promise<ArchiveSummary> => {
    const entries: ArchiveEntry[] = [];
    const namer = new EntryNamer();
    let current: Transform | null = null;
    const record = (entry: ArchiveEntry): void => {
      entries.push(entry);
      options.onEntry?.(entry);
    };
    try {
      for (const object of options.objects) {
        if (options.signal?.aborted) {
          throw new JobAbortedError();
        }
        const excluded = notIncludedReason(object);
        if (excluded !== null) {
          record({
            object,
            name: "",
            status: "not-included",
            sha256: null,
            bytes: 0,
            note: excluded,
          });
          continue;
        }
        const name = namer.unique(archiveEntryName(object));
        if (objectTypeOf(object) === "folder") {
          archive.append(Buffer.alloc(0), { name, date: entryDate(object) });
          record({ object, name, status: "directory", sha256: null, bytes: 0 });
          continue;
        }
        const located = await options.reader.locate(object.chunks);
        const missing = object.chunks.filter((id) => !located.has(id));
        if (missing.length > 0) {
          record({
            object,
            name,
            status: "missing",
            sha256: null,
            bytes: 0,
            note: `${missing.length} of ${object.chunks.length} chunks are not in the chunk index`,
          });
          continue;
        }
        const hashed = hashingPassThrough();
        current = hashed;
        const piping = pipeline(options.reader.objectStream(object), hashed);
        archive.append(hashed, { name, date: entryDate(object), store: isCompressed(name) });
        await Promise.race([piping, failure]);
        current = null;
        record({ object, name, status: "added", sha256: hashed.digestHex(), bytes: object.size });
      }
      archive.append(Buffer.from(renderManifestCsv(entries), "utf8"), {
        name: namer.unique(ARCHIVE_MANIFEST_NAME),
        date: new Date(),
      });
      await Promise.race([archive.finalize(), failure]);
      finished = true;
    } catch (error) {
      current?.destroy();
      archive.destroy(error instanceof Error ? error : new Error(describeRestoreError(error)));
      throw error;
    }
    return {
      entries,
      added: entries.filter((entry) => entry.status === "added").length,
      missing: entries.filter((entry) => entry.status === "missing").length,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    };
  })();

  return { stream: archive, completed };
}

/** A storage-key-safe archive file name (the layout only allows `[A-Za-z0-9._-]`). */
export function archiveFileName(now: Date, requested?: string): string {
  const cleaned = (requested ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/-+$/, "");
  const stamp = now.toISOString().replace(/[-:.]/g, "").slice(0, 15).toLowerCase();
  const base = cleaned.length > 0 ? cleaned : `restore-${stamp}`;
  return base.toLowerCase().endsWith(".zip") ? base : `${base}.zip`;
}

export interface DownloadRestoreEngineOptions {
  /** Deflate level 0–9 (default 6). */
  readonly level?: number;
}

/**
 * Produces the archive for a download restore and stores it under
 * `tenants/<tid>/downloads/<restoreJobId>/<file>.zip` on the primary target,
 * from where the API serves it with an expiring link.
 */
export class DownloadRestoreEngine implements RestoreEngine {
  /**
   * The contract wants a kind; this engine serves every kind and is registered
   * as the download engine, not per kind.
   */
  readonly kind = "mailbox" as const;

  constructor(private readonly options: DownloadRestoreEngineOptions = {}) {}

  async run(ctx: JobContext, request: RestoreRequest): Promise<RestoreReport> {
    if (request.target.type !== "download") {
      throw new Error("the download engine only serves download restores");
    }
    const logger = ctx.logger.child({
      component: "restore-download",
      restoreJobId: request.restoreJobId,
      snapshotId: request.snapshotId,
    });
    const ledger = new RestoreLedger(ctx.progress);

    ctx.progress.phase("resolve");
    const { manifest } = await resolveRestoreSource(ctx, request);
    const { objects } = planRestore(manifest, request.selection);
    const expected = objects.filter((object) => objectTypeOf(object) !== "folder");
    ctx.progress.total(expected.length);

    const fileName = archiveFileName(ctx.now(), restoreRequestOptions(request).archiveName);
    const key = downloadKey(ctx.tenantId, request.restoreJobId, fileName);
    logger.info("archive started", { objects: objects.length, key });

    ctx.progress.phase("archive");
    const { stream, completed } = createRestoreArchive({
      reader: chunkReaderFor(ctx),
      objects,
      signal: ctx.signal,
      level: this.options.level,
      comment: `Restow restore ${request.restoreJobId} from snapshot ${request.snapshotId}`,
      onEntry: (entry) => {
        switch (entry.status) {
          case "added":
            // The SHA-256 was checked against the snapshot while streaming.
            ledger.restored(entry.object, {
              targetRef: entry.name,
              bytes: entry.bytes,
              verified: true,
            });
            break;
          case "missing":
            ledger.failed(
              entry.object,
              new FailureError(entry.note ?? "chunks are missing", {
                code: "verify.chunk_missing",
              }),
              "data_missing",
            );
            break;
          case "not-included":
            ledger.skipped(
              entry.object,
              "not_restorable",
              entry.note ?? "no content was backed up",
            );
            break;
          default:
            break;
        }
      },
    });

    // Whichever side fails first, the other must let go as well; only once both
    // have settled can the half-written archive be removed for good.
    const upload = ctx.storage.primary
      .put(key, stream, { contentType: "application/zip" })
      .catch((error: unknown) => {
        stream.destroy();
        throw error;
      });
    const [uploaded, archived] = await Promise.allSettled([upload, completed]);
    const failure =
      archived.status === "rejected"
        ? (archived.reason as unknown)
        : uploaded.status === "rejected"
          ? (uploaded.reason as unknown)
          : null;
    if (failure !== null) {
      if (!isAbortError(failure)) {
        logger.error("archive failed", { error: describeRestoreError(failure) });
      }
      await ctx.storage.primary.delete(key).catch(() => undefined);
      throw failure;
    }

    ledger.setDownloadKey(key);
    ledger.settle(expected);
    await ctx.progress.flush();
    const report = ledger.report();
    logger.info("archive finished", {
      key,
      entries: report.restored,
      missing: report.failures.length,
      bytes: report.bytes,
    });
    return report;
  }
}
