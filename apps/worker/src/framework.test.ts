import { Readable } from "node:stream";
import {
  ChunkReader,
  type Dek,
  JobAbortedError,
  type JobContext,
  Keyring,
  type ManifestObject,
  MemoryChunkIndex,
  MemoryCursorStore,
  MemorySnapshotIndex,
  type ProgressSink,
  ProgressTracker,
  type ProtectedObjectRef,
  SnapshotWriter,
  type StorageBackend,
  type StorageTargets,
  createRestoreArchive,
  noopLogger,
} from "@restow/core";
import { describe, expect, it } from "vitest";
import {
  type AnyJobHandler,
  HandlerRegistry,
  InvalidPayloadError,
  type ResolvedTenantStorage,
  TenantCache,
  TenantConcurrencyLimiter,
  abortReasonOf,
  expiryAbortDelayMs,
  isCheckpointAbandoned,
  manifestObjectKind,
  parseJobPayload,
  resolveStorageForJob,
  statusAfterFailure,
  storageForQueue,
  toManifestObjectRow,
} from "./handlers/framework.js";
import { createStorageTargets, loadConfig } from "./index.js";
import { QUEUE_DEFINITIONS, QUEUE_NAMES, pgBossQueueOptions, sendOptionsFor } from "./queues.js";

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";
const JOB = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OBJECT = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";

describe("queues", () => {
  it("defines a pg-boss policy for every queue with hours-long expiry under pg-boss' cap", () => {
    for (const queue of QUEUE_NAMES) {
      const options = pgBossQueueOptions(queue);
      expect(options.name).toBe(queue);
      expect(options.expireInHours).toBeGreaterThanOrEqual(2);
      expect(options.expireInHours).toBeLessThan(24);
      expect(QUEUE_DEFINITIONS[queue].retryLimit).toBeGreaterThan(0);
    }
    expect(QUEUE_DEFINITIONS.restore.policy).toBe("standard");
    expect(QUEUE_DEFINITIONS.backup.policy).toBe("stately");
  });

  it("derives priority and singleton keys from the payload", () => {
    const backup = sendOptionsFor("backup", {
      jobId: JOB,
      tenantId: TENANT,
      protectedObjectId: OBJECT,
    });
    expect(backup).toEqual({ priority: 40, singletonKey: `backup:${OBJECT}` });
    const restore = sendOptionsFor("restore", {
      jobId: JOB,
      tenantId: TENANT,
      restoreJobId: JOB,
      protectedObjectId: OBJECT,
    });
    expect(restore).toEqual({ priority: 100 });
    expect(
      sendOptionsFor("scrub", { jobId: JOB, tenantId: TENANT, mode: "sample" }).singletonKey,
    ).toBe(`scrub:${TENANT}`);
  });
});

/**
 * In-memory `StorageBackend`: a plain `Map`, with `put`/`delete` calls
 * counted so a test can assert a queue never wrote to a "previous" target
 * (docs/STORAGE.md, "Replace the primary"). Good enough for `storageForQueue`,
 * which only ever calls `get`/`head`/`list`/`put`/`delete` — never `getStream`.
 */
class MemoryStorageBackend implements StorageBackend {
  readonly objects = new Map<string, Buffer>();
  writes = 0;
  deletes = 0;

  async put(key: string, data: Buffer | Readable): Promise<void> {
    this.writes++;
    if (Buffer.isBuffer(data)) {
      this.objects.set(key, data);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of data) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.objects.set(key, Buffer.concat(chunks));
  }
  async get(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) {
      throw new Error(`not found: ${key}`);
    }
    return value;
  }
  async getStream(key: string): Promise<Readable> {
    return Readable.from(await this.get(key));
  }
  async head(key: string): Promise<{ size: number } | null> {
    const value = this.objects.get(key);
    return value ? { size: value.length } : null;
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
  async delete(key: string): Promise<void> {
    this.deletes++;
    this.objects.delete(key);
  }
}

