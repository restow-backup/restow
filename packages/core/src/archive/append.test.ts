import { describe, expect, it } from "vitest";
import type { Dek } from "../crypto.js";
import { ChunkReader } from "../engine/chunkstore.js";
import { Keyring } from "../engine/keyring.js";
import { MemoryChunkIndex } from "../engine/memory.js";
import type { StorageTargets } from "../engine/types.js";
import { MemoryStorage } from "../verify/testing.js";
import { type CaptureArchiveItemOptions, captureArchiveItem } from "./append.js";
import { computeArchiveChainHash, verifyChain } from "./chain.js";
import { InMemoryArchiveAppendStore } from "./memory.js";
import { readArchiveItemOriginal } from "./reader.js";
import type { ArchiveItemRecord } from "./types.js";

const TENANT = "22222222-3333-4444-8555-666666666666";
const DEK: Dek = { version: 1, material: Buffer.alloc(32, 0x42) };

function mail(messageId: string | null, headers: string, body: string): Buffer {
  const id = messageId ? `Message-ID: <${messageId}>\r\n` : "";
  return Buffer.from(`${id}${headers}Subject: Quarterly numbers\r\n\r\n${body}\r\n`, "utf8");
}

function fixture() {
  const primary = new MemoryStorage();
  const storage: StorageTargets = { primary, copies: [] };
  const keys = new Keyring(TENANT, [DEK]);
  const index = new MemoryChunkIndex();
  const store = new InMemoryArchiveAppendStore(TENANT);
  let clock = Date.parse("2026-11-02T08:00:00.000Z");
  const now = () => new Date(clock);
  const base = (overrides: Partial<CaptureArchiveItemOptions>): CaptureArchiveItemOptions => ({
    tenantId: TENANT,
    storage,
    keys,
    index,
    store,
    original: mail("one@example.com", "", "Hello"),
    source: "graph_sync",
    receivedAt: now(),
    envelope: null,
    flags: [],
    messageId: "<one@example.com>",
    retentionPolicy: { mode: "from_capture", years: 10 },
    now,
    ...overrides,
  });
  return {
    primary,
    storage,
    keys,
    index,
    store,
    base,
    tick: (ms = 1000) => {
      clock += ms;
    },
  };
}

function refcounts(index: MemoryChunkIndex): number[] {
  return [...index.chunks.values()].map((chunk) => chunk.refcount);
}

