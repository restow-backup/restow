import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Dek } from "../crypto.js";
import { type SnapshotManifest, serializeManifest } from "../manifest.js";
import type { PutOptions } from "../storage/backend.js";
import { LocalStorageBackend } from "../storage/local.js";
import { ChunkReader, ChunkStoreFailedError } from "./chunkstore.js";
import { Keyring } from "./keyring.js";
import { manifestKey, partialManifestKey } from "./layout.js";
import {
  MemoryChunkIndex,
  MemoryCursorStore,
  MemorySnapshotIndex,
  createMemoryJobContext,
} from "./memory.js";
import { isSealedManifest, openManifest } from "./sealed-manifest.js";
import { SnapshotWriter, loadLatestManifest, loadManifest } from "./snapshot.js";
import type { JobContext, ProtectedObjectRef } from "./types.js";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x07) };
const mailbox: ProtectedObjectRef = {
  id: "po-1",
  tenantId: TENANT,
  sourceId: "src-1",
  kind: "mailbox",
  externalId: "alice@example.test",
  displayName: "Alice",
  userId: null,
};

const testKeys = new Keyring(TENANT, [dek]);

/** A stored (sealed) manifest, opened the way `loadManifest` opens it. */
function readStored(bytes: Buffer, storageKey: string): Promise<SnapshotManifest> {
  return openManifest(bytes, { open: (sealed) => testKeys.open(sealed), storageKey });
}

/** Local storage whose next pack upload fails, like a transient S3 or copy-target error. */
class FlakyPackStorage extends LocalStorageBackend {
  failNextPack = false;

  override async put(key: string, data: Buffer | Readable, options?: PutOptions): Promise<void> {
    if (this.failNextPack && key.includes("/packs/")) {
      this.failNextPack = false;
      throw new Error("storage unavailable");
    }
    await super.put(key, data, options);
  }
}