describe("storageForQueue", () => {
  function resolvedStorage(): {
    primary: MemoryStorageBackend;
    previous: MemoryStorageBackend;
    resolved: ResolvedTenantStorage;
  } {
    const primary = new MemoryStorageBackend();
    const previous = new MemoryStorageBackend();
    previous.objects.set("retired-only", Buffer.from("from the retired target"));
    return {
      primary,
      previous,
      resolved: { primary, copies: [], previous: [previous], keepGeneration: null },
    };
  }

  it("for backup, restore and verify, reads through to a previous target the primary lacks", async () => {
    for (const queue of ["backup", "restore", "verify"] as const) {
      const { primary, previous, resolved } = resolvedStorage();
      const storage = storageForQueue(resolved, queue);
      expect((await storage.primary.get("retired-only")).toString()).toBe(
        "from the retired target",
      );
      // A write still only ever reaches the real primary.
      await storage.primary.put("new-object", Buffer.from("new"));
      expect(primary.objects.has("new-object")).toBe(true);
      expect(previous.objects.has("new-object")).toBe(false);
      expect(previous.writes).toBe(0);
      expect(previous.deletes).toBe(0);
    }
  });

  it("for archive, directory, retention, storage_migration and scrub, never falls back: an object that lives only on the previous target stays invisible", async () => {
    const excluded = ["archive", "directory", "retention", "storage_migration", "scrub"] as const;
    for (const queue of excluded) {
      const { resolved } = resolvedStorage();
      const storage = storageForQueue(resolved, queue);
      await expect(storage.primary.get("retired-only")).rejects.toThrow("not found");
      expect(await storage.primary.head("retired-only")).toBeNull();
    }
  });

  it('costs nothing extra for a StorageTargets that never had a previous target (every tenant without a "keep" replacement)', () => {
    const primary = new MemoryStorageBackend();
    const plain: StorageTargets = { primary, copies: [] };
    // archive is not one of READ_ONLY_FALLBACK_QUEUES: handed back unchanged, not even rewrapped.
    expect(storageForQueue(plain, "archive")).toBe(plain);
    // restore is, but withReadOnlyFallback returns `primary` itself unwrapped
    // when there is nothing to fall back to (packages/core/src/storage/copy.ts).
    const forRestore = storageForQueue(plain, "restore");
    expect(forRestore.primary).toBe(primary);
    expect(forRestore).toEqual(plain);
  });
});

/**
 * `storageForQueue` proven against the real engines it feeds `ctx.storage`
 * to (SnapshotWriter, ChunkReader, the download archive builder), not just
 * the plain get/put probe above: a "keep" switch retires the target every
 * earlier backup lives on, and these prove a job whose cache already resolved
 * the new primary can still read through to it, for exactly the operations
 * the acceptance criteria name — a later backup's dedupe read, a restore, a
 * verify and a download — never once writing to it.
 */
