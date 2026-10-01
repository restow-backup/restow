import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Dek } from "../crypto.js";
import { Keyring } from "../engine/keyring.js";
import { MemoryStorage } from "../verify/testing.js";
import {
  DEFAULT_SEGMENT_SIZE,
  MIN_SEGMENT_SIZE,
  SegmentLimitError,
  type SegmentScope,
  SegmentStore,
  clampSegmentSize,
  segmentKey,
  segmentPrefix,
  segmentRoot,
} from "./segments.js";

const TENANT = "0f0e0d0c-0b0a-4908-8706-050403020100";
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x42) };
const SEGMENT = MIN_SEGMENT_SIZE;

function fixture() {
  const storage = new MemoryStorage();
  const keys = new Keyring(TENANT, [dek]);
  const store = new SegmentStore({ storage, keys });
  const scope: SegmentScope = { tenantId: TENANT, kind: "staging", id: "upload-1" };
  return { storage, store, scope };
}

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) {
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}

describe("segment keys", () => {
  it("keeps staging and exports apart and refuses unsafe ids", () => {
    expect(segmentPrefix({ tenantId: TENANT, kind: "staging", id: "a" })).toBe(
      `tenants/${TENANT}/staging/a/`,
    );
    expect(segmentKey({ tenantId: TENANT, kind: "export", id: "b" }, 3)).toBe(
      `tenants/${TENANT}/exports/b/00000003.seg`,
    );
    expect(() => segmentPrefix({ tenantId: TENANT, kind: "staging", id: "../x" })).toThrow();
    expect(clampSegmentSize(undefined)).toBe(DEFAULT_SEGMENT_SIZE);
    expect(clampSegmentSize(1)).toBe(MIN_SEGMENT_SIZE);
  });
});

describe("SegmentStore", () => {
  it("stores segments encrypted and reads a file back with random access and as a stream", async () => {
    const { storage, store, scope } = fixture();
    const plain = randomBytes(SEGMENT * 3 + 1234);
    for (let index = 0; index * SEGMENT < plain.length; index++) {
      await store.put(scope, index, plain.subarray(index * SEGMENT, (index + 1) * SEGMENT));
    }
    const stored = await storage.get(segmentKey(scope, 0));
    expect(stored.includes(plain.subarray(0, 64))).toBe(false);

    const file = store.file(scope, { size: plain.length, segmentSize: SEGMENT }, "big.zip");
    expect(await file.read(SEGMENT - 10, 30)).toEqual(plain.subarray(SEGMENT - 10, SEGMENT + 20));
    expect(await file.read(plain.length - 5, 100)).toEqual(plain.subarray(plain.length - 5));
    expect(await file.read(plain.length, 10)).toHaveLength(0);
    expect(await collect(file.open())).toEqual(plain);
    expect(await store.indexes(scope)).toEqual([0, 1, 2, 3]);
  });

  it("refuses a segment that was moved to another position or upload", async () => {
    const { storage, store, scope } = fixture();
    await store.put(scope, 0, Buffer.from("zero"));
    await store.put(scope, 1, Buffer.from("one"));
    const moved = await storage.get(segmentKey(scope, 0));
    await storage.put(segmentKey(scope, 1), moved);
    await expect(store.get(scope, 1)).rejects.toThrow(/another position or upload/);

    const other: SegmentScope = { ...scope, id: "upload-2" };
    await storage.put(segmentKey(other, 0), moved);
    await expect(store.get(other, 0)).rejects.toThrow(/could not be opened/);
  });

  it("reports a damaged and a missing segment", async () => {
    const { storage, store, scope } = fixture();
    await store.put(scope, 0, Buffer.from("payload"));
    storage.flipByte(segmentKey(scope, 0), -3);
    await expect(store.get(scope, 0)).rejects.toThrow(/could not be opened/);
    await expect(store.get(scope, 5)).rejects.toThrow(/missing/);
  });

  it("writes a stream as segments and reads it back, including a resume offset", async () => {
    const { store } = fixture();
    const scope: SegmentScope = { tenantId: TENANT, kind: "export", id: "export-1" };
    const plain = randomBytes(SEGMENT * 2 + 77);
    const written = await store.writeStream(
      scope,
      Readable.from([
        plain.subarray(0, 100),
        plain.subarray(100, SEGMENT + 5),
        plain.subarray(SEGMENT + 5),
      ]),
      { segmentSize: SEGMENT },
    );
    expect(written).toMatchObject({ size: plain.length, segmentSize: SEGMENT, segments: 3 });
    const layout = { size: written.size, segmentSize: written.segmentSize };
    expect(await collect(store.readStream(scope, layout))).toEqual(plain);
    expect(await collect(store.readStream(scope, layout, SEGMENT + 9))).toEqual(
      plain.subarray(SEGMENT + 9),
    );
  });

  it("stops a stream that is longer than its limit and keeps nothing beyond the segment that crossed it", async () => {
    const { storage, store } = fixture();
    const scope: SegmentScope = { tenantId: TENANT, kind: "export", id: "export-2" };
    const plain = randomBytes(SEGMENT * 3);
    const source = Readable.from([
      plain.subarray(0, SEGMENT),
      plain.subarray(SEGMENT, SEGMENT * 2),
      plain.subarray(SEGMENT * 2),
    ]);
    await expect(
      store.writeStream(scope, source, { segmentSize: SEGMENT, maxBytes: SEGMENT + 10 }),
    ).rejects.toBeInstanceOf(SegmentLimitError);
    expect(source.destroyed).toBe(true);
    // Only whole segments written before the limit was crossed exist; nothing is left to clean up but them.
    expect((await storage.list(segmentPrefix(scope))).length).toBeLessThanOrEqual(1);
    await store.delete(scope);
    expect(await storage.list(segmentPrefix(scope))).toEqual([]);
    // A stream exactly at the limit is fine.
    const exact = await store.writeStream(scope, Readable.from([plain.subarray(0, SEGMENT)]), {
      segmentSize: SEGMENT,
      maxBytes: SEGMENT,
    });
    expect(exact.size).toBe(SEGMENT);
  });

  it("lists the scopes that hold segments, of one kind and one tenant", async () => {
    const { storage, store } = fixture();
    const other = "ffffffff-0b0a-4908-8706-050403020100";
    await store.put({ tenantId: TENANT, kind: "export", id: "e-1" }, 0, Buffer.from("a"));
    await store.put({ tenantId: TENANT, kind: "export", id: "e-1" }, 1, Buffer.from("b"));
    await store.put({ tenantId: TENANT, kind: "export", id: "e-2" }, 0, Buffer.from("c"));
    await store.put({ tenantId: TENANT, kind: "staging", id: "s-1" }, 0, Buffer.from("d"));
    await store.put({ tenantId: other, kind: "export", id: "x-1" }, 0, Buffer.from("e"));
    await storage.put(
      `${segmentRoot(TENANT, "export")}stray/notes.txt`,
      Buffer.from("not a segment"),
    );
    expect(await store.scopeIds(TENANT, "export")).toEqual(["e-1", "e-2"]);
    expect(await store.scopeIds(TENANT, "staging")).toEqual(["s-1"]);
    expect(await store.scopeIds(other, "export")).toEqual(["x-1"]);
    expect(await store.scopeIds(other, "staging")).toEqual([]);
  });

  it("deletes a scope", async () => {
    const { storage, store, scope } = fixture();
    await store.put(scope, 0, Buffer.from("a"));
    await store.put(scope, 1, Buffer.from("b"));
    expect(await store.delete(scope)).toBe(2);
    expect(await storage.list(segmentPrefix(scope))).toEqual([]);
  });
});
