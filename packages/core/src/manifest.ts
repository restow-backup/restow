/**
 * Snapshot manifests.
 *
 * A manifest is the source of truth for a single snapshot: the object list with
 * paths, sizes, timestamps, metadata and the ordered stored-chunk ids that make
 * up each object. The manifest in storage is what a standalone restore reads, so
 * it is self-contained (see docs/ARCHITECTURE.md).
 *
 * Serialized form: a 1-byte codec tag followed by the payload.
 *   codec 0x02 -> NDJSON lines, uncompressed         (format 2, written)
 *   codec 0x03 -> NDJSON lines, zstd-compressed      (format 2, written)
 *   codec 0x00 -> one UTF-8 JSON document, raw       (format 1, read only)
 *   codec 0x01 -> one UTF-8 JSON document, zstd      (format 1, read only)
 *
 * Format 2 is UTF-8 text with one JSON value per line, each line ending in LF.
 * The first line is the header: every manifest field except `objects`, plus
 * `objectCount`. Every following line is one {@link ManifestObject}, in
 * manifest order. A reader must find exactly `objectCount` object lines, so a
 * truncated manifest is reported instead of being read as a smaller snapshot.
 *
 * Format 1 held the whole manifest as one JSON document, which has to exist as
 * one JavaScript string while it is written or read. V8 caps a string at about
 * 2^29 characters, so a mailbox of roughly half a million objects could never
 * be checkpointed or committed. Format 2 is written and read line by line, so
 * no string ever holds more than one line; with zstd the text is also streamed
 * through the compressor and decompressor, so not even a buffer holds the
 * whole uncompressed manifest. Format 1 manifests stay readable.
 *
 * zstd (node:zlib) is used when the runtime provides it; serialization falls
 * back to the uncompressed codec otherwise, and detection never throws.
 */
import { Readable, type Transform, pipeline } from "node:stream";
import { pipeline as pipelineAsync } from "node:stream/promises";
import * as zlib from "node:zlib";

/**
 * Manifest format version, recorded in every manifest. 2 is the line-oriented
 * (NDJSON) form described above; 1 was one JSON document.
 */
export const MANIFEST_VERSION = 2;

/** Codec tags, the first byte of a serialized manifest. */
export const MANIFEST_CODEC = {
  /** Format 1: one JSON document, uncompressed (read only). */
  json: 0x00,
  /** Format 1: one JSON document, zstd (read only). */
  jsonZstd: 0x01,
  /** Format 2: NDJSON lines, uncompressed. */
  lines: 0x02,
  /** Format 2: NDJSON lines, zstd. */
  linesZstd: 0x03,
} as const;

/** Lines are handed to zstd (and to the raw writer) in parts of about this size. */
const PART_CHARS = 1 << 20;
/** The compressed payload is fed to the decompressor in slices of this size. */
const SLICE_BYTES = 1 << 20;
const LINE_FEED = 0x0a;

/** Where a snapshot's data came from. */
export interface ManifestSource {
  readonly type: "m365" | "imap" | "infrastructure";
  /** Stable id of the protected object (mailbox, drive, IMAP account, host path). */
  readonly id: string;
  /** What the protected object is (mailbox, onedrive, imap), when known. */
  readonly kind?: string;
  /** Restow's own protected_objects.id, when the snapshot was produced by a job. */
  readonly protectedObjectId?: string;
}

/** One object captured in a snapshot. */
export interface ManifestObject {
  /** Logical path of the object within its source. */
  path: string;
  /** Size in bytes of the reconstructed object. */
  size: number;
  /** Last-modified time as epoch milliseconds. */
  mtime: number;
  /**
   * Stable source item id (Graph message/driveItem id, IMAP UID with validity),
   * used for delta carry-over and for id-based restore selection.
   */
  id?: string;
  /** Object type within its source: "message", "event", "contact", "file", "folder", ... */
  type?: string;
  /** SHA-256 (hex) of the reconstructed bytes, for restore and verify hash checks. */
  sha256?: string;
  /** Free-form string metadata (etag, content type, version id, ...). */
  metadata?: Record<string, string>;
  /** Ordered list of stored chunk ids (hex) that reconstruct the object. */
  chunks: string[];
}

