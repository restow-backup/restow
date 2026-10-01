/**
 * The copy targets protect every read, not only a lost object: a pack or
 * manifest that is damaged on the primary (truncated, a flipped bit) is read
 * from the next target, and the damage is logged with the target it is on.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Dek } from "../crypto.js";
import type { SnapshotManifest } from "../manifest.js";
import { PackReader } from "../pack.js";
import type { StorageBackend } from "../storage/backend.js";
import { LocalStorageBackend } from "../storage/local.js";
import {
  ChunkReader,
  ChunkWriter,
  RestoreIntegrityError,
  readFromAnyTargetAs,
} from "./chunkstore.js";
import { Keyring } from "./keyring.js";
import { manifestKey, packPrefix } from "./layout.js";
import { MemoryChunkIndex } from "./memory.js";
import { sealManifest } from "./sealed-manifest.js";
import { loadManifest } from "./snapshot.js";
import type { LogFields, Logger, StorageTargets } from "./types.js";

const TENANT = "11111111-2222-4333-8444-555555555555";
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x42) };

/** Deterministic bytes FastCDC finds real cut points in. */
function pseudoRandom(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** Records warnings, for the log line that names the damaged target. */
function recordingLogger(warnings: LogFields[]): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (_message, fields) => {
      warnings.push(fields ?? {});
    },
    error: () => {},
    child: () => logger,
  };
  return logger;
}

/** Counts reads, to prove a damaged target is not asked again. */
class CountingBackend extends LocalStorageBackend {
  gets = 0;
  override async get(key: string): Promise<Buffer> {
    this.gets++;
    return super.get(key);
  }
}

describe("reads fall back to a copy when the primary is damaged", () => {
  let root: string;
  let primary: CountingBackend;
  let copy: StorageBackend;
  let storage: StorageTargets;
  let keys: Keyring;
  let index: MemoryChunkIndex;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "restow-fallback-"));
    primary = new CountingBackend(join(root, "primary"));
    copy = new LocalStorageBackend(join(root, "copy"));
    storage = { primary, copies: [copy] };
    keys = new Keyring(TENANT, [dek]);
    index = new MemoryChunkIndex();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function backUp(data: Buffer): Promise<{ chunks: string[]; packKey: string }> {
    const writer = new ChunkWriter({ tenantId: TENANT, storage, keys, index });
    const result = await writer.write(data);
    await writer.close();
    const [packKey] = await primary.list(packPrefix(TENANT));
    return { chunks: result.chunks, packKey: packKey as string };
  }

  async function readAll(reader: ChunkReader, chunks: readonly string[]): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of reader.read(chunks)) {
      parts.push(Buffer.from(part));
    }
    return Buffer.concat(parts);
  }

  it("reads a chunk from the copy when the primary pack has a flipped bit", async () => {
    const data = pseudoRandom(40_000, 5);
    const { chunks, packKey } = await backUp(data);
    const damaged = Buffer.from(await primary.get(packKey));
    damaged[80] = (damaged[80] ?? 0) ^ 0xff;
    await primary.put(packKey, damaged);

    const warnings: LogFields[] = [];
    const reader = new ChunkReader({ storage, keys, index, logger: recordingLogger(warnings) });
    primary.gets = 0;
    expect((await readAll(reader, chunks)).equals(data)).toBe(true);
    expect(warnings).toContainEqual(expect.objectContaining({ pack: packKey, target: "primary" }));
    // The damaged primary is not asked again for the rest of the pack.
    expect(primary.gets).toBe(1);
  });

  it("reads a pack from the copy when the primary pack is truncated", async () => {
    const data = pseudoRandom(20_000, 6);
    const { chunks, packKey } = await backUp(data);
    const whole = await primary.get(packKey);
    await primary.put(packKey, whole.subarray(0, whole.length - 20));

    const warnings: LogFields[] = [];
    const reader = new ChunkReader({ storage, keys, index, logger: recordingLogger(warnings) });
    expect((await readAll(reader, chunks)).equals(data)).toBe(true);
    expect(warnings).toContainEqual(expect.objectContaining({ key: packKey, target: "primary" }));
  });

  it("names the primary's damage when every target is damaged", async () => {
    const data = pseudoRandom(20_000, 7);
    const { chunks, packKey } = await backUp(data);
    const flipped = Buffer.from(await primary.get(packKey));
    flipped[80] = (flipped[80] ?? 0) ^ 0xff;
    await primary.put(packKey, flipped);
    const whole = await copy.get(packKey);
    await copy.put(packKey, whole.subarray(0, whole.length - 20));

    // The primary's damage (a chunk that no longer proves itself), not the copy's.
    const reader = new ChunkReader({ storage, keys, index });
    await expect(readAll(reader, chunks)).rejects.toBeInstanceOf(RestoreIntegrityError);

    // A single target reports its damage exactly as before.
    const alone = new ChunkReader({ storage: { primary: copy, copies: [] }, keys, index });
    await expect(readAll(alone, chunks)).rejects.toThrow(/trailer/);
    expect(() => PackReader.open(whole.subarray(0, whole.length - 20))).toThrow(/trailer/);
  });

  it("loads a manifest from the copy when the primary manifest is damaged", async () => {
    const key = manifestKey(TENANT, "snap-1");
    const manifest: SnapshotManifest = {
      version: 2,
      tenantId: TENANT,
      snapshotId: "snap-1",
      createdAt: Date.UTC(2026, 8, 23),
      source: { type: "imap", id: "anna" },
      objects: [{ path: "mail/INBOX/1.eml", size: 3, mtime: 0, chunks: [] }],
    };
    const sealed = await sealManifest(manifest, dek, key);
    await primary.put(key, sealed.subarray(0, sealed.length - 5));
    await copy.put(key, sealed);

    const loaded = await loadManifest(storage, key, keys);
    expect(loaded.objects.map((object) => object.path)).toEqual(["mail/INBOX/1.eml"]);

    // Damaged everywhere: the damage is reported, not "not found".
    await copy.put(key, sealed.subarray(0, sealed.length - 5));
    await expect(loadManifest(storage, key, keys)).rejects.not.toThrow(/not readable/);
  });

  it("only reports an object as unreadable when no target has it", async () => {
    await expect(readFromAnyTargetAs(storage, "tenants/x/none", (bytes) => bytes)).rejects.toThrow(
      /not readable from any storage target/,
    );
  });
});
