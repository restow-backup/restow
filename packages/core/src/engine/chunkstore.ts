/**
 * ChunkWriter / ChunkReader: the streaming path between an object's bytes and
 * the encrypted pack store.
 *
 * Write path, per object:
 *   bytes -> FastCDC boundaries -> dedup id (SHA-256) -> stored id (HMAC with the
 *   tenant chunk-id key) -> skip if the index already has it -> AES-256-GCM seal
 *   (AAD = stored id) -> append to the open pack. A pack is flushed when it
 *   reaches `maxPackBytes`: written to the primary target and every copy first,
 *   recorded in the chunk index second. That order is what keeps the index
 *   honest across crashes: an orphaned pack is cheap (garbage collection), an
 *   index entry without bytes would be a silent restore failure.
 *
 * A pack that cannot be stored or recorded takes the chunks sealed into it
 * along, while earlier `write()` results already name them. From then on the
 * writer is failed: every further write, flush or close throws
 * {@link ChunkStoreFailedError}, so no checkpoint or commit can reference the
 * lost chunks and a retry resumes from the last good checkpoint.
 *
 * Concurrent `write()` calls on one writer (the IMAP engine runs folder
 * workers side by side) may meet the same content at the same time. Each new
 * stored id is claimed exactly once: the first caller asks the index, every
 * other caller waits for that answer and deduplicates against it, and the
 * claim is taken before the next await. A pack therefore never holds one id
 * twice.
 *
 * Read path: locate the stored ids through the index, fetch the packs (primary
 * first, copies as fallback), open them with PackReader and decrypt with the
 * key version each chunk's header names. The fallback covers damage, not only
 * absence: a pack that does not open, or a chunk in it that does not decrypt
 * or prove itself, is read from the next target. Every chunk must prove it is the one
 * that was asked for: the id sealed into its header (the GCM AAD) and the id
 * recomputed from its plaintext must both equal the requested id, otherwise
 * {@link RestoreIntegrityError} is thrown before its bytes are handed out.
 */
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { storedId } from "../chunkId.js";
import { MAX_CHUNK_SIZE, chunk, chunkAll } from "../chunker.js";
import { encryptChunk, sha256 } from "../crypto.js";
import type { ManifestObject } from "../manifest.js";
import { type PackEntry, PackReader, PackWriter } from "../pack.js";
import { type StorageBackend, isObjectNotFound } from "../storage/backend.js";
import { sealedAad } from "./keyring.js";
import { packKey } from "./layout.js";
import { noopLogger } from "./logger.js";
import type {
  ChunkIndex,
  ChunkLocation,
  ChunkRecord,
  Logger,
  PackRecord,
  StorageTargets,
  TenantKeyring,
} from "./types.js";

/** Packs are capped at 64 MiB (docs/ARCHITECTURE.md). */
export const DEFAULT_MAX_PACK_BYTES = 64 * 1024 * 1024;
/** How many decoded packs a reader keeps in memory. */
export const DEFAULT_PACK_CACHE_LIMIT = 4;
/** Upper bound on ids per index round trip. */
const INDEX_BATCH = 1000;

/** Anything that yields the bytes of one object. */
export type ObjectInput = Buffer | Readable | AsyncIterable<Buffer | Uint8Array>;

/** The outcome of writing one object. */
export interface WrittenObject {
  /** Plaintext size. */
  readonly size: number;
  /** SHA-256 (hex) over the plaintext. */
  readonly sha256: string;
  /** Ordered stored chunk ids (hex). */
  readonly chunks: string[];
  /** Chunks that did not exist before this write. */
  readonly newChunks: number;
  /** Plaintext bytes of those new chunks. */
  readonly newBytes: number;
}

export interface ChunkWriterStats {
  objects: number;
  bytesIn: number;
  chunksSeen: number;
  chunksNew: number;
  bytesNew: number;
  bytesSealed: number;
  packsWritten: number;
}

export interface ChunkWriterOptions {
  readonly tenantId: string;
  readonly storage: StorageTargets;
  readonly keys: TenantKeyring;
  readonly index: ChunkIndex;
  readonly maxPackBytes?: number;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  /** Injectable pack id generator (tests pin it). */
  readonly packIdGenerator?: () => string;
}

function toHex(id: Buffer): string {
  return id.toString("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new JobAbortedError();
  }
}