describe("SnapshotWriter", () => {
  let root: string;
  let ctx: JobContext;
  let chunkIndex: MemoryChunkIndex;
  let snapshots: MemorySnapshotIndex;
  let cursor: MemoryCursorStore;
  let nextSnapshot: number;

  function newContext(overrides: { jobId?: string } = {}): JobContext {
    return createMemoryJobContext({
      tenantId: TENANT,
      keys: new Keyring(TENANT, [dek]),
      storage: new LocalStorageBackend(root),
      chunkIndex,
      snapshots,
      cursor,
      jobId: overrides.jobId ?? "job-1",
      now: () => new Date("2026-09-22T10:00:00Z"),
    });
  }

  function begin(
    context: JobContext,
    checkpoint?: Parameters<typeof SnapshotWriter.begin>[1]["checkpoint"],
  ) {
    return SnapshotWriter.begin(context, {
      protectedObject: mailbox,
      sourceType: "m365",
      checkpoint,
      snapshotIdGenerator: () => `snap-${nextSnapshot++}`,
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "restow-snapshot-"));
    chunkIndex = new MemoryChunkIndex();
    snapshots = new MemorySnapshotIndex(TENANT);
    cursor = new MemoryCursorStore();
    nextSnapshot = 1;
    ctx = newContext();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("commits a manifest that a reader can restore from, with refcounts and packs", async () => {
    const writer = await begin(ctx);
    expect(writer.sequence).toBe(1);
    expect(writer.previous).toBeNull();

    const mail = Buffer.from("From: alice\r\nSubject: hello\r\n\r\nbody");
    const written = await writer.chunks.write(mail);
    writer.add({
      path: "mail/Inbox/msg-1.eml",
      id: "msg-1",
      type: "message",
      size: written.size,
      mtime: 1,
      sha256: written.sha256,
      chunks: written.chunks,
    });
    writer.setState({ deltaLinks: { inbox: "https://graph/delta?token=abc" } });
    const committed = await writer.commit();

    expect(committed.itemCount).toBe(1);
    expect(committed.byteSize).toBe(mail.length);
    expect(committed.packCount).toBe(1);
    expect(committed.manifestPath).toBe(manifestKey(TENANT, "snap-1"));

    const manifest = await readStored(
      await ctx.storage.primary.get(committed.manifestPath),
      committed.manifestPath,
    );
    expect(manifest.snapshotId).toBe("snap-1");
    expect(manifest.sequence).toBe(1);
    expect(manifest.source).toEqual({
      type: "m365",
      id: mailbox.externalId,
      kind: "mailbox",
      protectedObjectId: mailbox.id,
    });
    expect(manifest.packs).toHaveLength(1);
    expect(manifest.state).toEqual({ deltaLinks: { inbox: "https://graph/delta?token=abc" } });

    const record = await snapshots.get("snap-1");
    expect(record?.manifestPath).toBe(committed.manifestPath);
    expect(record?.itemCount).toBe(1);
    expect(record?.completedAt).toEqual(new Date("2026-09-22T10:00:00Z"));
    expect(snapshots.objects.get("snap-1")).toHaveLength(1);
    for (const hex of written.chunks) {
      expect(chunkIndex.chunks.get(hex)?.refcount).toBe(1);
    }
    expect(await ctx.storage.primary.head(partialManifestKey(TENANT, "snap-1"))).toBeNull();

    const reader = new ChunkReader({ storage: ctx.storage, keys: ctx.keys, index: chunkIndex });
    const back = await reader.readObjectToBuffer(manifest.objects[0]);
    expect(back.equals(mail)).toBe(true);

    // Committing twice is harmless; writing afterwards is refused.
    expect(await writer.commit()).toEqual(committed);
    expect(() => writer.add(manifest.objects[0])).toThrow(/already committed/);
  });

  it("seals checkpoints and manifests so the storage target learns nothing about the objects", async () => {
    const writer = await begin(ctx);
    const written = await writer.chunks.write(
      Buffer.from("Subject: Quarterly figures\r\n\r\nbody"),
    );
    writer.add({
      path: "mail/Inbox/Quarterly figures.eml",
      id: "msg-1",
      type: "message",
      size: written.size,
      mtime: 1,
      sha256: written.sha256,
      metadata: { subject: "Quarterly figures", messageId: "<q3@example.test>" },
      chunks: written.chunks,
    });
    const checkpoint = await writer.checkpoint();
    const partial = await ctx.storage.primary.get(checkpoint.partialKey);
    const committed = await writer.commit();
    const stored = await ctx.storage.primary.get(committed.manifestPath);

    for (const bytes of [partial, stored]) {
      expect(isSealedManifest(bytes)).toBe(true);
      const text = bytes.toString("latin1");
      for (const plain of [
        "Quarterly figures",
        "q3@example.test",
        written.sha256,
        written.chunks[0],
      ]) {
        expect(text).not.toContain(plain);
      }
    }
    expect(
      (await loadManifest(ctx.storage, committed.manifestPath, ctx.keys)).objects[0]?.path,
    ).toBe("mail/Inbox/Quarterly figures.eml");

    // Bound to its storage key: the same bytes under another snapshot's key do not open.
    const elsewhere = manifestKey(TENANT, "snap-2");
    await ctx.storage.primary.put(elsewhere, stored);
    await expect(loadManifest(ctx.storage, elsewhere, ctx.keys)).rejects.toThrow(/bound to/);
    // Neither without a key nor with another tenant's key.
    await expect(openManifest(stored)).rejects.toThrow(/tenant key/);
    const foreign = new Keyring(TENANT, [{ version: 1, material: Buffer.alloc(32, 0x55) }]);
    await expect(loadManifest(ctx.storage, committed.manifestPath, foreign)).rejects.toThrow();

    // Unsealed manifest bytes are refused, never trusted, even when they are
    // otherwise perfectly well-formed: whoever can write to a storage target
    // must never be able to make the server accept a self-declared,
    // unencrypted manifest in place of the sealed one it expects (see
    // sealed-manifest.ts's doc comment). `loadManifest` falls through to a
    // copy that still holds the real, sealed manifest first; only once every
    // target's bytes fail to open does it surface that refusal.
    const legit = await loadManifest(ctx.storage, committed.manifestPath, ctx.keys);
    await ctx.storage.primary.put(elsewhere, await serializeManifest(legit));
    await expect(loadManifest(ctx.storage, elsewhere, ctx.keys)).rejects.toThrow(/not sealed/);
    await expect(openManifest(await serializeManifest(legit))).rejects.toThrow(/not sealed/);
  });

  it("refuses to commit a manifest with a chunk the index cannot locate", async () => {
    const writer = await begin(ctx);
    writer.add({ path: "ghost", size: 3, mtime: 0, chunks: ["ab".repeat(32)] });
    await expect(writer.commit()).rejects.toThrow(/not locatable/);
    expect((await snapshots.get("snap-1"))?.manifestPath).toBeNull();
  });

  it("references chunks before the locatability check and releases them when the commit fails", async () => {
    const writer = await begin(ctx);
    const written = await writer.chunks.write(Buffer.from("kept alive while committing"));
    writer.add({ path: "real", size: written.size, mtime: 0, chunks: written.chunks });
    writer.add({ path: "ghost", size: 3, mtime: 0, chunks: ["cd".repeat(32)] });

    const refcountsAtLocate: number[] = [];
    const locate = chunkIndex.locate.bind(chunkIndex);
    chunkIndex.locate = async (ids) => {
      refcountsAtLocate.push(
        ...written.chunks.map((id) => chunkIndex.chunks.get(id)?.refcount ?? 0),
      );
      return locate(ids);
    };

    await expect(writer.commit()).rejects.toThrow(/not locatable/);
    // Garbage collection never saw the real chunk unreferenced during the check ...
    expect(refcountsAtLocate.length).toBeGreaterThan(0);
    expect(refcountsAtLocate.every((count) => count === 1)).toBe(true);
    // ... and the failed commit does not keep it alive afterwards.
    for (const id of written.chunks) {
      expect(chunkIndex.chunks.get(id)?.refcount).toBe(0);
    }
  });

  it("carries unchanged objects forward and replaces changed ones on the next run", async () => {
    const first = await begin(ctx);
    const a = await first.chunks.write(Buffer.from("object a v1"));
    const b = await first.chunks.write(Buffer.from("object b v1"));
    first.add({ path: "a", id: "a", size: a.size, mtime: 1, chunks: a.chunks });
    first.add({ path: "b", id: "b", size: b.size, mtime: 1, chunks: b.chunks });
    await first.commit();

    const second = await begin(ctx);
    expect(second.sequence).toBe(2);
    expect(second.previous?.id).toBe("snap-1");
    const previous = await second.loadPreviousManifest();
    expect(previous?.objects.map((o) => o.path)).toEqual(["a", "b"]);

    const b2 = await second.chunks.write(Buffer.from("object b v2"));
    second.add({ path: "b", id: "b", size: b2.size, mtime: 2, chunks: b2.chunks });
    expect(second.inherit(previous as NonNullable<typeof previous>)).toBe(1);
    second.remove("does-not-exist");
    const committed = await second.commit();

    const manifest = await readStored(
      await ctx.storage.primary.get(committed.manifestPath),
      committed.manifestPath,
    );
    expect(manifest.objects.map((o) => [o.path, o.mtime])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    // "a" is now referenced by two snapshots, b v1 by one, b v2 by one.
    expect(chunkIndex.chunks.get(a.chunks[0])?.refcount).toBe(2);
    expect(chunkIndex.chunks.get(b.chunks[0])?.refcount).toBe(1);
    expect(chunkIndex.chunks.get(b2.chunks[0])?.refcount).toBe(1);

    const latest = await loadLatestManifest(ctx, mailbox.id);
    expect(latest?.record.sequence).toBe(2);
  });

  it("checkpoints and resumes without losing objects or re-uploading chunks", async () => {
    const writer = await begin(ctx);
    const one = await writer.chunks.write(Buffer.from("first item"));
    writer.add({ path: "one", size: one.size, mtime: 1, chunks: one.chunks });
    writer.setState({ folder: "inbox" });
    const checkpoint = await writer.checkpoint({ folderId: "inbox", lastItemId: "one" });

    expect(checkpoint.objectCount).toBe(1);
    expect(cursor.cursor).toEqual({ folderId: "inbox", lastItemId: "one", snapshot: checkpoint });
    expect(await ctx.storage.primary.head(checkpoint.partialKey)).not.toBeNull();
    // The checkpoint flushed the pack, so the chunk is locatable already.
    expect((await chunkIndex.locate(one.chunks)).size).toBe(1);

    // Simulate a worker restart: a new context (retry attempt) resumes from the cursor.
    const retryCtx = newContext({ jobId: "job-1" });
    const saved = await retryCtx.cursor.load();
    const resumed = await begin(retryCtx, saved?.snapshot);
    expect(resumed.snapshotId).toBe(writer.snapshotId);
    expect(resumed.sequence).toBe(writer.sequence);
    expect(resumed.objectCount).toBe(1);
    expect(resumed.state).toEqual({ folder: "inbox" });
    expect(resumed.has("one")).toBe(true);

    const two = await resumed.chunks.write(Buffer.from("second item"));
    resumed.add({ path: "two", size: two.size, mtime: 2, chunks: two.chunks });
    const committed = await resumed.commit();
    expect(committed.itemCount).toBe(2);
    expect(committed.snapshotId).toBe("snap-1");
    expect(nextSnapshot).toBe(2); // no second snapshot id was allocated
    expect(await ctx.storage.primary.head(checkpoint.partialKey)).toBeNull();
  });

  it("starts over when the checkpoint no longer matches an in-progress snapshot", async () => {
    const writer = await begin(ctx);
    const checkpoint = await writer.checkpoint();
    await writer.commit(); // completed: the checkpoint is stale now

    const fresh = await begin(newContext(), checkpoint);
    expect(fresh.snapshotId).toBe("snap-2");
    expect(fresh.sequence).toBe(2);
    expect(fresh.objectCount).toBe(0);
  });

  it("abort discards the in-progress row and the partial manifest", async () => {
    const writer = await begin(ctx);
    const checkpoint = await writer.checkpoint();
    await writer.abort();
    expect(await snapshots.get(writer.snapshotId)).toBeNull();
    expect(await ctx.storage.primary.head(checkpoint.partialKey)).toBeNull();
    expect(() => writer.add({ path: "x", size: 0, mtime: 0, chunks: [] })).toThrow(/aborted/);
  });

  it("refuses to checkpoint or commit after a pack was lost, and the retry resumes from the last good checkpoint", async () => {
    const storage = new FlakyPackStorage(root);
    const context = createMemoryJobContext({
      tenantId: TENANT,
      keys: new Keyring(TENANT, [dek]),
      storage,
      chunkIndex,
      snapshots,
      cursor,
      jobId: "job-1",
      now: () => new Date("2026-09-22T10:00:00Z"),
    });
    const writer = await begin(context);
    const one = await writer.chunks.write(Buffer.from("first item"));
    writer.add({ path: "one", size: one.size, mtime: 1, chunks: one.chunks });
    const good = await writer.checkpoint({ lastItemId: "one" });

    const two = await writer.chunks.write(Buffer.from("second item"));
    writer.add({ path: "two", size: two.size, mtime: 2, chunks: two.chunks });
    storage.failNextPack = true;
    await expect(writer.chunks.flush()).rejects.toThrow("storage unavailable");

    // The engines checkpoint on the way out of a failed run; that must not
    // record the lost chunk, nor move the resume point past it.
    await expect(writer.checkpoint({ lastItemId: "two" })).rejects.toBeInstanceOf(
      ChunkStoreFailedError,
    );
    expect(cursor.cursor).toEqual({ lastItemId: "one", snapshot: good });
    const partial = await readStored(await storage.get(good.partialKey), good.partialKey);
    expect(partial.objects.map((object) => object.path)).toEqual(["one"]);
    await expect(writer.chunks.write(Buffer.from("third item"))).rejects.toBeInstanceOf(
      ChunkStoreFailedError,
    );
    await expect(writer.commit()).rejects.toBeInstanceOf(ChunkStoreFailedError);
    expect((await snapshots.get(writer.snapshotId))?.manifestPath).toBeNull();

    // The retry resumes from the last good checkpoint and redoes only the lost item.
    const retry = newContext({ jobId: "job-1" });
    const resumed = await begin(retry, (await retry.cursor.load())?.snapshot);
    expect(resumed.snapshotId).toBe(writer.snapshotId);
    expect(resumed.has("one")).toBe(true);
    expect(resumed.has("two")).toBe(false);
    const again = await resumed.chunks.write(Buffer.from("second item"));
    expect(again.newChunks).toBe(1);
    resumed.add({ path: "two", size: again.size, mtime: 2, chunks: again.chunks });
    const committed = await resumed.commit();
    expect(committed.itemCount).toBe(2);

    const reader = new ChunkReader({ storage: retry.storage, keys: retry.keys, index: chunkIndex });
    const manifest = await readStored(
      await retry.storage.primary.get(committed.manifestPath),
      committed.manifestPath,
    );
    const restored = await Promise.all(
      manifest.objects.map(async (object) =>
        (await reader.readObjectToBuffer(object)).toString("utf8"),
      ),
    );
    expect(restored).toEqual(["first item", "second item"]);
  });
});
