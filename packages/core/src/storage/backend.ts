/**
 * Storage backend abstraction.
 *
 * Chunk packs, manifests and wrapped keys are addressed by string keys (e.g.
 * `tenants/<id>/packs/ab/<packid>`). Every backend (local filesystem, S3, a
 * mounted network share) implements the same interface so the rest of Restow is
 * agnostic to the target. See docs/ARCHITECTURE.md and docs/STACK.md.
 */
import { Readable } from "node:stream";

/** Options for a write. `retainUntil` requests WORM/object-lock retention where supported. */
export interface PutOptions {
  contentType?: string;
  /** Retain-until date for object lock (archive/WORM targets). */
  retainUntil?: Date;
}

/** Result of a {@link StorageBackend.head} probe. */
export interface HeadResult {
  size: number;
  etag?: string;
  lastModified?: Date;
}

/** A pluggable object store. Keys use `/` separators and never start with `/`. */
export interface StorageBackend {
  /** Write bytes (or a stream) at `key`, creating intermediate structure as needed. */
  put(key: string, data: Buffer | Readable, options?: PutOptions): Promise<void>;
  /** Read the whole object at `key` into a buffer. Rejects if it does not exist. */
  get(key: string): Promise<Buffer>;
  /** Open a readable stream for `key`. Rejects if it does not exist. */
  getStream(key: string): Promise<Readable>;
  /** Metadata for `key`, or `null` if it does not exist. */
  head(key: string): Promise<HeadResult | null>;
  /** List keys under `prefix` (recursive), sorted ascending. */
  list(prefix: string): Promise<string[]>;
  /** Delete `key`. Succeeds even if the key does not exist. */
  delete(key: string): Promise<void>;
  /**
   * Optional: open a stream over the inclusive byte range `[start, end]` of
   * `key` (`end` is clamped to the object's last byte). Backends that can serve
   * a range without reading the whole object implement it (local files, S3);
   * {@link readRange} falls back to skipping through `getStream` for the rest.
   */
  getRange?(key: string, start: number, end: number): Promise<Readable>;
  /**
   * Optional: `list` with the size of every object, in one pass where the
   * backend can (S3 returns sizes with its listing, a filesystem stats while it
   * walks). {@link listWithSizes} falls back to `list` plus `head`.
   */
  listWithSizes?(prefix: string): Promise<{ key: string; size: number }[]>;
}

/**
 * Whether a backend's error says that the object does not exist: S3's
 * NoSuchKey / NotFound (HTTP 404) or a missing file (ENOENT). Anything else, a
 * network error, a timeout, a 5xx, throttling, denied access or a missing
 * bucket, means the backend could not answer, which says nothing about the
 * object.
 */
export function isObjectNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const shape = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  // A missing bucket is a 404 as well, but it is the target that is gone or misconfigured.
  if (shape.name === "NoSuchBucket" || shape.Code === "NoSuchBucket") {
    return false;
  }
  return (
    shape.name === "NoSuchKey" ||
    shape.Code === "NoSuchKey" ||
    shape.name === "NotFound" ||
    shape.$metadata?.httpStatusCode === 404 ||
    shape.code === "ENOENT"
  );
}

/** Read the inclusive byte range `[start, end]` of `key`, from the backend's `getRange` when it has one. */
export async function readRange(
  backend: StorageBackend,
  key: string,
  start: number,
  end: number,
): Promise<Readable> {
  if (backend.getRange) {
    return backend.getRange(key, start, end);
  }
  const source = await backend.getStream(key);
  let position = 0;
  const wanted = end - start + 1;
  let delivered = 0;
  async function* slice(): AsyncGenerator<Buffer> {
    for await (const piece of source) {
      const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
      const from = Math.max(0, start - position);
      position += chunk.length;
      if (from >= chunk.length) {
        continue;
      }
      const part = chunk.subarray(from, from + (wanted - delivered));
      delivered += part.length;
      yield part;
      if (delivered >= wanted) {
        source.destroy();
        return;
      }
    }
  }
  return Readable.from(slice());
}

/** List `prefix` with object sizes: the backend's `listWithSizes`, else `list` plus a `head` per key. */
export async function listWithSizes(
  backend: StorageBackend,
  prefix: string,
  concurrency = 16,
): Promise<{ key: string; size: number }[]> {
  if (backend.listWithSizes) {
    return backend.listWithSizes(prefix);
  }
  const keys = await backend.list(prefix);
  const result: { key: string; size: number }[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
    while (next < keys.length) {
      const key = keys[next++] as string;
      const head = await backend.head(key);
      if (head) {
        result.push({ key, size: head.size });
      }
    }
  });
  await Promise.all(workers);
  return result.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