/**
 * A pack could not be stored or recorded, so chunks that earlier writes
 * returned are gone. Thrown by every call on the writer after that failure;
 * `cause` is the original storage or index error.
 */
export class ChunkStoreFailedError extends Error {
  constructor(
    /** Chunks sealed into the pack that was lost. */
    readonly lostChunks: number,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `a pack with ${lostChunks} new chunk(s) could not be stored (${detail}); nothing written since the last checkpoint can be kept`,
      { cause },
    );
    this.name = "ChunkStoreFailedError";
  }
}

/**
 * No storage target returned the object. `missing` is true only when every
 * target answered that it does not have it (a definite not-found: S3
 * NoSuchKey or 404, a missing file); when at least one target could not be
 * asked (network, timeout, 5xx, throttling, denied access) nothing is known
 * about the object. `cause` is the first target's error.
 */
export class ObjectUnreadableError extends Error {
  constructor(
    readonly key: string,
    readonly missing: boolean,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`object ${key} is not readable from any storage target (${detail})`, { cause });
    this.name = "ObjectUnreadableError";
  }
}

/**
 * Stored bytes that do not decode: an object that is truncated, bit-flipped or
 * not in the expected format, a chunk that does not decrypt (AES-GCM
 * authentication failed, sealed for another key) or that its pack does not
 * hold. The message is the decoder's own; `cause` is its error.
 */
export class StoredDataDamagedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StoredDataDamagedError";
  }
}

/** Thrown when the job's AbortSignal fires mid-write; the framework treats it as cancellation. */
export class JobAbortedError extends Error {
  constructor() {
    super("job aborted");
    this.name = "JobAbortedError";
  }
}

async function* toAsyncIterable(input: ObjectInput): AsyncGenerator<Buffer> {
  if (Buffer.isBuffer(input)) {
    yield input;
    return;
  }
  for await (const piece of input as AsyncIterable<Buffer | Uint8Array | string>) {
    if (typeof piece === "string") {
      yield Buffer.from(piece, "utf8");
    } else {
      yield Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    }
  }
}

/**
 * Streaming FastCDC: yields content-defined chunks from an arbitrary byte
 * stream without buffering the object. A boundary is only decided once at
 * least MAX_CHUNK_SIZE bytes are buffered (or the stream ended), which makes
 * the cut positions identical to chunking the whole object at once.
 */
export async function* streamingChunks(input: ObjectInput): AsyncGenerator<Buffer> {
  let window: Buffer = Buffer.alloc(0);
  const pending: Buffer[] = [];
  let pendingLength = 0;

  for await (const piece of toAsyncIterable(input)) {
    if (piece.length === 0) {
      continue;
    }
    pending.push(piece);
    pendingLength += piece.length;
    if (window.length + pendingLength < MAX_CHUNK_SIZE) {
      continue;
    }
    window = Buffer.concat([window, ...pending]);
    pending.length = 0;
    pendingLength = 0;
    while (window.length >= MAX_CHUNK_SIZE) {
      const first = chunk(window).next();
      if (first.done) {
        break;
      }
      const { length } = first.value;
      yield window.subarray(0, length);
      window = window.subarray(length);
    }
  }

  if (pending.length > 0) {
    window = Buffer.concat([window, ...pending]);
  }
  for (const boundary of chunkAll(window)) {
    yield window.subarray(boundary.offset, boundary.offset + boundary.length);
  }
}

/** Assembles sealed chunks into packs and records them; see the module comment. */
export class ChunkWriter {
  readonly stats: ChunkWriterStats = {
    objects: 0,
    bytesIn: 0,
    chunksSeen: 0,
    chunksNew: 0,
    bytesNew: 0,
    bytesSealed: 0,
    packsWritten: 0,
  };
  /** Stored ids (hex) known to exist: in the index, or claimed by a write of this writer. */
  private readonly known = new Set<string>();
  /** Ids claimed by this writer and not yet recorded in the index (open pack, or about to join it). */
  private readonly unflushed = new Set<string>();
  /** Index lookups in flight, so concurrent writes of the same chunk ask once and write it once. */
  private readonly lookups = new Map<string, Promise<boolean>>();
  private pack: PackWriter;
  private packEntries: PackEntry[] = [];
  private readonly maxPackBytes: number;
  private readonly logger: Logger;
  private readonly packIdGenerator: () => string;
  private closed = false;
  /** Set once a pack was lost; see {@link ChunkStoreFailedError}. */
  private failure: ChunkStoreFailedError | null = null;