/** A complete snapshot manifest. */
export interface SnapshotManifest {
  version: number;
  tenantId: string;
  snapshotId: string;
  /** Snapshot creation time as epoch milliseconds. */
  createdAt: number;
  source: ManifestSource;
  /** Monotonic sequence within the protected object (mirrors snapshots.sequence). */
  sequence?: number;
  /**
   * Storage keys of every pack referenced by this snapshot. A standalone restore
   * can limit its pack scan to these instead of reading every pack of the tenant.
   */
  packs?: string[];
  /**
   * Engine-specific incremental state that produced this snapshot (per-folder
   * delta links, IMAP UIDVALIDITY/UIDNEXT, ...). The next run continues from
   * here; an engine treats invalid state (410 Gone) as "start over".
   */
  state?: Record<string, unknown>;
  objects: ManifestObject[];
}

interface ZstdCodec {
  decompressSync(input: Buffer): Buffer;
  createCompress(): Transform;
  createDecompress(): Transform;
}

/**
 * Resolve node:zlib's zstd helpers if this runtime has them (Node >= 22.15 /
 * >= 23.8). Returns null when unavailable. Never throws.
 */
function resolveZstd(): ZstdCodec | null {
  try {
    const mod = zlib as unknown as {
      zstdDecompressSync?: (input: Buffer) => Buffer;
      createZstdCompress?: () => Transform;
      createZstdDecompress?: () => Transform;
    };
    const { zstdDecompressSync, createZstdCompress, createZstdDecompress } = mod;
    if (
      typeof zstdDecompressSync === "function" &&
      typeof createZstdCompress === "function" &&
      typeof createZstdDecompress === "function"
    ) {
      return {
        decompressSync: (input) => zstdDecompressSync(input),
        createCompress: () => createZstdCompress(),
        createDecompress: () => createZstdDecompress(),
      };
    }
  } catch {
    // fall through
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The manifest as format-2 text, in parts of about {@link PART_CHARS}: the
 * header line first, then one line per object. Only one object is ever
 * stringified at a time.
 */
function* manifestLines(manifest: SnapshotManifest): Generator<Buffer> {
  const { objects, ...fields } = manifest;
  let batch: string[] = [JSON.stringify({ ...fields, objectCount: objects.length })];
  let size = batch[0]?.length ?? 0;
  for (const object of objects) {
    const line = JSON.stringify(object);
    batch.push(line);
    size += line.length + 1;
    if (size >= PART_CHARS) {
      yield Buffer.from(`${batch.join("\n")}\n`, "utf8");
      batch = [];
      size = 0;
    }
  }
  if (batch.length > 0) {
    yield Buffer.from(`${batch.join("\n")}\n`, "utf8");
  }
}

async function compressParts(parts: Iterable<Buffer>, zstd: ZstdCodec): Promise<Buffer> {
  const out: Buffer[] = [];
  await pipelineAsync(Readable.from(parts), zstd.createCompress(), async (compressed) => {
    for await (const chunk of compressed as AsyncIterable<Buffer>) {
      out.push(chunk);
    }
  });
  return Buffer.concat(out);
}

/**
 * Serialize a manifest to bytes (format 2), compressing with zstd when the
 * runtime has it. The payload is produced and compressed part by part, so the
 * size of the manifest is bounded by memory, not by the maximum string length.
 */
export async function serializeManifest(manifest: SnapshotManifest): Promise<Buffer> {
  const zstd = resolveZstd();
  if (zstd) {
    try {
      const compressed = await compressParts(manifestLines(manifest), zstd);
      return Buffer.concat([Buffer.from([MANIFEST_CODEC.linesZstd]), compressed]);
    } catch {
      // Compression is best-effort; fall back to raw so serialization never fails.
    }
  }
  return Buffer.concat([Buffer.from([MANIFEST_CODEC.lines]), ...manifestLines(manifest)]);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Split a byte stream into LF-terminated lines (without the LF); a line may span chunks. */
async function* splitLines(
  chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  for await (const chunk of chunks) {
    let start = 0;
    let end = chunk.indexOf(LINE_FEED, start);
    while (end !== -1) {
      const piece = chunk.subarray(start, end);
      if (pending.length === 0) {
        yield piece;
      } else {
        pending.push(piece);
        yield Buffer.concat(pending);
        pending = [];
      }
      start = end + 1;
      end = chunk.indexOf(LINE_FEED, start);
    }
    if (start < chunk.length) {
      pending.push(chunk.subarray(start));
    }
  }
  if (pending.length > 0) {
    yield Buffer.concat(pending);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line: Buffer, what: string): unknown {
  try {
    return JSON.parse(line.toString("utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`manifest ${what} is not valid JSON: ${reason}`);
  }
}

/**
 * Whether `line` is a format-2 manifest header: a JSON object with an
 * `objectCount` and without an `objects` list. Never throws.
 */
export function isManifestHeaderLine(line: Buffer): boolean {
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    return (
      isPlainObject(value) &&
      Number.isSafeInteger(value.objectCount) &&
      (value.objectCount as number) >= 0 &&
      !("objects" in value)
    );
  } catch {
    return false;
  }
}

/**
 * Read format-2 manifest text (header line, then one object per line) from
 * uncompressed chunks. Each line is decoded on its own; the object count must
 * match the header.
 */
export async function readManifestLines(
  chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
): Promise<SnapshotManifest> {
  let header: Record<string, unknown> | null = null;
  let expected = 0;
  const objects: ManifestObject[] = [];
  for await (const line of splitLines(chunks)) {
    if (line.length === 0) {
      continue;
    }
    if (header === null) {
      const value = parseLine(line, "header");
      if (
        !isPlainObject(value) ||
        !Number.isSafeInteger(value.objectCount) ||
        (value.objectCount as number) < 0
      ) {
        throw new Error("manifest header is malformed (objectCount is missing)");
      }
      const { objectCount, objects: _ignored, ...fields } = value;
      header = fields;
      expected = objectCount as number;
      continue;
    }
    const object = parseLine(line, `object ${objects.length + 1}`);
    if (!isPlainObject(object)) {
      throw new Error(`manifest object ${objects.length + 1} is not an object`);
    }
    objects.push(object as unknown as ManifestObject);
  }
  if (header === null) {
    throw new Error("manifest is empty (no header line)");
  }
  if (objects.length !== expected) {
    throw new Error(
      `manifest is truncated or damaged: the header announces ${expected} objects, ${objects.length} were found`,
    );
  }
  return { ...(header as Omit<SnapshotManifest, "objects">), objects };
}

/** The payload in slices, so the decompressor is fed without one huge write. */
function* slices(body: Buffer): Generator<Buffer> {
  for (let offset = 0; offset < body.length; offset += SLICE_BYTES) {
    yield body.subarray(offset, Math.min(body.length, offset + SLICE_BYTES));
  }
}

/** Decompress a zstd payload as a stream of chunks (never one buffer of the whole text). */
function zstdChunks(body: Buffer, zstd: ZstdCodec): AsyncIterable<Buffer> {
  // The callback form returns the last stream; an error in any stage destroys
  // it, which surfaces in the reader's for-await, and a reader that stops
  // early destroys the source with it.
  return pipeline(Readable.from(slices(body)), zstd.createDecompress(), () => {});
}

function requireZstd(): ZstdCodec {
  const zstd = resolveZstd();
  if (!zstd) {
    throw new Error("manifest is zstd-compressed but this runtime has no zstd support");
  }
  return zstd;
}

/** Deserialize a manifest produced by {@link serializeManifest} (format 2) or by format 1. */
export async function deserializeManifest(buf: Buffer): Promise<SnapshotManifest> {
  if (buf.length < 1) {
    throw new Error("manifest buffer is empty");
  }
  const codec = buf[0] as number;
  const body = buf.subarray(1);

  switch (codec) {
    case MANIFEST_CODEC.lines:
      return readManifestLines([body]);
    case MANIFEST_CODEC.linesZstd:
      return readManifestLines(zstdChunks(body, requireZstd()));
    case MANIFEST_CODEC.json:
      // Format 1 was written from one string, so it fits into one again.
      return JSON.parse(body.toString("utf8")) as SnapshotManifest;
    case MANIFEST_CODEC.jsonZstd:
      return JSON.parse(requireZstd().decompressSync(body).toString("utf8")) as SnapshotManifest;
    default:
      throw new Error(`unknown manifest codec 0x${codec.toString(16)}`);
  }
}
