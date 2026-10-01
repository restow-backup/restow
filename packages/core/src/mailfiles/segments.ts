/**
 * Sealed segment store: files kept in the tenant's storage target as a row of
 * independently encrypted segments (AES-256-GCM with the tenant key, the same
 * sealed layout the chunk store uses).
 *
 * Two users share it:
 *
 *   staging   an uploaded file arrives in client-chosen chunks (any order, any
 *             number of retries). Each chunk is one segment, so an upload can
 *             be resumed, and the worker later reads the file back with random
 *             access (ZIP archives need that) without a plaintext copy ever
 *             touching a disk. Deleted right after the import.
 *   export    a ZIP or MBOX produced by an export job is written sequentially
 *             as segments and streamed to the person who downloads it, so the
 *             finished file lies encrypted in the storage target until it
 *             expires.
 *
 * Layout: tenants/<tid>/staging/<id>/<00000000>.seg and
 *         tenants/<tid>/exports/<id>/<00000000>.seg
 *
 * Every segment is bound (GCM additional data) to its tenant, scope, id and
 * index, so a segment cannot be moved to another position or upload and still
 * open. Memory use is bounded by the segment size (8 MiB by default), never by
 * the file size.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { encryptChunk } from "../crypto.js";
import { sealedAad } from "../engine/keyring.js";
import { tenantPrefix } from "../engine/layout.js";
import type { TenantKeyring } from "../engine/types.js";
import type { StorageBackend } from "../storage/backend.js";
import type { MailInputFile } from "./types.js";

export const DEFAULT_SEGMENT_SIZE = 8 * 1024 * 1024;
export const MIN_SEGMENT_SIZE = 64 * 1024;
export const MAX_SEGMENT_SIZE = 32 * 1024 * 1024;

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const AAD_LABEL = "restow/segment/v1";

export type SegmentKind = "staging" | "export";

export interface SegmentScope {
  readonly tenantId: string;
  readonly kind: SegmentKind;
  /** Upload id or export id. */
  readonly id: string;
}

/** The layout of a segmented file: fixed by the writer and remembered by the database row. */
export interface SegmentLayout {
  /** Plaintext bytes of the whole file. */
  readonly size: number;
  /** Plaintext bytes of every segment except the last. */
  readonly segmentSize: number;
}

/** The prefix under which every scope of one kind of a tenant lives (a scope id follows). */
export function segmentRoot(tenantId: string, kind: SegmentKind): string {
  return `${tenantPrefix(tenantId)}${kind === "staging" ? "staging" : "exports"}/`;
}

export function segmentPrefix(scope: SegmentScope): string {
  if (!SAFE_ID.test(scope.id)) {
    throw new Error("segment scope id contains characters that are not allowed in a storage key");
  }
  return `${segmentRoot(scope.tenantId, scope.kind)}${scope.id}/`;
}

export function segmentKey(scope: SegmentScope, index: number): string {
  assertIndex(index);
  return `${segmentPrefix(scope)}${String(index).padStart(8, "0")}.seg`;
}

/** The additional data a segment is sealed with. */
export function segmentAad(scope: SegmentScope, index: number): Buffer {
  return Buffer.from(`${AAD_LABEL}|${scope.tenantId}|${scope.kind}|${scope.id}|${index}`, "utf8");
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 99_999_999) {
    throw new RangeError(`invalid segment index ${index}`);
  }
}

export function segmentCount(layout: SegmentLayout): number {
  return layout.size === 0 ? 0 : Math.ceil(layout.size / layout.segmentSize);
}

/** Clamp a client-proposed segment size into the supported range. */
export function clampSegmentSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_SEGMENT_SIZE;
  }
  return Math.min(MAX_SEGMENT_SIZE, Math.max(MIN_SEGMENT_SIZE, Math.floor(requested)));
}

export interface SegmentStoreOptions {
  readonly storage: StorageBackend;
  readonly keys: Pick<TenantKeyring, "current" | "open">;
}

/** Thrown when a segment is missing, damaged or belongs somewhere else. */
export class SegmentError extends Error {
  constructor(
    message: string,
    readonly index: number,
  ) {
    super(message);
    this.name = "SegmentError";
  }
}

/** Thrown by `writeStream` when the stream is longer than the limit it was given. */
export class SegmentLimitError extends Error {
  constructor(readonly limitBytes: number) {
    super(`the file is larger than the limit of ${limitBytes} bytes`);
    this.name = "SegmentLimitError";
  }
}

export class SegmentStore {
  constructor(private readonly options: SegmentStoreOptions) {}

  /** Seal and store one segment (idempotent: a retry of the same index overwrites it). */
  async put(
    scope: SegmentScope,
    index: number,
    plaintext: Buffer,
  ): Promise<{ size: number; sha256: string }> {
    const sealed = encryptChunk(this.options.keys.current, plaintext, segmentAad(scope, index));
    await this.options.storage.put(segmentKey(scope, index), sealed);
    return { size: plaintext.length, sha256: createHash("sha256").update(plaintext).digest("hex") };
  }