  constructor(private readonly options: ChunkWriterOptions) {
    this.maxPackBytes = options.maxPackBytes ?? DEFAULT_MAX_PACK_BYTES;
    this.logger = (options.logger ?? noopLogger).child({ component: "chunk-writer" });
    this.packIdGenerator = options.packIdGenerator ?? randomUUID;
    this.pack = new PackWriter(options.tenantId);
  }

  /** Stored ids that are sealed into packs not yet written to storage (or lost with one). */
  get pendingChunkCount(): number {
    return this.unflushed.size;
  }

  /** The failure that ended this writer, or null while every pack was stored. */
  get failed(): ChunkStoreFailedError | null {
    return this.failure;
  }

  /** Chunk, dedupe, seal and pack one object's bytes. */
  async write(input: ObjectInput): Promise<WrittenObject> {
    this.assertOpen();
    const { keys, signal } = this.options;
    const objectHash = createObjectHash();
    const chunks: string[] = [];
    let size = 0;
    let newChunks = 0;
    let newBytes = 0;

    for await (const plaintext of streamingChunks(input)) {
      throwIfAborted(signal);
      size += plaintext.length;
      objectHash.update(plaintext);
      this.stats.chunksSeen++;

      const id = storedId(keys.chunkIdKey, plaintext);
      const hex = toHex(id);
      chunks.push(hex);

      if (!(await this.claimNew(hex))) {
        continue;
      }
      // Claimed: `known` and `unflushed` already name the id, so a concurrent
      // write of the same content deduplicates against this one, and no
      // checkpoint passes while it is not in a stored pack.
      const sealed = encryptChunk(keys.current, plaintext, id);
      if (this.pack.count > 0 && this.pack.byteLength + sealed.length > this.maxPackBytes) {
        await this.flush();
      }
      this.packEntries.push(this.pack.append(id, sealed));
      newChunks++;
      newBytes += plaintext.length;
      this.stats.chunksNew++;
      this.stats.bytesNew += plaintext.length;
      this.stats.bytesSealed += sealed.length;
    }

    this.stats.objects++;
    this.stats.bytesIn += size;
    return { size, sha256: objectHash.digest(), chunks, newChunks, newBytes };
  }

  /**
   * Whether the caller must write this chunk. True for exactly one caller per
   * id the index does not have; that caller owns the claim and seals the
   * chunk. False when the chunk exists or another write of this writer claimed
   * it (a caller that arrives during the index round trip waits for it). A
   * failed lookup rejects every caller that waited for it.
   */
  private async claimNew(hex: string): Promise<boolean> {
    if (this.known.has(hex)) {
      return false;
    }
    const inFlight = this.lookups.get(hex);
    if (inFlight) {
      await inFlight;
      return false;
    }
    const lookup = this.lookupAndClaim(hex);
    this.lookups.set(hex, lookup);
    try {
      return await lookup;
    } finally {
      this.lookups.delete(hex);
    }
  }

  private async lookupAndClaim(hex: string): Promise<boolean> {
    const found = await this.options.index.existing([hex]);
    // No await between the answer and the claim: from here on `known` names
    // the id, before the lookup leaves `lookups`.
    this.known.add(hex);
    if (found.has(hex)) {
      return false;
    }
    this.unflushed.add(hex);
    return true;
  }

