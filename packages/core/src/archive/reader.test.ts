import { describe, expect, it } from "vitest";
import type { Dek } from "../crypto.js";
import { Keyring } from "../engine/keyring.js";
import { MemoryChunkIndex } from "../engine/memory.js";
import type { StorageTargets } from "../engine/types.js";
import { MemoryStorage } from "../verify/testing.js";
import { sealArchiveItem } from "./format.js";
import { archiveItemKey } from "./layout.js";
import { loadArchiveItem } from "./reader.js";
import type { ArchiveItemRecord } from "./types.js";
import { writeArchiveItem } from "./writer.js";

const TENANT = "33333333-4444-4555-8666-777777777777";
const DEK: Dek = { version: 1, material: Buffer.alloc(32, 0x21) };

function fixture() {
  const primary = new MemoryStorage();
  const storage: StorageTargets = { primary, copies: [] };
  const keys = new Keyring(TENANT, [DEK]);
  const index = new MemoryChunkIndex();
  return { primary, storage, keys, index };
}

describe("loadArchiveItem", () => {
  it("reads back an item written by writeArchiveItem, with no other state (the standalone-restore path)", async () => {
    const { storage, keys, index } = fixture();
    const receivedAt = new Date("2026-05-01T00:00:00.000Z");
    const written = await writeArchiveItem({
      tenantId: TENANT,
      itemId: "item-a",
      storage,
      keys,
      index,
      original: Buffer.from("standalone restore fixture"),
      receivedAt,
      envelope: {
        sender: "a@example.com",
        subject: "hi",
        messageId: "<1@example.com>",
        onBehalfOf: null,
        recipients: [{ address: "b@example.com", type: "to" }],
      },
      flags: [],
      source: "journal",
      retentionPolicy: { mode: "from_capture", years: 6 },
      prevChainHash: null,
    });

    // A fresh Keyring with the same key material, standing in for the
    // standalone tool's own loaded key -- not the same object instance.
    const freshKeys = new Keyring(TENANT, [DEK]);
    const loaded = await loadArchiveItem(storage, freshKeys, TENANT, receivedAt, "item-a");

    expect(loaded.id).toBe(written.id);
    expect(loaded.itemHash).toBe(written.itemHash);
    expect(loaded.chainHash).toBe(written.chainHash);
    expect(loaded.chunks).toEqual(written.chunks);
    expect(loaded.envelope).toEqual(written.envelope);
    expect(loaded.receivedAt.getTime()).toBe(written.receivedAt.getTime());
    expect(loaded.retentionUntil?.getTime()).toBe(written.retentionUntil?.getTime());
  });

  it("refuses a record whose sealed content was moved to a different key", async () => {
    const { storage, keys } = fixture();
    const receivedAt = new Date("2026-05-01T00:00:00.000Z");
    const record: ArchiveItemRecord = {
      id: "item-a",
      tenantId: TENANT,
      receivedAt,
      itemHash: "a".repeat(64),
      prevChainHash: null,
      chainHash: "b".repeat(64),
      size: 1,
      chunks: ["c".repeat(64)],
      envelope: null,
      flags: [],
      source: "journal",
      legalHold: false,
      retentionUntil: null,
      createdAt: receivedAt,
    };
    const correctKey = archiveItemKey(TENANT, receivedAt, "item-a");
    const sealed = sealArchiveItem(record, keys.current, correctKey);

    // Written under a different item id's key -- as if a bucket copy or a
    // storage-admin renamed the object.
    const wrongKey = archiveItemKey(TENANT, receivedAt, "item-b");
    await storage.primary.put(wrongKey, sealed);

    await expect(loadArchiveItem(storage, keys, TENANT, receivedAt, "item-b")).rejects.toThrow();
  });
});
