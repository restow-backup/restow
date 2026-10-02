import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storedId } from "../chunkId.js";
import { MAX_CHUNK_SIZE, MIN_CHUNK_SIZE, chunkAll } from "../chunker.js";
import { type Dek, encryptChunk, sha256 } from "../crypto.js";
import { PackReader, PackWriter } from "../pack.js";
import { LocalStorageBackend } from "../storage/local.js";
import {
  ChunkReader,
  ChunkStoreFailedError,
  ChunkWriter,
  JobAbortedError,
  MissingChunkError,
  RestoreIntegrityError,
  streamingChunks,
} from "./chunkstore.js";
import { Keyring } from "./keyring.js";
import { packPrefix } from "./layout.js";
import { MemoryChunkIndex } from "./memory.js";
import type { StorageTargets } from "./types.js";

/** An index whose lookups take a moment, like a database round trip. */
class SlowChunkIndex extends MemoryChunkIndex {
  override async existing(storedIds: readonly string[]): Promise<Set<string>> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return super.existing(storedIds);
  }
}

/** The chunk count a pack's footer records (before the SHA-256 and trailer). */
function footerChunkCount(pack: Buffer): number {
  return pack.readUInt32BE(pack.length - 8 - 32 - 4);
}

const TENANT = "11111111-2222-4333-8444-555555555555";
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x42) };