describe("storage fallback through the real engines after a 'keep' switch", () => {
  const FALLBACK_TENANT = "5c6d7e8f-1a2b-4c3d-8e4f-9a0b1c2d3e4f";
  const DEK: Dek = { version: 1, material: Buffer.alloc(32, 0x5a) };

  function noopSink(): ProgressSink {
    return { publish: async () => {} };
  }

  function buildCtx(options: {
    queue: JobContext["queue"];
    storage: StorageTargets;
    keys: Keyring;
    chunkIndex: MemoryChunkIndex;
    snapshots: MemorySnapshotIndex;
    now: () => Date;
  }): JobContext {
    return {
      jobId: JOB,
      tenantId: FALLBACK_TENANT,
      queue: options.queue,
      attempt: 0,
      db: undefined,
      storage: options.storage,
      keys: options.keys,
      secrets: { get: async () => null },
      chunkIndex: options.chunkIndex,
      snapshots: options.snapshots,
      progress: new ProgressTracker({ sink: noopSink() }),
      cursor: new MemoryCursorStore(),
      logger: noopLogger,
      signal: new AbortController().signal,
      now: options.now,
    };
  }

  async function drain(stream: Readable): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of stream) {
      parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(parts);
  }

  it("a real incremental backup finds the previous manifest, and never writes to the retired target", async () => {
    const protectedObject: ProtectedObjectRef = {
      id: "6d7e8f9a-2b3c-4d5e-8f6a-0b1c2d3e4f5a",
      tenantId: FALLBACK_TENANT,
      sourceId: "source-1",
      kind: "imap",
      externalId: "anna@example.org",
      displayName: null,
      userId: null,
    };
    const retiredPrimary = new MemoryStorageBackend();
    const chunkIndex = new MemoryChunkIndex();
    const snapshots = new MemorySnapshotIndex(FALLBACK_TENANT);
    const keys = new Keyring(FALLBACK_TENANT, [DEK]);

    // First backup: its only manifest lives on what will become the retired target.
    const firstRun = await SnapshotWriter.begin(
      buildCtx({
        queue: "backup",
        storage: { primary: retiredPrimary, copies: [] },
        keys,
        chunkIndex,
        snapshots,
        now: () => new Date(Date.UTC(2026, 8, 1)),
      }),
      { protectedObject, sourceType: "imap" },
    );
    const written = await firstRun.chunks.write(Buffer.from("the message from before the switch"));
    firstRun.add({
      path: "mail/INBOX/1.eml",
      size: written.size,
      mtime: 0,
      chunks: written.chunks,
    });
    await firstRun.commit();
    const writesBeforeSwitch = retiredPrimary.writes;
    const deletesBeforeSwitch = retiredPrimary.deletes;

    // "keep" switch: a fresh, empty primary; the old one is now "previous".
    const newPrimary = new MemoryStorageBackend();
    const resolved: ResolvedTenantStorage = {
      primary: newPrimary,
      copies: [],
      previous: [retiredPrimary],
      keepGeneration: null,
    };
    const storage = storageForQueue(resolved, "backup");

    // Second, incremental run, on a worker whose cache already resolved the
    // new primary: it must still find the previous snapshot's manifest.
    const secondRun = await SnapshotWriter.begin(
      buildCtx({
        queue: "backup",
        storage,
        keys,
        chunkIndex,
        snapshots,
        now: () => new Date(Date.UTC(2026, 8, 2)),
      }),
      { protectedObject, sourceType: "imap" },
    );
    expect(secondRun.previous?.manifestPath).toBeTruthy();
    const previousManifest = await secondRun.loadPreviousManifest();
    expect(previousManifest?.objects.map((object) => object.path)).toEqual(["mail/INBOX/1.eml"]);

    // The read never touched the retired target as a write, and nothing
    // reached the new primary's read-only fallback wiring by mistake either.
    expect(retiredPrimary.writes).toBe(writesBeforeSwitch);
    expect(retiredPrimary.deletes).toBe(deletesBeforeSwitch);
  });

  it("restore, verify and a download archive all reconstruct a restore point that lives only on a 'previous' target, read-only", async () => {
    const protectedObject: ProtectedObjectRef = {
      id: "7e8f9a0b-3c4d-5e6f-8a7b-1c2d3e4f5a6b",
      tenantId: FALLBACK_TENANT,
      sourceId: "source-1",
      kind: "imap",
      externalId: "anna@example.org",
      displayName: null,
      userId: null,
    };
    const content = Buffer.from("The quarterly figures are attached.\n".repeat(200));
    const retiredPrimary = new MemoryStorageBackend();
    const chunkIndex = new MemoryChunkIndex();
    const snapshots = new MemorySnapshotIndex(FALLBACK_TENANT);
    const keys = new Keyring(FALLBACK_TENANT, [DEK]);

    const writer = await SnapshotWriter.begin(
      buildCtx({
        queue: "backup",
        storage: { primary: retiredPrimary, copies: [] },
        keys,
        chunkIndex,
        snapshots,
        now: () => new Date(Date.UTC(2026, 8, 1)),
      }),
      { protectedObject, sourceType: "imap" },
    );
    const written = await writer.chunks.write(content);
    const object: ManifestObject = {
      path: "files/quarterly-report.txt",
      size: written.size,
      mtime: 0,
      chunks: written.chunks,
      sha256: written.sha256,
    };
    writer.add(object);
    await writer.commit();
    const writesBeforeSwitch = retiredPrimary.writes;
    const deletesBeforeSwitch = retiredPrimary.deletes;

    // "keep" switch: the packs above now live only on the retired target.
    const newPrimary = new MemoryStorageBackend();
    const resolved: ResolvedTenantStorage = {
      primary: newPrimary,
      copies: [],
      previous: [retiredPrimary],
      keepGeneration: null,
    };

    for (const queue of ["restore", "verify"] as const) {
      const storage = storageForQueue(resolved, queue);
      const reader = new ChunkReader({ storage, keys, index: chunkIndex, logger: noopLogger });
      const parts: Buffer[] = [];
      for await (const part of reader.read(object.chunks)) {
        parts.push(Buffer.from(part));
      }
      expect(Buffer.concat(parts).equals(content)).toBe(true);
    }

    // Download restore runs on the "restore" queue too (apps/worker/src/handlers/restore.ts).
    const downloadStorage = storageForQueue(resolved, "restore");
    const downloadReader = new ChunkReader({
      storage: downloadStorage,
      keys,
      index: chunkIndex,
      logger: noopLogger,
    });
    const { stream, completed } = createRestoreArchive({
      reader: downloadReader,
      objects: [object],
    });
    const [, summary] = await Promise.all([drain(stream), completed]);
    expect(summary.added).toBe(1);
    expect(summary.missing).toBe(0);
    expect(summary.entries[0]).toMatchObject({ status: "added", sha256: object.sha256 });

    // None of the three reads ever wrote to, or deleted from, the retired
    // target, and nothing was written to the new primary either (nothing to
    // restore or verify there yet).
    expect(retiredPrimary.writes).toBe(writesBeforeSwitch);
    expect(retiredPrimary.deletes).toBe(deletesBeforeSwitch);
    expect(newPrimary.writes).toBe(0);
    expect(newPrimary.deletes).toBe(0);
  });
});