  /**
   * Write the open pack to every storage target and record it in the index.
   * After this resolves, every chunk returned by earlier `write()` calls is
   * durable and locatable. No-op when the pack is empty. When the pack cannot
   * be stored, the storage or index error is thrown and the writer is failed.
   */
  async flush(): Promise<void> {
    this.assertOpen();
    if (this.pack.count === 0) {
      return;
    }
    const packId = this.packIdGenerator();
    const path = packKey(this.options.tenantId, packId);
    const bytes = this.pack.finalize();
    const entries = this.packEntries;
    // Start a fresh pack before any await so a concurrent write() never lands
    // in a pack that is already being uploaded.
    this.pack = new PackWriter(this.options.tenantId);
    this.packEntries = [];

    const record: PackRecord = {
      id: packId,
      path,
      sha256: toHex(sha256(bytes)),
      size: bytes.length,
    };
    const chunkRecords: ChunkRecord[] = entries.map((entry) => ({
      storedId: toHex(entry.storedId),
      offset: entry.offset,
      length: entry.length,
    }));
    try {
      await writeToAllTargets(this.options.storage, path, bytes);
      await this.options.index.recordPack(record, chunkRecords);
    } catch (error) {
      this.markLost(chunkRecords, error);
      throw error;
    }
    for (const entry of chunkRecords) {
      this.unflushed.delete(entry.storedId);
    }
    this.stats.packsWritten++;
    this.logger.debug("pack written", { path, chunks: chunkRecords.length, size: bytes.length });
  }

  /** Flush and seal the writer. Further writes throw. */
  async close(): Promise<ChunkWriterStats> {
    if (this.closed) {
      return this.stats;
    }
    await this.flush();
    this.closed = true;
    return this.stats;
  }

  /**
   * The chunks of a pack that was not stored are gone: they are no longer
   * known to exist (nothing may deduplicate against them), they stay counted
   * as pending, and the writer refuses all further work.
   */
  private markLost(records: readonly ChunkRecord[], cause: unknown): void {
    for (const record of records) {
      this.known.delete(record.storedId);
    }
    this.failure ??= new ChunkStoreFailedError(records.length, cause);
    this.logger.error("pack could not be stored, chunk writer failed", {
      lostChunks: records.length,
      error: cause,
    });
  }

  private assertOpen(): void {
    if (this.failure) {
      throw this.failure;
    }
    if (this.closed) {
      throw new Error("chunk writer is closed");
    }
  }
}

function createObjectHash(): { update(buf: Buffer): void; digest(): string } {
  const hash = createHash("sha256");
  return {
    update: (buf) => {
      hash.update(buf);
    },
    digest: () => hash.digest("hex"),
  };
}

/** Write one object to the primary target and then to every copy. */
export async function writeToAllTargets(
  storage: StorageTargets,
  key: string,
  bytes: Buffer,
): Promise<void> {
  await storage.primary.put(key, bytes);
  await Promise.all(storage.copies.map((copy) => copy.put(key, bytes)));
}

/** Read one object from the primary target, falling back to the copies in order. */
export async function readFromAnyTarget(storage: StorageTargets, key: string): Promise<Buffer> {
  return readFromAnyTargetAs(storage, key, (bytes) => bytes);
}

/** How a log line names a storage target: the primary, or copy 1, 2, ... */
export function storageTargetName(index: number): string {
  return index === 0 ? "primary" : `copy ${index}`;
}

/** A decoded object and the target (0 = primary) it came from. */
export interface DecodedFromTarget<T> {
  readonly value: T;
  readonly target: number;
}

export interface ReadFromTargetOptions {
  /** First target to try (0 = primary); the ones before it already failed. */
  readonly from?: number;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
}

/**
 * Read one object and decode it: the primary target first, then each copy.
 * A target whose object is missing, cannot be read, or does not decode
 * (truncated, bit-flipped, sealed for another key) is passed over with a
 * warning, so one damaged target never fails a read another one can serve.
 * When every target fails, the first decoding failure is thrown, as it names
 * the damage; with none, a "not readable from any storage target" error.
 */
