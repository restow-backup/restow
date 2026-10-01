import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Dek } from "../crypto.js";
import { ChunkReader } from "../engine/chunkstore.js";
import { Keyring } from "../engine/keyring.js";
import { MemoryChunkIndex } from "../engine/memory.js";
import type { StorageTargets } from "../engine/types.js";
import type { HeadResult, PutOptions, StorageBackend } from "../storage/backend.js";
import { MemoryStorage } from "../verify/testing.js";
import { verifyChain } from "./chain.js";
import { archiveItemKey } from "./layout.js";
import { InMemoryArchiveCatalog } from "./memory.js";
import { readArchiveItemOriginal } from "./reader.js";
import type { RetentionPolicy } from "./retention.js";
import { ArchiveCatalogDuplicateError } from "./types.js";
import { ArchiveWriteOnceError, writeArchiveItem } from "./writer.js";

const TENANT = "22222222-3333-4444-8555-666666666666";
const DEK: Dek = { version: 1, material: Buffer.alloc(32, 0x77) };
const RETENTION: RetentionPolicy = { mode: "from_capture", years: 10 };

/** Wraps a {@link MemoryStorage} and records the `PutOptions` each `put()` call received. */
class RecordingStorage implements StorageBackend {
  readonly puts: { key: string; options: PutOptions | undefined }[] = [];
  private readonly inner = new MemoryStorage();

  async put(key: string, data: Buffer | Readable, options?: PutOptions): Promise<void> {
    this.puts.push({ key, options });
    // MemoryStorage does not model retention itself; only the options this
    // spy recorded matter to the test.
    await this.inner.put(key, data);
  }

  get(key: string): Promise<Buffer> {
    return this.inner.get(key);
  }

  getStream(key: string): Promise<Readable> {
    return this.inner.getStream(key);
  }