describe("parseJobPayload", () => {
  it("accepts a payload with uuid job, tenant and optional object ids", () => {
    const payload = parseJobPayload("backup", {
      jobId: JOB,
      tenantId: TENANT,
      protectedObjectId: OBJECT,
    });
    expect(payload.protectedObjectId).toBe(OBJECT);
  });

  it("rejects missing or malformed ids", () => {
    expect(() => parseJobPayload("backup", null)).toThrow(InvalidPayloadError);
    expect(() => parseJobPayload("backup", { tenantId: TENANT })).toThrow(/jobId/);
    expect(() => parseJobPayload("backup", { jobId: JOB })).toThrow(/tenantId/);
    expect(() =>
      parseJobPayload("backup", { jobId: JOB, tenantId: TENANT, protectedObjectId: "x" }),
    ).toThrow(/protectedObjectId/);
  });
});

describe("lifecycle decisions", () => {
  it("keeps a job queued while pg-boss still has retries, else fails it", () => {
    expect(statusAfterFailure(0, 3)).toBe("queued");
    expect(statusAfterFailure(2, 3)).toBe("queued");
    expect(statusAfterFailure(3, 3)).toBe("failed");
    expect(statusAfterFailure(0, 0)).toBe("failed");
  });

  it("classifies abort reasons", () => {
    const controller = new AbortController();
    expect(abortReasonOf(controller.signal)).toBeNull();
    controller.abort("cancelled");
    expect(abortReasonOf(controller.signal)).toBe("cancelled");
    const other = new AbortController();
    other.abort("shutdown");
    expect(abortReasonOf(other.signal)).toBe("shutdown");
    const expired = new AbortController();
    expired.abort("expired");
    expect(abortReasonOf(expired.signal)).toBe("expired");
  });

  it("aborts a job shortly before its pg-boss expiration", () => {
    expect(expiryAbortDelayMs(3600)).toBe(3_420_000);
    expect(expiryAbortDelayMs(0)).toBeNull();
    expect(expiryAbortDelayMs(Number.NaN)).toBeNull();
  });

  it("treats a checkpoint as abandoned once nothing can resume it", () => {
    // Only a job that may still run again resumes its checkpoint.
    expect(isCheckpointAbandoned({ manifestPath: null, jobStatus: "active" })).toBe(false);
    expect(isCheckpointAbandoned({ manifestPath: null, jobStatus: "queued" })).toBe(false);
    // The job ended for good: its cursor is cleared, the checkpoint is dead.
    expect(isCheckpointAbandoned({ manifestPath: null, jobStatus: "failed" })).toBe(true);
    expect(isCheckpointAbandoned({ manifestPath: null, jobStatus: "cancelled" })).toBe(true);
    expect(isCheckpointAbandoned({ manifestPath: null, jobStatus: "completed" })).toBe(true);
    // The job row is gone, the snapshot row is gone, or the snapshot is committed.
    expect(isCheckpointAbandoned({ manifestPath: null, jobStatus: null })).toBe(true);
    expect(isCheckpointAbandoned(null)).toBe(true);
    expect(
      isCheckpointAbandoned({
        manifestPath: "tenants/t/manifests/s.json.zst",
        jobStatus: "active",
      }),
    ).toBe(true);
  });
});

