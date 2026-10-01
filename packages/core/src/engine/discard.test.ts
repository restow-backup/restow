import { describe, expect, it } from "vitest";
import type { Dek } from "../crypto.js";
import { MemoryStorage } from "../verify/testing.js";
import { deleteOnAllTargets, discardUncommittedSnapshot } from "./discard.js";
import { Keyring } from "./keyring.js";
import { manifestKey, partialManifestKey } from "./layout.js";
import { noopLogger } from "./logger.js";
import {
  MemoryChunkIndex,
  MemoryCursorStore,
  MemorySnapshotIndex,
  createMemoryJobContext,
} from "./memory.js";
import { SnapshotWriter } from "./snapshot.js";
import type { JobContext, ProtectedObjectRef, StorageTargets } from "./types.js";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000002";
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x19) };
const mailbox: ProtectedObjectRef = {
  id: "po-1",
  tenantId: TENANT,
  sourceId: "src-1",
  kind: "mailbox",
  externalId: "alice@example.test",
  displayName: "Alice",
  userId: null,
};

function setup() {
  const primary = new MemoryStorage();
  const copy = new MemoryStorage();
  const storage: StorageTargets = { primary, copies: [copy] };
  const snapshots = new MemorySnapshotIndex(TENANT);
  const chunkIndex = new MemoryChunkIndex();
  let next = 1;
  const context = (jobId = "job-1"): JobContext =>
    createMemoryJobContext({
      tenantId: TENANT,
      keys: new Keyring(TENANT, [dek]),
      storage,
      chunkIndex,
      snapshots,
      cursor: new MemoryCursorStore(),
      jobId,
      now: () => new Date("2026-09-23T10:00:00Z"),
    });
  const begin = (
    ctx: JobContext,
    checkpoint?: Parameters<typeof SnapshotWriter.begin>[1]["checkpoint"],
  ) =>
    SnapshotWriter.begin(ctx, {
      protectedObject: mailbox,
      sourceType: "m365",
      checkpoint,
      snapshotIdGenerator: () => `snap-${next++}`,
    });
  const env = { tenantId: TENANT, storage, snapshots, logger: noopLogger };
  return { primary, copy, storage, snapshots, context, begin, env };
}

async function onEveryTarget(targets: MemoryStorage[], key: string): Promise<boolean[]> {
  return Promise.all(targets.map(async (target) => (await target.head(key)) !== null));
}

describe("discardUncommittedSnapshot", () => {
  it("removes an in-progress snapshot: partial, a failed commit's manifest and the row", async () => {
    const t = setup();
    const writer = await t.begin(t.context());
    const one = await writer.chunks.write(Buffer.from("first item"));
    writer.add({ path: "one", size: one.size, mtime: 1, chunks: one.chunks });
    const checkpoint = await writer.checkpoint();
    // A commit that wrote the manifest everywhere but never completed the row.
    const finalKey = manifestKey(TENANT, writer.snapshotId);
    await t.primary.put(finalKey, Buffer.from("left by a failed commit"));
    await t.copy.put(finalKey, Buffer.from("left by a failed commit"));

    expect(await discardUncommittedSnapshot(t.env, writer.snapshotId)).toBe("discarded");
    expect(await t.snapshots.get(writer.snapshotId)).toBeNull();
    expect(await onEveryTarget([t.primary, t.copy], checkpoint.partialKey)).toEqual([false, false]);
    expect(await onEveryTarget([t.primary, t.copy], finalKey)).toEqual([false, false]);
    // Packs stay: garbage collection decides about them.
    expect((await t.primary.list(`tenants/${TENANT}/packs/`)).length).toBeGreaterThan(0);
  });

  it("keeps a committed snapshot and removes only a leftover partial", async () => {
    const t = setup();
    const writer = await t.begin(t.context());
    const committed = await writer.commit();
    const partialKey = partialManifestKey(TENANT, writer.snapshotId);
    await t.primary.put(partialKey, Buffer.from("leftover"));

    expect(await discardUncommittedSnapshot(t.env, writer.snapshotId)).toBe("committed");
    expect((await t.snapshots.get(writer.snapshotId))?.manifestPath).toBe(committed.manifestPath);
    expect(await t.primary.head(committed.manifestPath)).not.toBeNull();
    expect(await t.primary.head(partialKey)).toBeNull();
  });

  it("removes the partial of a snapshot whose row is gone", async () => {
    const t = setup();
    const partialKey = partialManifestKey(TENANT, "snap-gone");
    await t.primary.put(partialKey, Buffer.from("orphaned checkpoint"));
    expect(await discardUncommittedSnapshot(t.env, "snap-gone")).toBe("missing");
    expect(await t.primary.head(partialKey)).toBeNull();
  });

  it("never throws for a target that cannot delete, and still deletes on the others", async () => {
    const t = setup();
    const key = partialManifestKey(TENANT, "snap-x");
    await t.primary.put(key, Buffer.from("a"));
    await t.copy.put(key, Buffer.from("a"));
    t.copy.delete = async () => {
      throw new Error("copy target is read-only");
    };
    expect(await deleteOnAllTargets(t.storage, key, noopLogger)).toBe(false);
    expect(await t.primary.head(key)).toBeNull();
  });
});