/** Random-looking but deterministic bytes so FastCDC finds real cut points. */
function pseudoRandom(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

async function collect(gen: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const parts: Buffer[] = [];
  for await (const part of gen) {
    parts.push(Buffer.from(part));
  }
  return parts;
}

describe("streamingChunks", () => {
  // 12 MiB through a stream of 13-byte pieces is about a million stream reads: about 1 s
  // alone, 5.5 to 7 s when more workspaces test at once on a busy machine (vitest's default is 5 s).
  it("produces the same boundaries as whole-buffer chunking regardless of piece size", async () => {
    const data = pseudoRandom(MAX_CHUNK_SIZE * 3 + 12345, 7);
    const expected = chunkAll(data).map((b) => b.length);

    for (const pieceSize of [13, 977, 64 * 1024, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE + 1]) {
      const pieces: Buffer[] = [];
      for (let offset = 0; offset < data.length; offset += pieceSize) {
        pieces.push(data.subarray(offset, offset + pieceSize));
      }
      const streamed = await collect(streamingChunks(Readable.from(pieces)));
      expect(streamed.map((c) => c.length)).toEqual(expected);
      expect(Buffer.concat(streamed).equals(data)).toBe(true);
    }
  }, 30_000);

  it("handles empty input and tiny objects", async () => {
    expect(await collect(streamingChunks(Buffer.alloc(0)))).toEqual([]);
    const tiny = await collect(streamingChunks(Buffer.from("hello")));
    expect(tiny).toHaveLength(1);
    expect(tiny[0].toString()).toBe("hello");
  });
});

describe("ChunkWriter / ChunkReader through the local pack store", () => {
  let root: string;
  let storage: StorageTargets;
  let copyRoot: string;
  let keys: Keyring;
  let index: MemoryChunkIndex;
  let packCounter: number;

  function writer(
    options: {
      maxPackBytes?: number;
      signal?: AbortSignal;
      onPackStored?: (packBytes: number) => void;
    } = {},
  ): ChunkWriter {
    return new ChunkWriter({
      tenantId: TENANT,
      storage,
      keys,
      index,
      maxPackBytes: options.maxPackBytes,
      signal: options.signal,
      onPackStored: options.onPackStored,
      packIdGenerator: () => `pack${(packCounter++).toString().padStart(4, "0")}`,
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "restow-chunkstore-"));
    copyRoot = join(root, "copy");
    storage = {
      primary: new LocalStorageBackend(join(root, "primary")),
      copies: [new LocalStorageBackend(copyRoot)],
    };
    keys = new Keyring(TENANT, [dek]);
    index = new MemoryChunkIndex();
    packCounter = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips objects byte for byte and records packs and chunks", async () => {
    const small = Buffer.from("a small object");
    const large = pseudoRandom(MAX_CHUNK_SIZE * 2 + 999, 3);

    const w = writer();
    const smallResult = await w.write(small);
    const largeResult = await w.write(Readable.from([large.subarray(0, 100), large.subarray(100)]));
    const stats = await w.close();

    expect(smallResult.size).toBe(small.length);
    expect(smallResult.chunks).toHaveLength(1);
    expect(smallResult.sha256).toBe(sha256(small).toString("hex"));
    expect(largeResult.size).toBe(large.length);
    expect(largeResult.chunks.length).toBeGreaterThan(1);
    expect(largeResult.chunks).toEqual(
      chunkAll(large).map((b) =>
        storedId(keys.chunkIdKey, large.subarray(b.offset, b.offset + b.length)).toString("hex"),
      ),
    );
    expect(stats.packsWritten).toBe(1);
    expect(stats.chunksNew).toBe(1 + largeResult.chunks.length);

    // The pack is in the primary and the copy, and the index knows every chunk.
    const packKeys = await storage.primary.list(packPrefix(TENANT));
    expect(packKeys).toHaveLength(1);
    expect(await storage.copies[0].head(packKeys[0])).not.toBeNull();
    const [pack] = index.packs.values();
    expect(pack.path).toBe(packKeys[0]);
    expect(pack.sha256).toBe(sha256(await storage.primary.get(packKeys[0])).toString("hex"));
    expect(index.chunks.size).toBe(stats.chunksNew);

    // Chunk rows point at the sealed bytes inside the pack.
    const reader = PackReader.open(await storage.primary.get(packKeys[0]));
    for (const [hex, location] of index.chunks) {
      const sealed = reader.get(Buffer.from(hex, "hex"));
      expect(sealed).toBeDefined();
      expect(sealed?.length).toBe(location.length);
    }

    const r = new ChunkReader({ storage, keys, index });
    const smallBack = await r.readObjectToBuffer({
      path: "small",
      size: small.length,
      mtime: 0,
      sha256: smallResult.sha256,
      chunks: smallResult.chunks,
    });
    expect(smallBack.equals(small)).toBe(true);
    const largeBack = Buffer.concat(await collect(r.read(largeResult.chunks)));
    expect(largeBack.equals(large)).toBe(true);
  });

  it("deduplicates within a writer, across writers and against the index", async () => {
    const shared = pseudoRandom(MAX_CHUNK_SIZE + 5000, 11);
    const w1 = writer();
    const first = await w1.write(shared);
    const again = await w1.write(shared);
    await w1.close();
    expect(first.newChunks).toBe(first.chunks.length);
    expect(again.newChunks).toBe(0);
    expect(again.chunks).toEqual(first.chunks);

    const w2 = writer();
    const other = await w2.write(Buffer.concat([shared, Buffer.from("tail")]));
    const stats = await w2.close();
    // Only the final chunk (the changed tail) is new; every earlier chunk dedupes.
    expect(other.newChunks).toBe(1);
    expect(stats.chunksNew).toBe(1);
    expect(index.chunks.size).toBe(first.chunks.length + 1);
  });

  it("rolls over to a new pack when the cap is reached", async () => {
    const w = writer({ maxPackBytes: MIN_CHUNK_SIZE * 2 });
    const data = pseudoRandom(MAX_CHUNK_SIZE * 2, 5);
    const result = await w.write(data);
    const stats = await w.close();
    expect(stats.packsWritten).toBeGreaterThan(1);
    expect(index.packs.size).toBe(stats.packsWritten);

    const r = new ChunkReader({ storage, keys, index, packCacheLimit: 1 });
    expect(Buffer.concat(await collect(r.read(result.chunks))).equals(data)).toBe(true);
  });

  it("reports the size of every pack it stored, once each, after the pack is durable", async () => {
    const stored: number[] = [];
    const w = writer({
      maxPackBytes: MIN_CHUNK_SIZE * 2,
      onPackStored: (bytes) => stored.push(bytes),
    });
    await w.write(pseudoRandom(MAX_CHUNK_SIZE * 2, 5));
    const stats = await w.close();
    expect(stored).toHaveLength(stats.packsWritten);
    const keysOnDisk = await storage.primary.list(packPrefix(TENANT));
    const sizes: number[] = [];
    for (const key of keysOnDisk) {
      sizes.push((await storage.primary.get(key)).length);
    }
    expect([...stored].sort((a, b) => a - b)).toEqual(sizes.sort((a, b) => a - b));
  });

  it("does not report a pack that could not be stored", async () => {
    const stored: number[] = [];
    const w = writer({ onPackStored: (bytes) => stored.push(bytes) });
    await w.write(Buffer.from("object in an open pack"));
    // Make the primary target unwritable: a file where its directory must be.
    await rm(join(root, "primary"), { recursive: true, force: true });
    await writeFile(join(root, "primary"), "not a directory");
    await expect(w.close()).rejects.toBeDefined();
    expect(stored).toEqual([]);
  });

  it("falls back to a copy target when the primary lost a pack", async () => {
    const w = writer();
    const data = pseudoRandom(3000, 9);
    const result = await w.write(data);
    await w.close();
    const [packKey] = await storage.primary.list(packPrefix(TENANT));
    await storage.primary.delete(packKey);

    const r = new ChunkReader({ storage, keys, index });
    expect(Buffer.concat(await collect(r.read(result.chunks))).equals(data)).toBe(true);
  });

  it("reports missing chunks and detects tampering", async () => {
    const w = writer();
    const object = await w.write(Buffer.from("integrity matters"));
    await w.close();

    const r = new ChunkReader({ storage, keys, index });
    const unknown = randomBytes(32).toString("hex");
    await expect(collect(r.read([unknown]))).rejects.toBeInstanceOf(MissingChunkError);

    // A size lie in the manifest is caught on read.
    await expect(
      collect(r.readObject({ path: "x", size: 1, mtime: 0, chunks: object.chunks })),
    ).rejects.toThrow(/size mismatch/);

    // Flip a byte in the pack body: the pack index still resolves but GCM rejects the chunk.
    const [packKey] = await storage.primary.list(packPrefix(TENANT));
    const bytes = Buffer.from(await storage.primary.get(packKey));
    bytes[60] ^= 0xff;
    await storage.primary.put(packKey, bytes);
    await storage.copies[0].put(packKey, bytes);
    const r2 = new ChunkReader({ storage, keys, index });
    await expect(collect(r2.read(object.chunks))).rejects.toThrow();
  });

  it("fails for good once a pack cannot be stored, keeping its chunks pending", async () => {
    const copy = storage.copies[0];
    let failCopy = true;
    storage = {
      primary: storage.primary,
      copies: [
        {
          put: async (key, data, options) => {
            if (failCopy) {
              failCopy = false;
              throw new Error("copy target unavailable");
            }
            await copy.put(key, data, options);
          },
          get: (key) => copy.get(key),
          getStream: (key) => copy.getStream(key),
          head: (key) => copy.head(key),
          list: (prefix) => copy.list(prefix),
          delete: (key) => copy.delete(key),
        },
      ],
    };
    const w = writer({ maxPackBytes: MIN_CHUNK_SIZE * 2 });
    const first = await w.write(pseudoRandom(MIN_CHUNK_SIZE, 21));
    expect(w.pendingChunkCount).toBe(first.chunks.length);

    // The next write rolls the pack over; its upload fails with the storage's own error.
    await expect(w.write(pseudoRandom(MAX_CHUNK_SIZE * 2, 22))).rejects.toThrow(
      "copy target unavailable",
    );
    expect(w.failed).toBeInstanceOf(ChunkStoreFailedError);
    expect(w.failed?.cause).toBeInstanceOf(Error);
    expect(w.pendingChunkCount).toBeGreaterThanOrEqual(first.chunks.length);
    expect(index.chunks.size).toBe(0);

    // Every later call reports the failure instead of pretending the chunks exist.
    await expect(w.write(pseudoRandom(100, 23))).rejects.toBeInstanceOf(ChunkStoreFailedError);
    await expect(w.flush()).rejects.toBeInstanceOf(ChunkStoreFailedError);
    await expect(w.close()).rejects.toBeInstanceOf(ChunkStoreFailedError);
  });

  it("stops writing when the job is aborted", async () => {
    const controller = new AbortController();
    const w = writer({ signal: controller.signal });
    await w.write(Buffer.from("before abort"));
    controller.abort();
    await expect(w.write(Buffer.from("after abort"))).rejects.toBeInstanceOf(JobAbortedError);
  });

  it("opens chunks sealed under an older key version after rotation", async () => {
    const w = writer();
    const data = pseudoRandom(2048, 1);
    const result = await w.write(data);
    await w.close();

    const rotated = new Keyring(TENANT, [dek, { version: 2, material: Buffer.alloc(32, 0x99) }]);
    expect(rotated.current.version).toBe(2);
    // The chunk-id key is derived from version 1, so ids stay stable.
    expect(rotated.chunkIdKey.equals(keys.chunkIdKey)).toBe(true);
    const r = new ChunkReader({ storage, keys: rotated, index });
    expect(Buffer.concat(await collect(r.read(result.chunks))).equals(data)).toBe(true);
  });

  it("seals a chunk once when concurrent writes meet the same content", async () => {
    index = new SlowChunkIndex();
    const w = writer();
    const shared = pseudoRandom(MAX_CHUNK_SIZE * 2 + 777, 41);
    const results = await Promise.all([w.write(shared), w.write(shared), w.write(shared)]);
    await w.close();

    const [first] = results;
    for (const result of results) {
      expect(result.chunks).toEqual(first?.chunks);
    }
    const unique = new Set(first?.chunks);
    expect(results.reduce((sum, result) => sum + result.newChunks, 0)).toBe(unique.size);

    const [packKey] = await storage.primary.list(packPrefix(TENANT));
    const bytes = await storage.primary.get(packKey as string);
    expect(footerChunkCount(bytes)).toBe(unique.size);
    const pack = PackReader.open(bytes);
    for (const [hex, location] of index.chunks) {
      const entry = pack.entries().find((candidate) => candidate.storedId.toString("hex") === hex);
      expect(entry).toMatchObject({ offset: location.offset, length: location.length });
    }
    const r = new ChunkReader({ storage, keys, index });
    expect(Buffer.concat(await collect(r.read(first?.chunks ?? []))).equals(shared)).toBe(true);
  });

  it("writes an intact copy of a chunk whose pack is damaged and moves the chunk there", async () => {
    const data = pseudoRandom(MAX_CHUNK_SIZE + 4321, 43);
    const w1 = writer();
    const first = await w1.write(data);
    await w1.close();
    await index.addReferences(first.chunks);
    const [damaged] = index.packs.values();
    index.damaged.set(damaged?.id as string, new Date());
    expect(await index.existing(first.chunks)).toEqual(new Set());

    const w2 = writer();
    const again = await w2.write(data);
    await w2.close();
    expect(again.chunks).toEqual(first.chunks);
    expect(again.newChunks).toBe(new Set(first.chunks).size);
    for (const id of first.chunks) {
      const entry = index.chunks.get(id);
      expect(entry?.packPath).not.toBe(damaged?.path);
      expect(entry?.refcount).toBe(1);
    }

    // The damaged file is not needed any more: the data reads from the copy.
    await storage.primary.delete(damaged?.path as string);
    await storage.copies[0]?.delete(damaged?.path as string);
    const r = new ChunkReader({ storage, keys, index });
    expect(Buffer.concat(await collect(r.read(first.chunks))).equals(data)).toBe(true);
  });

  it("refuses a chunk that is not the one its id names before handing out its bytes", async () => {
    const w = writer();
    const a = await w.write(Buffer.from("first object"));
    const b = await w.write(Buffer.from("second object"));
    await w.close();
    const [idA] = a.chunks;
    const [idB] = b.chunks;
    const [packKey] = await storage.primary.list(packPrefix(TENANT));
    const original = PackReader.open(await storage.primary.get(packKey as string));
    const location = index.chunks.get(idA as string);

    async function storeUnder(sealed: Buffer): Promise<void> {
      const forged = new PackWriter(TENANT);
      const entry = forged.append(Buffer.from(idA as string, "hex"), sealed);
      const bytes = forged.finalize();
      await storage.primary.put(packKey as string, bytes);
      await storage.copies[0]?.put(packKey as string, bytes);
      index.chunks.set(idA as string, {
        ...(location as NonNullable<typeof location>),
        offset: entry.offset,
        length: entry.length,
      });
    }

    // Another chunk's sealed bytes: GCM authenticates them, the bound id does not match.
    await storeUnder(original.get(Buffer.from(idB as string, "hex")) as Buffer);
    const swapped = new ChunkReader({ storage, keys, index });
    const received: Buffer[] = [];
    await expect(
      (async () => {
        for await (const part of swapped.read([idA as string])) {
          received.push(part);
        }
      })(),
    ).rejects.toThrow(RestoreIntegrityError);
    expect(received).toEqual([]);

    // Sealed for the right id but over other content: the recomputed id differs.
    await storeUnder(
      encryptChunk(keys.current, Buffer.from("other content"), Buffer.from(idA as string, "hex")),
    );
    const forgedReader = new ChunkReader({ storage, keys, index });
    await expect(collect(forgedReader.read([idA as string]))).rejects.toThrow(
      /does not match its content address/,
    );
  });
});