export async function readDecodedFromAnyTarget<T>(
  storage: StorageTargets,
  key: string,
  decode: (bytes: Buffer) => T | Promise<T>,
  options: ReadFromTargetOptions = {},
): Promise<DecodedFromTarget<T>> {
  const targets: readonly StorageBackend[] = [storage.primary, ...storage.copies];
  const logger = options.logger ?? noopLogger;
  let damage: { error: unknown } | undefined;
  let readError: unknown;
  let unanswered = false;
  for (let index = options.from ?? 0; index < targets.length; index++) {
    throwIfAborted(options.signal);
    const target = targets[index] as StorageBackend;
    let bytes: Buffer;
    try {
      bytes = await target.get(key);
    } catch (error) {
      readError ??= error;
      unanswered ||= !isObjectNotFound(error);
      continue;
    }
    try {
      return { value: await decode(bytes), target: index };
    } catch (error) {
      damage ??= { error };
      logger.warn("object on a storage target is damaged, reading the next target", {
        key,
        target: storageTargetName(index),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (damage) {
    const { error } = damage;
    // Typed for the restore check (damage is proof); the decoder's message and class stay reachable.
    throw error instanceof StoredDataDamagedError ||
      error instanceof RestoreIntegrityError ||
      error instanceof MissingChunkError ||
      error instanceof JobAbortedError
      ? error
      : new StoredDataDamagedError(error instanceof Error ? error.message : String(error), error);
  }
  throw new ObjectUnreadableError(key, !unanswered, readError);
}

/** {@link readDecodedFromAnyTarget}, for callers that only need the value. */
export async function readFromAnyTargetAs<T>(
  storage: StorageTargets,
  key: string,
  decode: (bytes: Buffer) => T | Promise<T>,
  options: ReadFromTargetOptions = {},
): Promise<T> {
  return (await readDecodedFromAnyTarget(storage, key, decode, options)).value;
}

export interface ChunkReaderOptions {
  readonly storage: StorageTargets;
  readonly keys: TenantKeyring;
  readonly index: ChunkIndex;
  readonly packCacheLimit?: number;
  /** Recompute each pack's whole-file hash when opening it (slow; the scrub job does this). */
  readonly verifyPacks?: boolean;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
}

/** Thrown when a manifest references a chunk the index does not know. */
export class MissingChunkError extends Error {
  constructor(readonly storedId: string) {
    super(`chunk ${storedId} is not in the chunk index`);
    this.name = "MissingChunkError";
  }
}

/**
 * Thrown when reconstructed data is not what the snapshot recorded: a chunk
 * that is not the one its id names, or an object whose size or SHA-256
 * differs from the manifest (tampering or corruption).
 */
export class RestoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreIntegrityError";
  }
}

/**
 * Prove that `sealed` is the chunk `id` names before its plaintext is used:
 * the id bound into the sealed header as the GCM AAD must match (checked
 * before decrypting), and so must the id recomputed from the plaintext.
 */
export function openChunkAs(keys: TenantKeyring, id: Buffer, sealed: Buffer): Buffer {
  const hex = toHex(id);
  let boundTo: Buffer;
  try {
    boundTo = sealedAad(sealed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RestoreIntegrityError(`chunk ${hex} is malformed (${detail})`);
  }
  if (!boundTo.equals(id)) {
    throw new RestoreIntegrityError(
      `chunk ${hex} does not match its content address: the stored bytes are sealed for chunk ${toHex(boundTo)}`,
    );
  }
  let plaintext: Buffer;
  try {
    plaintext = keys.open(sealed);
  } catch (error) {
    // AES-GCM authentication failed, or the header names a key this keyring does not hold.
    throw new StoredDataDamagedError(
      `chunk ${hex} does not decrypt (${error instanceof Error ? error.message : String(error)})`,
      error,
    );
  }
  if (!storedId(keys.chunkIdKey, plaintext).equals(id)) {
    throw new RestoreIntegrityError(
      `chunk ${hex} does not match its content address: its plaintext hashes to another id`,
    );
  }
  return plaintext;
}

/** An opened pack and the storage target (0 = primary) its bytes came from. */
interface OpenedPack {
  readonly reader: PackReader;
  readonly target: number;
}

/**
 * Reads chunks back out of the pack store. See the module comment. A pack
 * that is damaged on one target (it does not open, or a chunk in it does not
 * decrypt or is not the one its id names) is read from the next target for
 * that chunk and every later one, so the copies protect every restore, not
 * only the scrub.
 */
export class ChunkReader {
  private readonly packs = new Map<string, OpenedPack>();
  private readonly packCacheLimit: number;

  constructor(private readonly options: ChunkReaderOptions) {
    this.packCacheLimit = Math.max(1, options.packCacheLimit ?? DEFAULT_PACK_CACHE_LIMIT);
  }

  /** Resolve where each id lives, in index-sized batches. */
  async locate(storedIds: readonly string[]): Promise<Map<string, ChunkLocation>> {
    const result = new Map<string, ChunkLocation>();
    const unique = [...new Set(storedIds)];
    for (let i = 0; i < unique.length; i += INDEX_BATCH) {
      const batch = unique.slice(i, i + INDEX_BATCH);
      for (const [id, location] of await this.options.index.locate(batch)) {
        result.set(id, location);
      }
    }
    return result;
  }

  /** The pack at `path`, opened from the first target at or after `from` that holds it intact. */
  private async openPack(path: string, from = 0): Promise<OpenedPack> {
    const cached = this.packs.get(path);
    if (cached && cached.target >= from) {
      // Refresh recency (Map preserves insertion order).
      this.packs.delete(path);
      this.packs.set(path, cached);
      return cached;
    }
    const verify = this.options.verifyPacks ?? false;
    const opened = await readDecodedFromAnyTarget(
      this.options.storage,
      path,
      (bytes) => PackReader.open(bytes, { verify }),
      { from, logger: this.options.logger, signal: this.options.signal },
    );
    const entry: OpenedPack = { reader: opened.value, target: opened.target };
    this.packs.delete(path);
    this.packs.set(path, entry);
    while (this.packs.size > this.packCacheLimit) {
      const oldest = this.packs.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.packs.delete(oldest);
    }
    return entry;
  }

  /**
   * One chunk, decrypted and proven (see {@link openChunkAs}). When the pack
   * on one target fails for it, the chunk is read from the next target; when
   * every target fails, the first failure is thrown.
   */
  private async readChunk(hex: string, packPath: string): Promise<Buffer> {
    const id = Buffer.from(hex, "hex");
    const targets = 1 + this.options.storage.copies.length;
    let pack = await this.openPack(packPath);
    let firstError: unknown;
    for (;;) {
      try {
        const sealed = pack.reader.get(id);
        if (!sealed) {
          throw new StoredDataDamagedError(`chunk ${hex} is missing from pack ${packPath}`);
        }
        return openChunkAs(this.options.keys, id, sealed);
      } catch (error) {
        firstError ??= error;
        // The damaged copy is not used again by this reader.
        this.packs.delete(packPath);
        if (pack.target + 1 >= targets) {
          throw firstError;
        }
        (this.options.logger ?? noopLogger).warn(
          "chunk is damaged on a storage target, reading the next target",
          {
            pack: packPath,
            chunk: hex,
            target: storageTargetName(pack.target),
            error: error instanceof Error ? error.message : String(error),
          },
        );
        try {
          pack = await this.openPack(packPath, pack.target + 1);
        } catch (next) {
          if (next instanceof JobAbortedError) {
            throw next;
          }
          throw firstError;
        }
      }
    }
  }

  /**
   * Decrypted chunks in the given order. Throws on a missing chunk, and with
   * {@link RestoreIntegrityError} on a chunk that is not the one its id names
   * (see {@link openChunkAs}), before any of its bytes are yielded.
   */
  async *read(storedIds: readonly string[]): AsyncGenerator<Buffer> {
    const locations = await this.locate(storedIds);
    for (const hex of storedIds) {
      throwIfAborted(this.options.signal);
      const location = locations.get(hex);
      if (!location) {
        throw new MissingChunkError(hex);
      }
      yield await this.readChunk(hex, location.packPath);
    }
  }

  /**
   * The reconstructed bytes of a manifest object, chunk by chunk. Verifies the
   * size and, when the manifest carries one, the SHA-256 of the whole object.
   */
  async *readObject(object: ManifestObject): AsyncGenerator<Buffer> {
    const hash = createObjectHash();
    let size = 0;
    for await (const plaintext of this.read(object.chunks)) {
      size += plaintext.length;
      hash.update(plaintext);
      yield plaintext;
    }
    if (size !== object.size) {
      throw new RestoreIntegrityError(
        `object ${object.path}: size mismatch (manifest ${object.size}, reconstructed ${size})`,
      );
    }
    const digest = hash.digest();
    if (object.sha256 !== undefined && object.sha256 !== digest) {
      throw new RestoreIntegrityError(`object ${object.path}: content hash mismatch`);
    }
  }

  /** Convenience: the whole object in memory (only for objects known to be small). */
  async readObjectToBuffer(object: ManifestObject): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of this.readObject(object)) {
      parts.push(part);
    }
    return Buffer.concat(parts);
  }

  /** A Node stream of the reconstructed object, for piping into uploads or files. */
  objectStream(object: ManifestObject): Readable {
    return Readable.from(this.readObject(object));
  }
}