describe("SnapshotWriter cleans up the checkpoints it gives up on", () => {
  it("drops an unreadable checkpoint and its row before starting over", async () => {
    const t = setup();
    const writer = await t.begin(t.context());
    const checkpoint = await writer.checkpoint();
    // Truncated by an interrupted write.
    await t.primary.put(checkpoint.partialKey, Buffer.from([0x03, 0x28, 0xb5]));
    await t.copy.put(checkpoint.partialKey, Buffer.from([0x03, 0x28, 0xb5]));

    const fresh = await t.begin(t.context(), checkpoint);
    expect(fresh.snapshotId).not.toBe(checkpoint.snapshotId);
    expect(await t.snapshots.get(checkpoint.snapshotId)).toBeNull();
    expect(await onEveryTarget([t.primary, t.copy], checkpoint.partialKey)).toEqual([false, false]);
    // The fresh snapshot is the only one in progress, and it commits normally.
    const committed = await fresh.commit();
    expect(committed.snapshotId).toBe(fresh.snapshotId);
  });

  it("removes a leftover partial when the checkpointed snapshot was committed meanwhile", async () => {
    const t = setup();
    const writer = await t.begin(t.context());
    const checkpoint = await writer.checkpoint();
    const committed = await writer.commit();
    await t.primary.put(checkpoint.partialKey, Buffer.from("leftover"));

    const fresh = await t.begin(t.context(), checkpoint);
    expect(fresh.snapshotId).not.toBe(checkpoint.snapshotId);
    expect(await t.primary.head(checkpoint.partialKey)).toBeNull();
    expect((await t.snapshots.get(checkpoint.snapshotId))?.manifestPath).toBe(
      committed.manifestPath,
    );
  });

  it("removes the partial of a checkpoint whose row is gone", async () => {
    const t = setup();
    const writer = await t.begin(t.context());
    const checkpoint = await writer.checkpoint();
    t.snapshots.rows.delete(checkpoint.snapshotId);

    await t.begin(t.context(), checkpoint);
    expect(await onEveryTarget([t.primary, t.copy], checkpoint.partialKey)).toEqual([false, false]);
  });

  it("abort also removes a final manifest a failed commit left behind", async () => {
    const t = setup();
    const writer = await t.begin(t.context());
    const checkpoint = await writer.checkpoint();
    const finalKey = manifestKey(TENANT, writer.snapshotId);
    await t.primary.put(finalKey, Buffer.from("left by a failed commit"));

    await writer.abort();
    expect(await t.snapshots.get(writer.snapshotId)).toBeNull();
    expect(await t.primary.head(checkpoint.partialKey)).toBeNull();
    expect(await t.primary.head(finalKey)).toBeNull();
  });
});
