import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { archiveItemKey } from "../archive/layout.js";
import { sha256 } from "../crypto.js";
import { JobAbortedError } from "../engine/chunkstore.js";
import { manifestKey, packKey, partialManifestKey, wrappedKeyKey } from "../engine/layout.js";
import { MemoryStorage } from "../verify/testing.js";
import type { PutOptions } from "./backend.js";
import {
  ARCHIVE_MIRROR_PAGE,
  type ArchiveRecordCatalog,
  type ArchiveRecordEntry,
  type ArchiveRecordRetention,
  checkCopyCompleteness,
  checkSourceExclusiveObjects,
  destinationObjectKeys,
  type MirrorItem,
  mirrorObjects,
  mirrorTenantStorage,
  packMirrorItems,
  readOnlyFallbackChain,
  withReadOnlyFallback,
} from "./copy.js";

const TENANT = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b0a";
const AT = new Date("2026-09-01T10:00:00.000Z");

function bytes(label: string, size = 64): Buffer {
  return Buffer.alloc(size, label);
}

function hex(data: Buffer): string {
  return sha256(data).toString("hex");
}

/** A primary holding packs, a manifest, a partial manifest and a wrapped key. */
async function seededPrimary() {
  const primary = new MemoryStorage(() => AT);
  const packs = ["aa11", "bb22", "cc33"].map((id, index) => {
    const data = bytes(id, 100 + index);
    return { id, path: packKey(TENANT, id), size: data.length, sha256: hex(data), data };
  });
  for (const pack of packs) {
    await primary.put(pack.path, pack.data);
  }
  await primary.put(manifestKey(TENANT, "snap-1"), bytes("manifest"));
  await primary.put(partialManifestKey(TENANT, "snap-2"), bytes("partial"));
  await primary.put(wrappedKeyKey(TENANT, 1), bytes("wrapped-dek", 60));
  return { primary, packs };
}

/** A memory target that remembers the retention each object was written with (an Object Lock bucket). */
class LockingStorage extends MemoryStorage {
  readonly retainedUntil = new Map<string, Date | undefined>();

  override async put(key: string, data: Buffer | Readable, options?: PutOptions): Promise<void> {
    this.retainedUntil.set(key, options?.retainUntil);
    await super.put(key, data);
  }
}

const ITEM_KEPT = "0b6f6a8e-3f0c-4c55-9d43-1b8f0f6c1a01";
const ITEM_HELD = "0b6f6a8e-3f0c-4c55-9d43-1b8f0f6c1a02";
const ITEM_DELETED = "0b6f6a8e-3f0c-4c55-9d43-1b8f0f6c1a03";
const RETAIN = new Date("2035-01-01T00:00:00.000Z");

/** A primary with sealed archive records: two items the catalog holds, one it deleted. */
async function archivePrimary() {
  const { primary, packs } = await seededPrimary();
  const received = new Date("2026-03-01T10:00:00.000Z");
  const records = [ITEM_KEPT, ITEM_HELD, ITEM_DELETED].map((id) =>
    archiveItemKey(TENANT, received, id),
  );
  for (const key of records) {
    await primary.put(key, bytes(`record ${key}`, 80));
  }
  const catalog = new Map<string, Date | null>([
    [ITEM_KEPT, RETAIN],
    [ITEM_HELD, null],
  ]);
  const lookups: string[][] = [];
  const retention: ArchiveRecordRetention = async (ids) => {
    lookups.push([...ids]);
    return new Map(ids.flatMap((id) => (catalog.has(id) ? [[id, catalog.get(id) ?? null]] : [])));
  };
  return { primary, packs, records, retention, lookups };
}