describe("TenantConcurrencyLimiter", () => {
  it("caps active jobs per tenant and serves waiters in order", async () => {
    const limiter = new TenantConcurrencyLimiter(2);
    const releaseA = await limiter.acquire(TENANT);
    const releaseB = await limiter.acquire(TENANT);
    expect(limiter.activeCount(TENANT)).toBe(2);

    const order: string[] = [];
    const third = limiter.acquire(TENANT).then((release) => {
      order.push("third");
      return release;
    });
    const fourth = limiter.acquire(TENANT).then((release) => {
      order.push("fourth");
      return release;
    });
    // Another tenant is not affected by this tenant's limit.
    const otherRelease = await limiter.acquire(OBJECT);
    otherRelease();

    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([]);
    releaseA();
    const releaseC = await third;
    expect(order).toEqual(["third"]);
    releaseB();
    const releaseD = await fourth;
    expect(order).toEqual(["third", "fourth"]);
    releaseC();
    releaseD();
    releaseC(); // double release is harmless
    expect(limiter.activeCount(TENANT)).toBe(0);
  });

  it("rejects a waiting acquire when the shutdown signal fires", async () => {
    const limiter = new TenantConcurrencyLimiter(1);
    const release = await limiter.acquire(TENANT);
    const controller = new AbortController();
    const waiting = limiter.acquire(TENANT, controller.signal);
    controller.abort("shutdown");
    await expect(waiting).rejects.toBeInstanceOf(JobAbortedError);
    release();
    // The aborted waiter was removed from the queue; a new acquire succeeds.
    (await limiter.acquire(TENANT))();
    await expect(limiter.acquire(TENANT, controller.signal)).rejects.toBeInstanceOf(
      JobAbortedError,
    );
  });

  it("rejects a non-positive limit", () => {
    expect(() => new TenantConcurrencyLimiter(0)).toThrow();
  });
});

describe("HandlerRegistry", () => {
  const backupHandler: AnyJobHandler = { queue: "backup", run: async () => undefined };

  it("registers one handler per queue", () => {
    const registry = new HandlerRegistry([backupHandler]);
    expect(registry.get("backup")).toBe(backupHandler);
    expect(registry.get("restore")).toBeUndefined();
    expect(registry.queues()).toEqual(["backup"]);
    expect(() => registry.register(backupHandler)).toThrow(/already has a handler/);
  });
});