  head(key: string): Promise<HeadResult | null> {
    return this.inner.head(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.inner.list(prefix);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}

function fixture() {
  const primary = new MemoryStorage();
  const storage: StorageTargets = { primary, copies: [] };
  const keys = new Keyring(TENANT, [DEK]);
  const index = new MemoryChunkIndex();
  const catalog = new InMemoryArchiveCatalog();
  return { primary, storage, keys, index, catalog };
}

describe("writeArchiveItem", () => {
  it("stores the original byte-exact, encrypted, and readable back through the chunk store", async () => {
    const { storage, keys, index } = fixture();
    const original = Buffer.from("Here are the numbers for Q1.".repeat(1000), "utf8");
    const receivedAt = new Date("2026-03-01T10:15:00.000Z");

    const record = await writeArchiveItem({
      tenantId: TENANT,
      itemId: "item-1",
      storage,
      keys,
      index,
      original,
      receivedAt,
      envelope: {
        sender: "alice@contoso.com",
        subject: "Q1 numbers",
        messageId: "<abc@contoso.com>",
        onBehalfOf: null,
        recipients: [{ address: "bob@contoso.com", type: "to" }],
      },
      flags: [],
      source: "journal",
      retentionPolicy: RETENTION,
      prevChainHash: null,
    });

    expect(record.itemHash).toBe(createHash("sha256").update(original).digest("hex"));
    expect(record.size).toBe(original.length);
    expect(record.chunks.length).toBeGreaterThan(0);

    // Never stored in plaintext: the sealed object on the raw storage backend
    // must not contain the readable subject or sender.
    const itemKey = archiveItemKey(TENANT, receivedAt, "item-1");
    const stored = await storage.primary.get(itemKey);
    expect(stored.includes("Q1 numbers")).toBe(false);
    expect(stored.includes("alice@contoso.com")).toBe(false);

    const reader = new ChunkReader({ storage, keys, index });
    const roundTripped = await readArchiveItemOriginal(reader, record);
    expect(roundTripped.equals(original)).toBe(true);
  });

  it("refuses to overwrite an item already written (write-once)", async () => {
    const { storage, keys, index } = fixture();
    const receivedAt = new Date("2026-03-01T10:15:00.000Z");
    const write = () =>
      writeArchiveItem({
        tenantId: TENANT,
        itemId: "item-1",
        storage,
        keys,
        index,
        original: Buffer.from("first version"),
        receivedAt,
        envelope: null,
        flags: [],
        source: "journal",
        retentionPolicy: RETENTION,
        prevChainHash: null,
      });

    await write();
    await expect(write()).rejects.toBeInstanceOf(ArchiveWriteOnceError);
  });

  it("keeps a malformed item's flags and null envelope through a full round trip", async () => {
    const { storage, keys, index } = fixture();
    const record = await writeArchiveItem({
      tenantId: TENANT,
      itemId: "item-broken",
      storage,
      keys,
      index,
      original: Buffer.from("raw report bytes, could not extract an original message"),
      receivedAt: new Date("2026-04-01T00:00:00.000Z"),
      envelope: null,
      flags: ["original-message-missing", "envelope-unparseable"],
      source: "journal",
      retentionPolicy: RETENTION,
      prevChainHash: null,
    });

    expect(record.envelope).toBeNull();
    expect(record.flags).toEqual(["original-message-missing", "envelope-unparseable"]);
  });

  it("chains items in append order, verifiable end to end through the catalog", async () => {
    const { storage, keys, index, catalog } = fixture();

    const first = await writeArchiveItem({
      tenantId: TENANT,
      itemId: "item-1",
      storage,
      keys,
      index,
      original: Buffer.from("first message"),
      receivedAt: new Date("2026-01-01T00:00:00.000Z"),
      envelope: null,
      flags: [],
      source: "journal",
      retentionPolicy: RETENTION,
      prevChainHash: await catalog.lastChainHash(TENANT),
    });
    await catalog.append(first);

    const second = await writeArchiveItem({
      tenantId: TENANT,
      itemId: "item-2",
      storage,
      keys,
      index,
      original: Buffer.from("second message"),
      receivedAt: new Date("2026-01-02T00:00:00.000Z"),
      envelope: null,
      flags: [],
      source: "journal",
      retentionPolicy: RETENTION,
      prevChainHash: await catalog.lastChainHash(TENANT),
    });
    await catalog.append(second);

    expect(second.prevChainHash).toBe(first.chainHash);
    const chain = await catalog.chain(TENANT);
    expect(verifyChain(chain)).toEqual({ ok: true, brokenAt: null });
  });

  it("deduplicates identical content across two different items", async () => {
    const { storage, keys, index } = fixture();
    const original = Buffer.from("the exact same message, journaled to two mailboxes".repeat(500));

    const first = await writeArchiveItem({
      tenantId: TENANT,
      itemId: "item-mbox-a",
      storage,
      keys,
      index,
      original,
      receivedAt: new Date("2026-01-01T00:00:00.000Z"),
      envelope: null,
      flags: [],
      source: "journal",
      retentionPolicy: RETENTION,
      prevChainHash: null,
    });
    const chunksAfterFirst = index.chunks.size;

    const second = await writeArchiveItem({
      tenantId: TENANT,
      itemId: "item-mbox-b",
      storage,
      keys,
      index,
      original,
      receivedAt: new Date("2026-01-01T00:05:00.000Z"),
      envelope: null,
      flags: [],
      source: "journal",
      retentionPolicy: RETENTION,
      prevChainHash: first.chainHash,
    });

    expect(second.chunks).toEqual(first.chunks);
    expect(index.chunks.size).toBe(chunksAfterFirst); // no new chunks written
  });

  it("a legal hold is recorded and overrides an otherwise-expired retention date", async () => {
    const { storage, keys, index } = fixture();
    const record = await writeArchiveItem({
      tenantId: TENANT,
      itemId: "item-held",
      storage,
      keys,
      index,
      original: Buffer.from("under investigation"),
      receivedAt: new Date("2015-01-01T00:00:00.000Z"),
      envelope: null,
      flags: [],
      source: "journal",
      retentionPolicy: { mode: "from_capture", years: 6 },
      legalHold: true,
      prevChainHash: null,
    });

    expect(record.legalHold).toBe(true);
    expect(record.retentionUntil).toEqual(new Date("2021-01-01T00:00:00.000Z"));
  });

  it("passes the computed retention date through as an object-lock intent when set", async () => {
    const primary = new RecordingStorage();
    const storage: StorageTargets = { primary, copies: [] };
    const keys = new Keyring(TENANT, [DEK]);
    const index = new MemoryChunkIndex();
    const receivedAt = new Date("2026-01-01T00:00:00.000Z");

    const record = await writeArchiveItem({
      tenantId: TENANT,
      itemId: "item-locked",
      storage,
      keys,
      index,
      original: Buffer.from("locked content"),
      receivedAt,
      envelope: null,
      flags: [],
      source: "journal",
      retentionPolicy: { mode: "from_capture", years: 6 },
      prevChainHash: null,
    });

    const itemKey = archiveItemKey(TENANT, receivedAt, "item-locked");
    const put = primary.puts.find((entry) => entry.key === itemKey);
    expect(put).toBeDefined();
    expect(put?.options?.retainUntil).toEqual(record.retentionUntil);
  });

  it("passes no object-lock intent when retention is unlimited", async () => {
    const primary = new RecordingStorage();
    const storage: StorageTargets = { primary, copies: [] };
    const keys = new Keyring(TENANT, [DEK]);
    const index = new MemoryChunkIndex();
    const receivedAt = new Date("2026-01-01T00:00:00.000Z");

    await writeArchiveItem({
      tenantId: TENANT,
      itemId: "item-unlimited",
      storage,
      keys,
      index,
      original: Buffer.from("kept forever"),
      receivedAt,
      envelope: null,
      flags: [],
      source: "journal",
      retentionPolicy: { mode: "from_capture", years: null },
      prevChainHash: null,
    });

    const itemKey = archiveItemKey(TENANT, receivedAt, "item-unlimited");
    const put = primary.puts.find((entry) => entry.key === itemKey);
    expect(put).toBeDefined();
    expect(put?.options?.retainUntil).toBeUndefined();
  });

  it("pins its chunks with a reference so scrub GC will not reclaim them", async () => {
    const { storage, keys, index } = fixture();
    const original = Buffer.from("evidence that must survive garbage collection".repeat(200));

    const record = await writeArchiveItem({
      tenantId: TENANT,
      itemId: "item-pinned",
      storage,
      keys,
      index,
      original,
      receivedAt: new Date("2026-01-01T00:00:00.000Z"),
      envelope: null,
      flags: [],
      source: "journal",
      retentionPolicy: RETENTION,
      prevChainHash: null,
    });

    expect(record.chunks.length).toBeGreaterThan(0);
    for (const chunkId of record.chunks) {
      // A chunk not referenced by any backup would sit at refcount 0 and be
      // reclaimed by scrub GC once its grace period elapsed; writeArchiveItem
      // must pin every chunk it writes so that never happens to an archived
      // item that no backup shares chunks with.
      expect(index.chunks.get(chunkId)?.refcount).toBeGreaterThan(0);
    }
  });
});

describe("ArchiveCatalogDuplicateError", () => {
  it("is thrown by the in-memory catalog on a duplicate append, independent of storage's own write-once check", async () => {
    const catalog = new InMemoryArchiveCatalog();
    const record = {
      id: "dup",
      tenantId: TENANT,
      receivedAt: new Date("2026-01-01T00:00:00.000Z"),
      itemHash: "a".repeat(64),
      prevChainHash: null,
      chainHash: "b".repeat(64),
      size: 1,
      chunks: ["c".repeat(64)],
      envelope: null,
      flags: [],
      source: "journal" as const,
      legalHold: false,
      retentionUntil: null,
      createdAt: new Date(),
    };
    await catalog.append(record);
    await expect(catalog.append(record)).rejects.toBeInstanceOf(ArchiveCatalogDuplicateError);
  });
});