describe("mirrorObjects", () => {
  it("copies what is missing, verifies it and is idempotent", async () => {
    const { primary, packs } = await seededPrimary();
    const copy = new MemoryStorage();
    const items = packMirrorItems(packs);

    const first = await mirrorObjects({ source: primary, target: copy, items, now: () => AT });
    expect(first).toMatchObject({
      total: 3,
      copied: 3,
      present: 0,
      failed: 0,
      complete: true,
      bytesWritten: 100 + 101 + 102,
    });
    for (const pack of packs) {
      expect((await copy.get(pack.path)).equals(pack.data)).toBe(true);
    }

    const second = await mirrorObjects({ source: primary, target: copy, items });
    expect(second).toMatchObject({ present: 3, copied: 0, bytesWritten: 0, complete: true });
  });

  it("repairs a truncated copy (size check) and bit rot (hash check)", async () => {
    const { primary, packs } = await seededPrimary();
    const copy = new MemoryStorage();
    const items = packMirrorItems(packs);
    await mirrorObjects({ source: primary, target: copy, items });

    const [first, second] = packs;
    if (!first || !second) throw new Error("fixture");
    await copy.put(first.path, first.data.subarray(0, 10));
    copy.flipByte(second.path, 5);

    const bySize = await mirrorObjects({ source: primary, target: copy, items, verify: "size" });
    expect(bySize).toMatchObject({ repaired: 1, present: 2 });
    expect((await copy.get(first.path)).equals(first.data)).toBe(true);
    // Same size, different bytes: only the deep check notices.
    expect((await copy.get(second.path)).equals(second.data)).toBe(false);

    const byHash = await mirrorObjects({ source: primary, target: copy, items, verify: "hash" });
    expect(byHash).toMatchObject({ repaired: 1, present: 2, complete: true });
    expect((await copy.get(second.path)).equals(second.data)).toBe(true);
  });

  it("never spreads a corrupt primary to the copy", async () => {
    const { primary, packs } = await seededPrimary();
    const copy = new MemoryStorage();
    const [pack] = packs;
    if (!pack) throw new Error("fixture");
    primary.flipByte(pack.path, 0);

    const report = await mirrorObjects({
      source: primary,
      target: copy,
      items: packMirrorItems(packs),
    });
    expect(report).toMatchObject({ copied: 2, failed: 1, complete: false });
    expect(report.problems).toEqual([
      expect.objectContaining({ key: pack.path, outcome: "source_corrupt", bytesWritten: 0 }),
    ]);
    expect(await copy.head(pack.path)).toBeNull();
  });

  it("reports objects the primary lost", async () => {
    const primary = new MemoryStorage();
    const copy = new MemoryStorage();
    const item: MirrorItem = { key: packKey(TENANT, "dd44"), size: 10, sha256: "00" };
    const report = await mirrorObjects({ source: primary, target: copy, items: [item] });
    expect(report.problems).toEqual([expect.objectContaining({ outcome: "source_missing" })]);
  });

  it("flags a copy that does not keep what was written", async () => {
    const { primary, packs } = await seededPrimary();
    const copy = new MemoryStorage();
    const original = copy.get.bind(copy);
    copy.get = async (key) => {
      const data = await original(key);
      data[0] = (data[0] ?? 0) ^ 0x01;
      return data;
    };
    const report = await mirrorObjects({
      source: primary,
      target: copy,
      items: packMirrorItems(packs),
    });
    expect(report.failed).toBe(3);
    expect(report.problems.every((problem) => problem.outcome === "verify_failed")).toBe(true);
  });

  it("reports write failures and caps the problem list", async () => {
    const { primary, packs } = await seededPrimary();
    const copy = new MemoryStorage();
    copy.put = async () => {
      throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
    };
    const report = await mirrorObjects({
      source: primary,
      target: copy,
      items: packMirrorItems(packs),
      maxReportedProblems: 2,
    });
    expect(report).toMatchObject({ failed: 3, problemsOmitted: 1 });
    expect(report.problems).toHaveLength(2);
    expect(report.problems[0]?.detail).toContain("No space left on device");
  });

  it("stops between objects when cancelled", async () => {
    const { primary, packs } = await seededPrimary();
    const controller = new AbortController();
    controller.abort();
    await expect(
      mirrorObjects({
        source: primary,
        target: new MemoryStorage(),
        items: packMirrorItems(packs),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(JobAbortedError);
  });

  it("reports progress per object", async () => {
    const { primary, packs } = await seededPrimary();
    const advanced: number[] = [];
    const failed: string[] = [];
    const progress = {
      total: () => {},
      advance: (_done = 1, bytesDone = 0) => {
        advanced.push(bytesDone);
      },
      fail: (itemRef: string) => {
        failed.push(itemRef);
      },
      phase: () => {},
      snapshot: () => ({ total: 0, done: 0, failed: 0, bytes: 0, phase: null, etaSeconds: null }),
      flush: async () => {},
    };
    await mirrorObjects({
      source: primary,
      target: new MemoryStorage(),
      items: packMirrorItems(packs),
      progress,
      concurrency: 1,
    });
    expect(advanced).toEqual([100, 101, 102]);
    expect(failed).toEqual([]);
  });
});

describe("mirrorTenantStorage", () => {
  it("mirrors keys, committed manifests and packs onto every copy", async () => {
    const { primary, packs } = await seededPrimary();
    const copyA = new MemoryStorage();
    const copyB = new MemoryStorage();
    const report = await mirrorTenantStorage({
      tenantId: TENANT,
      storage: { primary, copies: [copyA, copyB] },
      packs,
    });
    expect(report.complete).toBe(true);
    expect(report.copies.map((copy) => copy.copied)).toEqual([5, 5]);
    for (const copy of [copyA, copyB]) {
      expect(await copy.head(wrappedKeyKey(TENANT, 1))).not.toBeNull();
      expect(await copy.head(manifestKey(TENANT, "snap-1"))).not.toBeNull();
      expect(await copy.head(partialManifestKey(TENANT, "snap-2"))).toBeNull();
    }
  });

  it("mirrors sealed archive records with their retention, not those of deleted items", async () => {
    const { primary, packs, records, retention } = await archivePrimary();
    const copy = new LockingStorage();
    const report = await mirrorTenantStorage({
      tenantId: TENANT,
      storage: { primary, copies: [copy] },
      packs,
      archiveRetention: retention,
    });
    expect(report.complete).toBe(true);
    const [kept, held, deleted] = records as [string, string, string];
    expect((await copy.get(kept)).equals(await primary.get(kept))).toBe(true);
    expect(copy.retainedUntil.get(kept)).toEqual(RETAIN);
    expect(await copy.head(held)).not.toBeNull();
    expect(copy.retainedUntil.get(held)).toBeUndefined();
    expect(await copy.head(deleted)).toBeNull();

    // A second run finds them present (verified by hash in a full run).
    const again = await mirrorTenantStorage({
      tenantId: TENANT,
      storage: { primary, copies: [copy] },
      packs,
      archiveRetention: retention,
      verify: "hash",
    });
    expect(again.copies[0]).toMatchObject({ copied: 0, repaired: 0, failed: 0 });
  });

  it("mirrors archive records from the catalog in pages, a scheduled run only the new ones", async () => {
    const { primary, packs } = await seededPrimary();
    const count = 2 * ARCHIVE_MIRROR_PAGE + 17;
    const entries: ArchiveRecordEntry[] = [];
    for (let n = 0; n < count; n++) {
      const id = `0b6f6a8e-3f0c-4c55-9d43-${String(n).padStart(12, "0")}`;
      const key = archiveItemKey(TENANT, new Date("2026-03-01T10:00:00.000Z"), id);
      await primary.put(key, bytes(`record ${n}`, 40));
      entries.push({
        key,
        position: { createdAt: `2026-03-01 10:00:${String(n % 60).padStart(2, "0")}.${n}`, id },
        retainUntil: RETAIN,
      });
    }
    const pages: number[] = [];
    const catalog: ArchiveRecordCatalog = {
      async page(after, _before, limit) {
        const start = after ? entries.findIndex((e) => e.position.id === after.id) + 1 : 0;
        const page = entries.slice(start, start + limit);
        pages.push(page.length);
        return page;
      },
    };
    const listed: string[] = [];
    const listing = Object.assign(Object.create(primary) as MemoryStorage, {
      list: async (prefix: string) => {
        listed.push(prefix);
        return primary.list(prefix);
      },
    });
    const copy = new LockingStorage();
    const heads: string[] = [];
    const head = copy.head.bind(copy);
    copy.head = async (key: string) => {
      heads.push(key);
      return head(key);
    };
    const first = await mirrorTenantStorage({
      tenantId: TENANT,
      storage: { primary: listing, copies: [copy] },
      packs,
      archiveRecords: { catalog, after: null, before: new Date() },
    });
    expect(first.complete).toBe(true);
    expect(first.archiveThrough).toEqual(entries.at(-1)?.position);
    expect(copy.retainedUntil.get(entries[5]?.key as string)).toEqual(RETAIN);
    // Never a listing of the archive prefix, and pages no larger than one batch.
    expect(listed.some((prefix) => prefix.includes("/archive"))).toBe(false);
    expect(Math.max(...pages)).toBeLessThanOrEqual(ARCHIVE_MIRROR_PAGE);

    // Ten new records: a scheduled run from the position looks at those only.
    for (let n = count; n < count + 10; n++) {
      const id = `0b6f6a8e-3f0c-4c55-9d43-${String(n).padStart(12, "0")}`;
      const key = archiveItemKey(TENANT, new Date("2026-03-02T10:00:00.000Z"), id);
      await primary.put(key, bytes(`record ${n}`, 40));
      entries.push({
        key,
        position: { createdAt: `2026-03-02 10:00:00.${n}`, id },
        retainUntil: null,
      });
    }
    heads.length = 0;
    const next = await mirrorTenantStorage({
      tenantId: TENANT,
      storage: { primary: listing, copies: [copy] },
      packs: [],
      archiveRecords: { catalog, after: first.archiveThrough ?? null, before: new Date() },
    });
    expect(next.copies[0]).toMatchObject({ copied: 10, failed: 0 });
    expect(heads.filter((key) => key.includes("/archive/"))).toHaveLength(10);
    expect(next.archiveThrough).toEqual(entries.at(-1)?.position);
  });

  it("keeps the archive position before a record a copy did not take", async () => {
    const { primary, packs } = await seededPrimary();
    const ids = ["0b6f6a8e-3f0c-4c55-9d43-000000000001", "0b6f6a8e-3f0c-4c55-9d43-000000000002"];
    const entries = ids.map((id, n) => ({
      key: archiveItemKey(TENANT, new Date("2026-03-01T10:00:00.000Z"), id),
      position: { createdAt: `2026-03-01 10:00:0${n}`, id },
      retainUntil: null,
    }));
    // The second record is missing on the primary: it cannot reach the copy.
    await primary.put(entries[0]?.key as string, bytes("record 0", 40));
    const start = { createdAt: "2026-02-01 00:00:00", id: "0b6f6a8e-3f0c-4c55-9d43-000000000000" };
    const report = await mirrorTenantStorage({
      tenantId: TENANT,
      storage: { primary, copies: [new MemoryStorage()] },
      packs,
      archiveRecords: {
        catalog: { page: async (after) => (after === start ? entries : []) },
        after: start,
        before: new Date(),
      },
    });
    expect(report.complete).toBe(false);
    expect(report.archiveThrough).toEqual(start);
  });

  it("does nothing without copies", async () => {
    const { primary, packs } = await seededPrimary();
    expect(
      await mirrorTenantStorage({ tenantId: TENANT, storage: { primary, copies: [] }, packs }),
    ).toEqual({ copies: [], complete: true });
  });
});

describe("checkCopyCompleteness", () => {
  it("compares listings and counts missing bytes", async () => {
    const { primary, packs } = await seededPrimary();
    const copy = new MemoryStorage();
    const [first] = packs;
    if (!first) throw new Error("fixture");
    await copy.put(first.path, first.data);
    await copy.put(wrappedKeyKey(TENANT, 1), bytes("wrapped-dek", 60));

    const partial = await checkCopyCompleteness({
      tenantId: TENANT,
      source: primary,
      target: copy,
      packs,
      now: () => AT,
    });
    expect(partial).toEqual({
      complete: false,
      packs: { expected: 3, present: 1, bytesExpected: 303, bytesMissing: 203 },
      manifests: { expected: 1, present: 0 },
      keys: { expected: 1, present: 1 },
      archive: { expected: 0, present: 0 },
      missingSample: [
        manifestKey(TENANT, "snap-1"),
        packKey(TENANT, "bb22"),
        packKey(TENANT, "cc33"),
      ],
      checkedAt: AT.toISOString(),
    });

    await mirrorTenantStorage({ tenantId: TENANT, storage: { primary, copies: [copy] }, packs });
    const complete = await checkCopyCompleteness({
      tenantId: TENANT,
      source: primary,
      target: copy,
      packs,
    });
    expect(complete.complete).toBe(true);
    expect(complete.packs.bytesMissing).toBe(0);
  });
  it("counts sealed archive records, not those of items the catalog deleted", async () => {
    const { primary, packs, records, retention } = await archivePrimary();
    const copy = new MemoryStorage();
    const before = await checkCopyCompleteness({
      tenantId: TENANT,
      source: primary,
      target: copy,
      packs,
      archiveRetention: retention,
    });
    expect(before.archive).toEqual({ expected: 2, present: 0 });
    expect(before.missingSample).toEqual(expect.arrayContaining(records.slice(0, 2)));
    expect(before.missingSample).not.toContain(records[2]);

    await mirrorTenantStorage({
      tenantId: TENANT,
      storage: { primary, copies: [copy] },
      packs,
      archiveRetention: retention,
    });
    const after = await checkCopyCompleteness({
      tenantId: TENANT,
      source: primary,
      target: copy,
      packs,
      archiveRetention: retention,
    });
    expect(after.archive).toEqual({ expected: 2, present: 2 });
    expect(after.complete).toBe(true);
  });
});

describe("destinationObjectKeys", () => {
  it("lists every pack, manifest and wrapped key a target holds for a tenant, never another tenant's", async () => {
    const { primary, packs } = await seededPrimary();
    await primary.put(packKey("another-tenant", "dd44"), bytes("dd44", 50));

    const keys = await destinationObjectKeys(TENANT, primary);
    for (const pack of packs) {
      expect(keys.has(pack.path)).toBe(true);
    }
    expect(keys.has(manifestKey(TENANT, "snap-1"))).toBe(true);
    expect(keys.has(wrappedKeyKey(TENANT, 1))).toBe(true);
    expect(keys.has(packKey("another-tenant", "dd44"))).toBe(false);
  });

  it("lists the sealed archive records too (a resumed migration must not skip one)", async () => {
    const { primary, records } = await archivePrimary();
    const keys = await destinationObjectKeys(TENANT, primary);
    for (const key of records) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it("is empty for a target that holds nothing of the tenant yet", async () => {
    const empty = new MemoryStorage();
    expect((await destinationObjectKeys(TENANT, empty)).size).toBe(0);
  });
});

describe("readOnlyFallbackChain", () => {
  it("reads from the first backend that has the key, and never writes", async () => {
    const first = new MemoryStorage();
    const second = new MemoryStorage();
    await second.put("only-on-second", bytes("s"));
    await first.put("shared", bytes("first-copy"));
    await second.put("shared", bytes("second-copy"));
    const chain = readOnlyFallbackChain([first, second]);

    expect(await chain.get("only-on-second")).toEqual(bytes("s"));
    expect(await chain.get("shared")).toEqual(bytes("first-copy"));
    expect(await chain.head("only-on-second")).not.toBeNull();
    expect(await chain.head("missing-everywhere")).toBeNull();
    await expect(chain.put("x", bytes("y"))).rejects.toThrow(/read-only/);
    await expect(chain.delete("x")).rejects.toThrow(/read-only/);
  });

  it("throws when constructed with no backends", () => {
    expect(() => readOnlyFallbackChain([])).toThrow(/at least one backend/);
  });

  it("merges every backend's listing instead of stopping at the first non-empty one", async () => {
    // The bug this guards against: a "move" that follows an earlier "keep"
    // must still see a manifest that exists only on the retired "previous"
    // target, even though the current primary already has manifests of its
    // own (a "first non-empty" listing would stop there and never look
    // further, see copy.ts's doc comment).
    const primary = new MemoryStorage();
    const previous = new MemoryStorage();
    await primary.put("manifests/new.json", bytes("new"));
    await previous.put("manifests/legacy.json", bytes("legacy"));
    await previous.put("manifests/new.json", bytes("stale-duplicate"));
    const chain = readOnlyFallbackChain([primary, previous]);

    const listed = await chain.list("manifests/");
    expect(listed).toEqual(["manifests/legacy.json", "manifests/new.json"]);
  });
});

describe("withReadOnlyFallback", () => {
  it("returns the primary unwrapped when there is nothing to fall back to", () => {
    const primary = new MemoryStorage();
    expect(withReadOnlyFallback(primary, [])).toBe(primary);
  });

  it("reads through to a previous target when the primary misses, and never writes to it", async () => {
    const primary = new MemoryStorage();
    const previous = new MemoryStorage();
    await previous.put("only-on-previous", bytes("legacy"));
    await primary.put("shared", bytes("current"));
    await previous.put("shared", bytes("stale"));
    const wrapped = withReadOnlyFallback(primary, [previous]);

    // Found only on the retired target: still readable through the wrapper.
    expect(await wrapped.get("only-on-previous")).toEqual(bytes("legacy"));
    expect((await wrapped.head("only-on-previous"))?.size).toBe(64);
    // Present on both: the current primary wins.
    expect(await wrapped.get("shared")).toEqual(bytes("current"));
    // Nowhere at all: still reports missing, not an error.
    expect(await wrapped.head("missing-everywhere")).toBeNull();

    await wrapped.put("new-key", bytes("written"));
    expect(await primary.get("new-key")).toEqual(bytes("written"));
    await expect(previous.get("new-key")).rejects.toThrow();

    await wrapped.delete("shared");
    await expect(primary.get("shared")).rejects.toThrow();
    // The previous target is untouched by the delete of the current primary.
    expect(await previous.get("shared")).toEqual(bytes("stale"));
  });

  it("falls back through several previous targets in order", async () => {
    const primary = new MemoryStorage();
    const first = new MemoryStorage();
    const second = new MemoryStorage();
    await second.put("only-on-second", bytes("oldest"));
    const wrapped = withReadOnlyFallback(primary, [first, second]);
    expect(await wrapped.get("only-on-second")).toEqual(bytes("oldest"));
  });

  it("only ever lists the primary, never merging a previous target's listing", async () => {
    const primary = new MemoryStorage();
    const previous = new MemoryStorage();
    await primary.put("manifests/new.json", bytes("new"));
    await previous.put("manifests/legacy.json", bytes("legacy"));
    const wrapped = withReadOnlyFallback(primary, [previous]);
    expect(await wrapped.list("manifests/")).toEqual(["manifests/new.json"]);
  });
});

describe("checkSourceExclusiveObjects", () => {
  it("reports keys the source holds that no other backend has", async () => {
    const previous = new MemoryStorage();
    const primary = new MemoryStorage();
    await previous.put("packs/shared", bytes("shared"));
    await previous.put("packs/legacy-only", bytes("legacy"));
    await primary.put("packs/shared", bytes("shared"));

    const check = await checkSourceExclusiveObjects({
      source: previous,
      others: [primary],
      prefix: "packs/",
    });
    expect(check.exclusive).toBe(true);
    expect(check.exclusiveKeys).toEqual(["packs/legacy-only"]);
    expect(check.exclusiveKeysOmitted).toBe(0);
  });

  it("finds nothing exclusive once every key of the source also exists elsewhere", async () => {
    const previous = new MemoryStorage();
    const primary = new MemoryStorage();
    await previous.put("packs/moved", bytes("moved"));
    await primary.put("packs/moved", bytes("moved"));

    const check = await checkSourceExclusiveObjects({
      source: previous,
      others: [primary],
      prefix: "packs/",
    });
    expect(check.exclusive).toBe(false);
    expect(check.exclusiveKeys).toEqual([]);
  });

  it("checks against every other backend, not only the first", async () => {
    const previous = new MemoryStorage();
    const primary = new MemoryStorage();
    const copy = new MemoryStorage();
    await previous.put("packs/on-copy-only", bytes("x"));
    await copy.put("packs/on-copy-only", bytes("x"));

    const check = await checkSourceExclusiveObjects({
      source: previous,
      others: [primary, copy],
      prefix: "packs/",
    });
    expect(check.exclusive).toBe(false);
  });

  it("caps the reported keys and counts the rest as omitted", async () => {
    const previous = new MemoryStorage();
    for (let i = 0; i < 5; i++) {
      await previous.put(`packs/only-${i}`, bytes(String(i)));
    }
    const check = await checkSourceExclusiveObjects({
      source: previous,
      others: [],
      prefix: "packs/",
      maxReportedKeys: 2,
    });
    expect(check.exclusive).toBe(true);
    expect(check.exclusiveKeys).toHaveLength(2);
    expect(check.exclusiveKeysOmitted).toBe(3);
  });

  it("drops keys isLive rejects before comparing, so garbage nothing references is never exclusive", async () => {
    const previous = new MemoryStorage();
    await previous.put("manifests/still-needed.json.zst", bytes("live"));
    await previous.put("manifests/already-pruned.json.zst", bytes("garbage"));

    const check = await checkSourceExclusiveObjects({
      source: previous,
      others: [],
      prefix: "manifests/",
      isLive: (key) => key === "manifests/still-needed.json.zst",
    });
    expect(check.exclusive).toBe(true);
    expect(check.exclusiveKeys).toEqual(["manifests/still-needed.json.zst"]);
  });

  it("reports nothing exclusive once isLive rejects every key on the source", async () => {
    const previous = new MemoryStorage();
    await previous.put("manifests/abandoned.partial", bytes("checkpoint"));

    const check = await checkSourceExclusiveObjects({
      source: previous,
      others: [],
      prefix: "manifests/",
      isLive: () => false,
    });
    expect(check.exclusive).toBe(false);
    expect(check.exclusiveKeys).toEqual([]);
  });
});