describe("TenantCache", () => {
  it("reloads after the ttl and on invalidate", async () => {
    let now = 0;
    let loads = 0;
    const cache = new TenantCache(
      async (tenantId: string) => `${tenantId}#${++loads}`,
      1000,
      () => now,
    );
    expect(await cache.get(TENANT)).toBe(`${TENANT}#1`);
    expect(await cache.get(TENANT)).toBe(`${TENANT}#1`);
    now = 1500;
    expect(await cache.get(TENANT)).toBe(`${TENANT}#2`);
    cache.invalidate(TENANT);
    expect(await cache.get(TENANT)).toBe(`${TENANT}#3`);
  });

  it("reports peek the current entry's value, undefined once nothing is cached", async () => {
    let now = 0;
    let loads = 0;
    const cache = new TenantCache(
      async (tenantId: string) => `${tenantId}#${++loads}`,
      1000,
      () => now,
    );
    expect(cache.peek(TENANT)).toBeUndefined();
    await cache.get(TENANT);
    expect(cache.peek(TENANT)).toBe(`${TENANT}#1`);
    now = 500;
    await cache.get(TENANT); // still inside the ttl: no reload, value unchanged
    expect(cache.peek(TENANT)).toBe(`${TENANT}#1`);
    cache.invalidate(TENANT);
    expect(cache.peek(TENANT)).toBeUndefined();
  });
});

/**
 * `resolveStorageForJob` closes the write-queue half of the "keep" switch
 * race (docs/STORAGE.md, "Replace the primary"; the API closes the other
 * half by refusing the switch while a write job is already queued or
 * active, `hasActiveWriteJob` in apps/api/src/features/storage/service.ts).
 * A worker that resolved and cached `StorageTargets` shortly before an
 * admin's "keep" switch must not hand a job dispatched after that switch
 * the stale, just-retired primary, even while the cache entry is still well
 * inside its ttl. The check compares two Postgres-sourced "keep generation"
 * values for equality (`ResolvedTenantStorage.keepGeneration`), never the
 * worker's own clock against the switch time, so `targetsOf` below always
 * carries whatever generation the loader would really have read at that
 * point, exactly like `resolveTenantStorage` stamping it inside the same
 * transaction as the rows it describes.
 */