describe("captureArchiveItem", () => {
  it("stores a new mail: chain, pinned chunks, row with body hash and mailbox", async () => {
    const f = fixture();
    const stored = await captureArchiveItem(
      f.base({ protectedObjectId: "obj-1", externalRef: "AAMk1" }),
    );
    expect(stored.outcome).toBe("stored");
    const record = (stored as { record: ArchiveItemRecord }).record;
    expect(record.prevChainHash).toBeNull();
    expect(record.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(f.store.items).toHaveLength(1);
    expect(f.store.items[0]).toMatchObject({
      protectedObjectId: "obj-1",
      externalRef: "AAMk1",
      messageId: "<one@example.com>",
      supersedesItemId: null,
    });
    expect(refcounts(f.index).every((count) => count === 1)).toBe(true);
    const reader = new ChunkReader({ storage: f.storage, keys: f.keys, index: f.index });
    const original = await readArchiveItemOriginal(reader, record);
    expect(original.toString()).toContain("Hello");
  });

  it("records a capture on the stronger item instead of a second item, uploading nothing", async () => {
    const f = fixture();
    const journal = await captureArchiveItem(
      f.base({
        source: "journal",
        original: mail("one@example.com", "Received: by transport\r\n", "Hello"),
        mailboxes: { addresses: ["alice@example.com"] },
      }),
    );
    const packsBefore = (await f.primary.list(`tenants/${TENANT}/packs/`)).length;
    f.tick();
    const mailbox = await captureArchiveItem(
      f.base({ source: "graph_sync", protectedObjectId: "obj-1", externalRef: "AAMk1" }),
    );
    expect(mailbox.outcome).toBe("duplicate");
    expect(mailbox).toMatchObject({ itemId: (journal as { record: ArchiveItemRecord }).record.id });
    expect(f.store.items).toHaveLength(1);
    expect(f.store.captures).toEqual([
      expect.objectContaining({
        archiveItemId: (journal as { record: ArchiveItemRecord }).record.id,
        source: "graph_sync",
        protectedObjectId: "obj-1",
        externalRef: "AAMk1",
      }),
    ]);
    expect(f.store.assignments.get((journal as { record: ArchiveItemRecord }).record.id)).toEqual(
      new Set(["address:alice@example.com", "obj-1"]),
    );
    // The duplicate's bytes never reached the pack store, and no reference was added.
    expect((await f.primary.list(`tenants/${TENANT}/packs/`)).length).toBe(packsBefore);
    expect(refcounts(f.index).every((count) => count === 1)).toBe(true);
  });

  it("supersedes a weaker capture with a new item that names it", async () => {
    const f = fixture();
    const first = await captureArchiveItem(f.base({ source: "imap_sync", protectedObjectId: "o" }));
    f.tick();
    const second = await captureArchiveItem(
      f.base({
        source: "smtp_forward",
        original: mail("one@example.com", "Delivered-To: a@example.com\r\n", "Hello"),
      }),
    );
    expect(second.outcome).toBe("stored");
    const firstId = (first as { record: ArchiveItemRecord }).record.id;
    const record = (second as { record: ArchiveItemRecord }).record;
    expect(record.supersedesItemId).toBe(firstId);
    expect(f.store.items[1]?.supersedesItemId).toBe(firstId);
    expect(record.prevChainHash).toBe((first as { record: ArchiveItemRecord }).record.chainHash);
  });

  it("keeps the same Message-ID with another body as its own item, flagged", async () => {
    const f = fixture();
    await captureArchiveItem(f.base({ source: "journal" }));
    const other = await captureArchiveItem(
      f.base({ source: "imap_sync", original: mail("one@example.com", "", "Something else") }),
    );
    expect(other.outcome).toBe("stored");
    expect((other as { record: ArchiveItemRecord }).record.flags).toContain("message-id-conflict");
  });

  it("stores every capture under the keep policy", async () => {
    const f = fixture();
    await captureArchiveItem(f.base({ source: "journal", duplicates: "keep" }));
    const again = await captureArchiveItem(f.base({ source: "journal", duplicates: "keep" }));
    expect(again.outcome).toBe("stored");
    expect(f.store.items).toHaveLength(2);
    expect(f.store.captures).toHaveLength(0);
  });

  it("keeps createdAt strictly increasing and the chain verifiable on one clock value", async () => {
    const f = fixture();
    // Concurrent captures of different mails, all at the same instant.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        captureArchiveItem(
          f.base({
            source: "imap_sync",
            original: mail(`m${n}@example.com`, "", `Body ${n}`),
            messageId: `m${n}@example.com`,
          }),
        ),
      ),
    );
    expect(results.every((result) => result.outcome === "stored")).toBe(true);
    const records = f.store.items.map((item) => item.record);
    for (let n = 1; n < records.length; n++) {
      const previous = records[n - 1] as ArchiveItemRecord;
      const current = records[n] as ArchiveItemRecord;
      expect(current.createdAt.getTime()).toBeGreaterThan(previous.createdAt.getTime());
      expect(current.prevChainHash).toBe(previous.chainHash);
    }
    expect(verifyChain(records).ok).toBe(true);
    const first = records[0] as ArchiveItemRecord;
    expect(first.chainHash).toBe(computeArchiveChainHash(null, first.itemHash, first.receivedAt));
  });

  it("applies the decision made under the lock, not the hint from before the upload", async () => {
    const f = fixture();
    // Two captures of one mail race: both see no candidate before uploading.
    const [a, b] = await Promise.all([
      captureArchiveItem(f.base({ source: "graph_sync", protectedObjectId: "o1" })),
      captureArchiveItem(f.base({ source: "graph_sync", protectedObjectId: "o2" })),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["duplicate", "stored"]);
    expect(f.store.items).toHaveLength(1);
    // The loser's chunks were stored but never referenced beyond the winner's single pin.
    expect(refcounts(f.index).every((count) => count === 1)).toBe(true);
  });
});