  /** Open one segment; a damaged, missing or misplaced one throws {@link SegmentError}. */
  async get(scope: SegmentScope, index: number): Promise<Buffer> {
    let sealed: Buffer;
    try {
      sealed = await this.options.storage.get(segmentKey(scope, index));
    } catch (error) {
      throw new SegmentError(
        `segment ${index} is missing from the storage target: ${error instanceof Error ? error.message : String(error)}`,
        index,
      );
    }
    try {
      const aad = sealedAad(sealed);
      if (!aad.equals(segmentAad(scope, index))) {
        throw new Error("segment belongs to another position or upload");
      }
      return this.options.keys.open(sealed);
    } catch (error) {
      throw new SegmentError(
        `segment ${index} could not be opened: ${error instanceof Error ? error.message : String(error)}`,
        index,
      );
    }
  }

  /** Which segment indexes exist in storage (a resumed upload asks the database; this is the truth check). */
  async indexes(scope: SegmentScope): Promise<number[]> {
    const prefix = segmentPrefix(scope);
    const keys = await this.options.storage.list(prefix);
    const found: number[] = [];
    for (const key of keys) {
      const match = /\/(\d{8})\.seg$/.exec(key);
      if (match?.[1] !== undefined && key.startsWith(prefix)) {
        found.push(Number.parseInt(match[1], 10));
      }
    }
    return found.sort((a, b) => a - b);
  }

  /**
   * The ids of every scope of one kind that holds at least one segment in storage, whatever the
   * database knows about it: the cleanup compares them with the rows.
   */
  async scopeIds(tenantId: string, kind: SegmentKind): Promise<string[]> {
    const root = segmentRoot(tenantId, kind);
    const ids = new Set<string>();
    for (const key of await this.options.storage.list(root)) {
      if (!key.startsWith(root)) {
        continue;
      }
      const id = key.slice(root.length).split("/")[0];
      if (id !== undefined && SAFE_ID.test(id) && /\/\d{8}\.seg$/.test(key)) {
        ids.add(id);
      }
    }
    return [...ids].sort();
  }

  /** Delete every segment of a scope; returns how many were removed. */
  async delete(scope: SegmentScope): Promise<number> {
    const keys = await this.options.storage.list(segmentPrefix(scope));
    for (const key of keys) {
      await this.options.storage.delete(key);
    }
    return keys.length;
  }

  /**
   * Write a sequential stream as segments. Used by export jobs; returns what
   * the database row needs to read the file back. A stream longer than
   * `maxBytes` stops with a {@link SegmentLimitError} after the segment that
   * crossed the limit (the caller deletes what was written).
   */
  async writeStream(
    scope: SegmentScope,
    source: Readable,
    options: { segmentSize?: number; signal?: AbortSignal; maxBytes?: number } = {},
  ): Promise<SegmentLayout & { segments: number; sha256: string }> {
    const segmentSize = clampSegmentSize(options.segmentSize);
    const hash = createHash("sha256");
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let index = 0;
    let size = 0;

    const flush = async (bytes: Buffer): Promise<void> => {
      await this.put(scope, index, bytes);
      index++;
    };

    for await (const part of source) {
      if (options.signal?.aborted) {
        source.destroy();
        throw new Error("the export was cancelled");
      }
      const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
      size += buffer.length;
      if (options.maxBytes !== undefined && size > options.maxBytes) {
        source.destroy();
        throw new SegmentLimitError(options.maxBytes);
      }
      hash.update(buffer);
      pending.push(buffer);
      pendingBytes += buffer.length;
      while (pendingBytes >= segmentSize) {
        const joined = Buffer.concat(pending, pendingBytes);
        await flush(joined.subarray(0, segmentSize));
        const rest = joined.subarray(segmentSize);
        pending = rest.length > 0 ? [rest] : [];
        pendingBytes = rest.length;
      }
    }
    if (pendingBytes > 0) {
      await flush(Buffer.concat(pending, pendingBytes));
    }
    return { size, segmentSize, segments: index, sha256: hash.digest("hex") };
  }

  /** The plaintext of a segmented file as a stream, optionally from a byte offset. */
  readStream(scope: SegmentScope, layout: SegmentLayout, startAt = 0): Readable {
    const total = segmentCount(layout);
    const first = Math.floor(startAt / layout.segmentSize);
    const store = this;
    async function* generate(): AsyncGenerator<Buffer> {
      for (let index = first; index < total; index++) {
        const bytes = await store.get(scope, index);
        yield index === first ? bytes.subarray(startAt - first * layout.segmentSize) : bytes;
      }
    }
    return Readable.from(generate(), { objectMode: false });
  }

  /** A segmented file as a {@link MailInputFile}: sequential and random access. */
  file(scope: SegmentScope, layout: SegmentLayout, path: string): MailInputFile {
    const store = this;
    let cachedIndex = -1;
    let cached: Buffer | null = null;
    return {
      path,
      size: layout.size,
      open: () => store.readStream(scope, layout),
      async read(offset: number, length: number): Promise<Buffer> {
        if (offset < 0 || length < 0) {
          throw new RangeError("negative read");
        }
        const end = Math.min(layout.size, offset + length);
        if (offset >= end) {
          return Buffer.alloc(0);
        }
        const parts: Buffer[] = [];
        let position = offset;
        while (position < end) {
          const index = Math.floor(position / layout.segmentSize);
          if (index !== cachedIndex || cached === null) {
            cached = await store.get(scope, index);
            cachedIndex = index;
          }
          const within = position - index * layout.segmentSize;
          const take = Math.min(end - position, cached.length - within);
          if (take <= 0) {
            throw new SegmentError(`segment ${index} is shorter than the file layout says`, index);
          }
          parts.push(cached.subarray(within, within + take));
          position += take;
        }
        return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
      },
    };
  }
}