describe("resolveStorageForJob", () => {
  function targetsOf(
    primary: StorageBackend,
    keepGeneration: Date | null = null,
  ): ResolvedTenantStorage {
    return { primary, copies: [], previous: [], keepGeneration };
  }

  it("invalidates a warm cache entry older than the tenant's latest 'keep' switch, so a job starting after it writes only to the new primary", async () => {
    const oldPrimary = new MemoryStorageBackend();
    const newPrimary = new MemoryStorageBackend();
    let current: MemoryStorageBackend = oldPrimary;
    let generation: Date | null = null;
    const storage = new TenantCache<StorageTargets>(
      async () => targetsOf(current, generation),
      5 * 60 * 1000,
      () => 0,
    );

    // A job resolves and caches the old primary before the switch.
    const beforeSwitch = await resolveStorageForJob({
      tenantId: TENANT,
      queue: "backup",
      storage,
      getLatestKeepSwitchAt: async () => null,
    });
    expect(beforeSwitch.primary).toBe(oldPrimary);

    // An admin replaces the primary with "keep"; the worker's cache is well
    // inside its 5-minute ttl and does not know about it yet.
    const switchedAt = new Date(1_000);
    current = newPrimary;
    generation = switchedAt;

    // A backup job starts after the switch, dispatched to this same worker.
    const afterSwitch = await resolveStorageForJob({
      tenantId: TENANT,
      queue: "backup",
      storage,
      getLatestKeepSwitchAt: async () => switchedAt,
    });
    expect(afterSwitch.primary).toBe(newPrimary);
    await afterSwitch.primary.put("new-object", Buffer.from("new"));
    expect(newPrimary.writes).toBe(1);
    expect(oldPrimary.writes).toBe(0);
  });

  it("still invalidates when the loader resolves so long after the switch that its clock stamp alone would read later than switchedAt", async () => {
    // Regression test for the bug this fix closes: the old check stamped a
    // cache entry's age only once its loader (which, for real storage
    // resolution, also runs `mirrorTenantKeys`'s S3 round trips) had already
    // resolved, and compared that stamp against `switchedAt` by ordering
    // (`switchedAt > loadedAt`). A switch that lands while the loader is
    // still running could then never be detected, because the loader's own
    // completion always reads later than the switch that raced it. Setting
    // the cache's clock far ahead of `switchedAt` reproduces exactly that:
    // under the old ordering check this would wrongly stay cached.
    const oldPrimary = new MemoryStorageBackend();
    const newPrimary = new MemoryStorageBackend();
    let current: MemoryStorageBackend = oldPrimary;
    let generation: Date | null = null;
    const storage = new TenantCache<StorageTargets>(
      async () => targetsOf(current, generation),
      5 * 60 * 1000,
      () => 10_000,
    );

    await resolveStorageForJob({
      tenantId: TENANT,
      queue: "backup",
      storage,
      getLatestKeepSwitchAt: async () => null,
    });

    const switchedAt = new Date(1); // far "before" the cache's clock above
    current = newPrimary;
    generation = switchedAt;

    const afterSwitch = await resolveStorageForJob({
      tenantId: TENANT,
      queue: "backup",
      storage,
      getLatestKeepSwitchAt: async () => switchedAt,
    });
    expect(afterSwitch.primary).toBe(newPrimary);
  });

  it("leaves a cache entry alone when the current generation matches the cached one", async () => {
    const primary = new MemoryStorageBackend();
    let loads = 0;
    // The entry was already loaded after an earlier "keep" switch, so its own
    // generation already reflects that switch.
    const earlierSwitch = new Date(-1_000);
    const storage = new TenantCache<StorageTargets>(
      async () => {
        loads++;
        return targetsOf(primary, earlierSwitch);
      },
      5 * 60 * 1000,
      () => 0,
    );
    await resolveStorageForJob({
      tenantId: TENANT,
      queue: "backup",
      storage,
      getLatestKeepSwitchAt: async () => earlierSwitch,
    });
    await resolveStorageForJob({
      tenantId: TENANT,
      queue: "backup",
      storage,
      getLatestKeepSwitchAt: async () => earlierSwitch,
    });
    expect(loads).toBe(1);
  });

  it("skips the staleness check for queues that never write to storage", async () => {
    const primary = new MemoryStorageBackend();
    const storage = new TenantCache<StorageTargets>(
      async () => targetsOf(primary),
      5 * 60 * 1000,
      () => 0,
    );
    await storage.get(TENANT);
    let checked = false;
    for (const queue of ["verify", "directory"] as const) {
      await resolveStorageForJob({
        tenantId: TENANT,
        queue,
        storage,
        getLatestKeepSwitchAt: async () => {
          checked = true;
          return new Date(1);
        },
      });
    }
    expect(checked).toBe(false);
  });

  it("re-checks 'restore' too, so a warm-cache download job after a 'keep' switch writes its archive only to the new primary", async () => {
    // The download engine (core `restore/download.ts`) writes the export ZIP
    // straight through `ctx.storage.primary`, unlike granular/full-mailbox
    // restore on the same queue, which never touches storage — so `restore`
    // needs the same re-check as the write queues, not the skip above.
    const oldPrimary = new MemoryStorageBackend();
    const newPrimary = new MemoryStorageBackend();
    let current: MemoryStorageBackend = oldPrimary;
    let generation: Date | null = null;
    const storage = new TenantCache<StorageTargets>(
      async () => targetsOf(current, generation),
      5 * 60 * 1000,
      () => 0,
    );

    const beforeSwitch = await resolveStorageForJob({
      tenantId: TENANT,
      queue: "restore",
      storage,
      getLatestKeepSwitchAt: async () => null,
    });
    expect(beforeSwitch.primary).toBe(oldPrimary);

    const switchedAt = new Date(1_000);
    current = newPrimary;
    generation = switchedAt;

    const afterSwitch = await resolveStorageForJob({
      tenantId: TENANT,
      queue: "restore",
      storage,
      getLatestKeepSwitchAt: async () => switchedAt,
    });
    expect(afterSwitch.primary).toBe(newPrimary);
    await afterSwitch.primary.put("download.zip", Buffer.from("archive"));
    expect(newPrimary.writes).toBe(1);
    expect(oldPrimary.writes).toBe(0);
  });
});

describe("manifest object rows", () => {
  it("maps manifest entries onto the manifest_objects columns", () => {
    expect(manifestObjectKind("message")).toBe("mail");
    expect(manifestObjectKind("mail")).toBe("mail");
    expect(manifestObjectKind("folder")).toBe("folder");
    expect(manifestObjectKind(undefined)).toBe("file");

    const row = toManifestObjectRow(TENANT, JOB, OBJECT, {
      path: "files/Documents/report.docx",
      id: "item-1",
      type: "file",
      size: 10,
      mtime: 1_700_000_000_000,
      metadata: { etag: "abc" },
      chunks: ["aa", "bb"],
    });
    expect(row).toMatchObject({
      tenantId: TENANT,
      snapshotId: JOB,
      protectedObjectId: OBJECT,
      kind: "file",
      name: "report.docx",
      parentPath: "files/Documents",
      itemId: "item-1",
      messageId: null,
      chunkRefs: ["aa", "bb"],
    });
    expect(row.mtime).toEqual(new Date(1_700_000_000_000));

    const folder = toManifestObjectRow(TENANT, JOB, OBJECT, {
      path: "Inbox",
      type: "folder",
      size: 0,
      mtime: 0,
      chunks: [],
    });
    expect(folder).toMatchObject({
      kind: "folder",
      name: "Inbox",
      parentPath: "",
      chunkRefs: null,
      mtime: null,
    });
  });
});

describe("worker configuration", () => {
  const base = {
    DATABASE_URL: "postgres://x",
    DATABASE_PROVIDER_URL: "postgres://y",
    RESTOW_MASTER_KEY: "a".repeat(44),
  };

  it("requires both database urls and the master key", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://x" })).toThrow(/DATABASE_PROVIDER_URL/);
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://x", DATABASE_PROVIDER_URL: "postgres://y" }),
    ).toThrow(/RESTOW_MASTER_KEY/);
    expect(() => loadConfig({ ...base, STORAGE_TARGET: "ftp" })).toThrow(/STORAGE_TARGET/);
  });

  it("applies defaults and parses overrides", () => {
    const config = loadConfig({ ...base, WORKER_CONCURRENCY: "4", LOG_LEVEL: "debug" });
    expect(config.concurrency).toBe(4);
    expect(config.tenantConcurrency).toBe(2);
    expect(config.logLevel).toBe("debug");
    expect(config.storage.target).toBe("local");
    expect(config.storage.localPath).toBe("/data/chunks");
  });

  it("builds local targets with an optional copy and refuses s3 without a bucket", () => {
    const targets = createStorageTargets({
      ...loadConfig({ ...base, STORAGE_LOCAL_PATH: "/tmp/a", STORAGE_COPY_LOCAL_PATH: "/tmp/b" })
        .storage,
    });
    expect(targets.copies).toHaveLength(1);
    expect(() =>
      createStorageTargets(loadConfig({ ...base, STORAGE_TARGET: "s3" }).storage),
    ).toThrow(/S3_BUCKET/);
  });
});
