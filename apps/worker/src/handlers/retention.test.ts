import { Readable } from "node:stream";
import {
  type HeadResult,
  Keyring,
  MANIFEST_VERSION,
  MemoryChunkIndex,
  type RetentionPolicyRow,
  type SnapshotManifest,
  type StorageBackend,
  createMemoryJobContext,
  generateDek,
  serializeManifest,
} from "@restow/core";
import type { Database } from "@restow/db";
import { describe, expect, it } from "vitest";
import type { WorkerJobContext } from "./framework.js";
import {
  type RetentionStore,
  RetentionTaskRegistry,
  createRetentionHandler,
  createSnapshotRetentionTask,
  pruneSnapshot,
} from "./retention.js";

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";
const JOB = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OBJECT_A = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
const OBJECT_B = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const NOW = new Date("2026-06-01T12:00:00Z");

class MemoryStorage implements StorageBackend {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, data: Buffer | Readable): Promise<void> {
    if (Buffer.isBuffer(data)) {
      this.objects.set(key, Buffer.from(data));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of data) {
      chunks.push(Buffer.from(chunk));
    }
    this.objects.set(key, Buffer.concat(chunks));
  }

  async get(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) {
      throw new Error(`missing ${key}`);
    }
    return value;
  }

  async getStream(key: string): Promise<Readable> {
    return Readable.from([await this.get(key)]);
  }

  async head(key: string): Promise<HeadResult | null> {
    const value = this.objects.get(key);
    return value ? { size: value.length } : null;
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

interface StoredSnapshot {
  id: string;
  protectedObjectId: string;
  sequence: number;
  manifestPath: string;
  byteSize: number;
  completedAt: Date | null;
  verified: boolean;
}

function snapshot(
  id: string,
  protectedObjectId: string,
  sequence: number,
  ageDays: number | null,
  overrides: Partial<StoredSnapshot> = {},
): StoredSnapshot {
  return {
    id,
    protectedObjectId,
    sequence,
    manifestPath: `tenants/${TENANT}/manifests/${id}.json.zst`,
    byteSize: 1000 * sequence,
    completedAt: ageDays === null ? null : daysAgo(ageDays),
    verified: false,
    ...overrides,
  };
}

/** The flat-30-day preset, as `retention_policies.applies_to` stores it. */
const policy30: RetentionPolicyRow = {
  id: "p1",
  name: "30 days",
  isDefault: true,
  appliesTo: { target: "snapshots", preset: "30d" },
};

interface FakeStoreState {
  policies: RetentionPolicyRow[];
  holds: { tenantWide: boolean; protectedObjectIds: Set<string> };
  snapshots: StoredSnapshot[];
  mirrored: Map<string, string[]>;
}

function fakeStore(state: FakeStoreState) {
  const pruned: string[] = [];
  const deleted: string[] = [];
  const store: RetentionStore = {
    async loadPolicies() {
      return state.policies;
    },
    async loadLegalHolds() {
      return state.holds;
    },
    async loadCompletedSnapshots() {
      return state.snapshots
        .filter((row) => !pruned.includes(row.id))
        .map((row) => ({
          id: row.id,
          protectedObjectId: row.protectedObjectId,
          sequence: row.sequence,
          byteSize: row.byteSize,
          completedAt: row.completedAt,
          verified: row.verified,
        }));
    },
    manifestPathOf(id) {
      const row = state.snapshots.find((s) => s.id === id);
      if (!row) {
        throw new Error(`no manifest path for snapshot ${id}`);
      }
      return row.manifestPath;
    },
    async markPruned(snapshotId) {
      if (pruned.includes(snapshotId)) {
        return false;
      }
      pruned.push(snapshotId);
      return true;
    },
    async loadMirroredChunkIds(snapshotId) {
      return state.mirrored.get(snapshotId) ?? null;
    },
    async deleteManifestObjects(snapshotId) {
      deleted.push(snapshotId);
      return state.mirrored.get(snapshotId)?.length ?? 0;
    },
  };
  return { store, pruned, deleted };
}

function manifestFor(row: StoredSnapshot, chunks: string[][]): Promise<Buffer> {
  const manifest: SnapshotManifest = {
    version: MANIFEST_VERSION,
    tenantId: TENANT,
    snapshotId: row.id,
    createdAt: NOW.getTime(),
    source: { type: "m365", id: "alice@contoso.example", kind: "mailbox" },
    sequence: row.sequence,
    objects: chunks.map((ids, index) => ({
      path: `Inbox/mail-${index}`,
      size: 10,
      mtime: 0,
      chunks: ids,
    })),
  };
  return serializeManifest(manifest);
}

function workerContext(
  primary: MemoryStorage,
  copies: MemoryStorage[] = [],
): WorkerJobContext & {
  chunkIndex: MemoryChunkIndex;
} {
  const chunkIndex = new MemoryChunkIndex();
  const base = createMemoryJobContext({
    tenantId: TENANT,
    jobId: JOB,
    queue: "retention",
    keys: new Keyring(TENANT, [generateDek(1)]),
    storage: { primary, copies },
    chunkIndex,
    now: () => NOW,
  });
  return { ...base, db: {} as Database, protectedObject: null, chunkIndex };
}

describe("pruneSnapshot", () => {
  it("flips the row, releases references from the manifest, drops the index rows and the file", async () => {
    const primary = new MemoryStorage();
    const copy = new MemoryStorage();
    const ctx = workerContext(primary, [copy]);
    const row = snapshot("s1", OBJECT_A, 1, 100);
    await ctx.chunkIndex.recordPack({ id: "pack", path: "packs/pack", sha256: "00", size: 3 }, [
      { storedId: "aa", offset: 0, length: 1 },
      { storedId: "bb", offset: 1, length: 1 },
    ]);
    await ctx.chunkIndex.addReferences(["aa", "aa", "bb"]);
    const bytes = await manifestFor(row, [["aa"], ["aa", "bb"]]);
    await primary.put(row.manifestPath, bytes);
    await copy.put(row.manifestPath, bytes);
    const { store, pruned, deleted } = fakeStore({
      policies: [],
      holds: { tenantWide: false, protectedObjectIds: new Set() },
      snapshots: [row],
      mirrored: new Map([["s1", ["aa", "aa", "bb"]]]),
    });
    const [candidate] = await store.loadCompletedSnapshots();
    if (!candidate) {
      throw new Error("expected a candidate");
    }

    const outcome = await pruneSnapshot(ctx, store, candidate, ctx.logger);

    expect(outcome).toEqual({ chunkReferencesReleased: 3, manifestObjectsDeleted: 3 });
    expect(pruned).toEqual(["s1"]);
    expect(deleted).toEqual(["s1"]);
    expect(ctx.chunkIndex.chunks.get("aa")?.refcount).toBe(0);
    expect(ctx.chunkIndex.chunks.get("bb")?.refcount).toBe(0);
    expect(await primary.head(row.manifestPath)).toBeNull();
    expect(await copy.head(row.manifestPath)).toBeNull();
  });

  it("falls back to the mirrored index when the manifest is gone", async () => {
    const ctx = workerContext(new MemoryStorage());
    const row = snapshot("s1", OBJECT_A, 1, 100);
    await ctx.chunkIndex.recordPack({ id: "pack", path: "packs/pack", sha256: "00", size: 1 }, [
      { storedId: "aa", offset: 0, length: 1 },
    ]);
    await ctx.chunkIndex.addReferences(["aa"]);
    const { store } = fakeStore({
      policies: [],
      holds: { tenantWide: false, protectedObjectIds: new Set() },
      snapshots: [row],
      mirrored: new Map([["s1", ["aa"]]]),
    });
    const [candidate] = await store.loadCompletedSnapshots();
    if (!candidate) {
      throw new Error("expected a candidate");
    }
    const outcome = await pruneSnapshot(ctx, store, candidate, ctx.logger);
    expect(outcome?.chunkReferencesReleased).toBe(1);
    expect(ctx.chunkIndex.chunks.get("aa")?.refcount).toBe(0);
  });

  it("is a no-op when another run pruned the snapshot first", async () => {
    const ctx = workerContext(new MemoryStorage());
    const row = snapshot("s1", OBJECT_A, 1, 100);
    const { store } = fakeStore({
      policies: [],
      holds: { tenantWide: false, protectedObjectIds: new Set() },
      snapshots: [row],
      mirrored: new Map(),
    });
    const [candidate] = await store.loadCompletedSnapshots();
    if (!candidate) {
      throw new Error("expected a candidate");
    }
    await store.markPruned("s1");
    expect(await pruneSnapshot(ctx, store, candidate, ctx.logger)).toBeNull();
  });
});

describe("retention handler", () => {
  const snapshots = [
    snapshot("a1", OBJECT_A, 1, 100),
    snapshot("a2", OBJECT_A, 2, 50),
    snapshot("a3", OBJECT_A, 3, 5),
    snapshot("b1", OBJECT_B, 1, 100),
    snapshot("b2", OBJECT_B, 2, 1),
  ];

  it("keeps every snapshot without a policy", async () => {
    const ctx = workerContext(new MemoryStorage());
    const { store, pruned } = fakeStore({
      policies: [],
      holds: { tenantWide: false, protectedObjectIds: new Set() },
      snapshots,
      mirrored: new Map(),
    });
    const handler = createRetentionHandler(
      new RetentionTaskRegistry([createSnapshotRetentionTask(() => store)]),
    );
    const outcome = await handler.run(ctx, { jobId: JOB, tenantId: TENANT });
    expect(outcome?.summary?.snapshots).toMatchObject({ policies: 0, pruned: 0 });
    expect(pruned).toEqual([]);
  });

  it("prunes what the policy expires, honours legal holds and reports progress", async () => {
    const primary = new MemoryStorage();
    const ctx = workerContext(primary);
    const { store, pruned } = fakeStore({
      policies: [policy30],
      holds: { tenantWide: false, protectedObjectIds: new Set([OBJECT_B]) },
      snapshots,
      mirrored: new Map([
        ["a1", ["aa"]],
        ["a2", ["bb"]],
      ]),
    });
    const handler = createRetentionHandler(
      new RetentionTaskRegistry([createSnapshotRetentionTask(() => store)]),
    );
    const outcome = await handler.run(ctx, { jobId: JOB, tenantId: TENANT });

    // a1 and a2 are older than 30 days and not the newest; b1 would be but is held.
    expect(pruned.sort()).toEqual(["a1", "a2"]);
    expect(outcome?.summary?.snapshots).toMatchObject({
      policies: 1,
      objects: 2,
      candidates: 2,
      pruned: 2,
      held: 1,
      bytesLogical: 3000,
      chunkReferencesReleased: 2,
      dryRun: false,
    });
    expect(ctx.progress.snapshot()).toMatchObject({ total: 2, done: 2, failed: 0, phase: "prune" });
  });

  it("never removes the only verified restore point of an object, even under an aggressive custom policy", async () => {
    const aggressive: RetentionPolicyRow = {
      id: "p2",
      name: "Aggressive",
      isDefault: true,
      appliesTo: {
        target: "snapshots",
        preset: "custom",
        tiers: [{ fromDays: 0, toDays: 1, keepEveryDays: 0 }],
      },
    };
    const history = [
      snapshot("v1", OBJECT_A, 1, 400, { verified: true }),
      snapshot("v2", OBJECT_A, 2, 200),
    ];
    const ctx = workerContext(new MemoryStorage());
    const { store, pruned } = fakeStore({
      policies: [aggressive],
      holds: { tenantWide: false, protectedObjectIds: new Set() },
      snapshots: history,
      mirrored: new Map(),
    });
    const handler = createRetentionHandler(
      new RetentionTaskRegistry([createSnapshotRetentionTask(() => store)]),
    );
    await handler.run(ctx, { jobId: JOB, tenantId: TENANT });
    // v2 (the newest) is always kept; v1 is the sole verified restore point.
    expect(pruned).toEqual([]);
  });

  it("applies the default preset's tiered thinning: every point 30 days, daily to 90, weekly to a year", async () => {
    const defaultPreset: RetentionPolicyRow = {
      id: "pdefault",
      name: "Recommended",
      isDefault: true,
      appliesTo: { target: "snapshots", preset: "default" },
    };
    const history = [
      snapshot("a1", OBJECT_A, 1, 400), // past every tier
      snapshot("a2", OBJECT_A, 2, 300), // weekly tier, alone in its bucket
      snapshot("a3", OBJECT_A, 3, 91), // weekly tier, same bucket as a4
      snapshot("a4", OBJECT_A, 4, 95), // weekly tier, same bucket as a3, newer sequence survives
      snapshot("a5", OBJECT_A, 5, 20), // daily-keep-all tier
      snapshot("a6", OBJECT_A, 6, 2), // newest, daily-keep-all tier
    ];
    const ctx = workerContext(new MemoryStorage());
    const { store, pruned } = fakeStore({
      policies: [defaultPreset],
      holds: { tenantWide: false, protectedObjectIds: new Set() },
      snapshots: history,
      mirrored: new Map(),
    });
    const handler = createRetentionHandler(
      new RetentionTaskRegistry([createSnapshotRetentionTask(() => store)]),
    );
    await handler.run(ctx, { jobId: JOB, tenantId: TENANT });
    expect(pruned.sort()).toEqual(["a1", "a3"]);
  });

  it("sets aside a legal hold's overdue restore points even under an aggressive custom policy", async () => {
    const aggressive: RetentionPolicyRow = {
      id: "p-hold",
      name: "Aggressive",
      isDefault: true,
      appliesTo: {
        target: "snapshots",
        preset: "custom",
        tiers: [{ fromDays: 0, toDays: 1, keepEveryDays: 0 }],
      },
    };
    const history = [
      snapshot("h1", OBJECT_A, 1, 400),
      snapshot("h2", OBJECT_A, 2, 200),
      snapshot("h3", OBJECT_A, 3, 0), // newest, always kept anyway
    ];
    const ctx = workerContext(new MemoryStorage());
    const { store, pruned } = fakeStore({
      policies: [aggressive],
      holds: { tenantWide: false, protectedObjectIds: new Set([OBJECT_A]) },
      snapshots: history,
      mirrored: new Map(),
    });
    const handler = createRetentionHandler(
      new RetentionTaskRegistry([createSnapshotRetentionTask(() => store)]),
    );
    const outcome = await handler.run(ctx, { jobId: JOB, tenantId: TENANT });
    // Both overdue points (h1, h2) would be due under the aggressive policy,
    // but the legal hold on OBJECT_A suspends pruning for all of them.
    expect(pruned).toEqual([]);
    expect(outcome?.summary?.snapshots).toMatchObject({ candidates: 0, held: 2, pruned: 0 });
  });

  it("keeps a legacy row's own newest-N (keepLast) regardless of age, on top of its years cutoff", async () => {
    const legacy: RetentionPolicyRow = {
      id: "p-legacy",
      name: "Old policy",
      isDefault: true,
      appliesTo: { target: "snapshots", keepLast: 2 },
      years: 1,
    };
    const history = [
      snapshot("l1", OBJECT_A, 1, 500), // past the years cutoff, outside the newest 2: pruned
      snapshot("l2", OBJECT_A, 2, 400), // past the years cutoff, but within the newest 2: kept
      snapshot("l3", OBJECT_A, 3, 10), // newest, within the cutoff anyway
    ];
    const ctx = workerContext(new MemoryStorage());
    const { store, pruned } = fakeStore({
      policies: [legacy],
      holds: { tenantWide: false, protectedObjectIds: new Set() },
      snapshots: history,
      mirrored: new Map(),
    });
    const handler = createRetentionHandler(
      new RetentionTaskRegistry([createSnapshotRetentionTask(() => store)]),
    );
    await handler.run(ctx, { jobId: JOB, tenantId: TENANT });
    expect(pruned).toEqual(["l1"]);
  });

  it("never removes the newest verified restore point, even with several verified points under an aggressive custom policy", async () => {
    const aggressive: RetentionPolicyRow = {
      id: "p3",
      name: "Aggressive",
      isDefault: true,
      appliesTo: {
        target: "snapshots",
        preset: "custom",
        tiers: [{ fromDays: 0, toDays: 1, keepEveryDays: 0 }],
      },
    };
    const history = [
      // Both verified and both long past the cutoff; only the newer of the
      // two (v2) is protected, v1 is due for pruning.
      snapshot("v1", OBJECT_A, 1, 400, { verified: true }),
      snapshot("v2", OBJECT_A, 2, 200, { verified: true }),
      // Newest overall, unverified: kept on its own too.
      snapshot("n1", OBJECT_A, 3, 0),
    ];
    const ctx = workerContext(new MemoryStorage());
    const { store, pruned } = fakeStore({
      policies: [aggressive],
      holds: { tenantWide: false, protectedObjectIds: new Set() },
      snapshots: history,
      mirrored: new Map(),
    });
    const handler = createRetentionHandler(
      new RetentionTaskRegistry([createSnapshotRetentionTask(() => store)]),
    );
    await handler.run(ctx, { jobId: JOB, tenantId: TENANT });
    expect(pruned).toEqual(["v1"]);
  });

  it("reports without pruning in a dry run", async () => {
    const ctx = workerContext(new MemoryStorage());
    const { store, pruned } = fakeStore({
      policies: [policy30],
      holds: { tenantWide: false, protectedObjectIds: new Set() },
      snapshots,
      mirrored: new Map(),
    });
    const handler = createRetentionHandler(
      new RetentionTaskRegistry([createSnapshotRetentionTask(() => store)]),
    );
    const outcome = await handler.run(ctx, { jobId: JOB, tenantId: TENANT, dryRun: true });
    expect(pruned).toEqual([]);
    expect(outcome?.summary?.snapshots).toMatchObject({ candidates: 3, pruned: 0, dryRun: true });
    expect(ctx.progress.snapshot().phase).toBe("evaluate");
  });

  it("records a failed prune as an item failure and continues", async () => {
    const ctx = workerContext(new MemoryStorage());
    const { store } = fakeStore({
      policies: [policy30],
      holds: { tenantWide: false, protectedObjectIds: new Set() },
      snapshots,
      mirrored: new Map(),
    });
    let first = true;
    const failing: RetentionStore = {
      ...store,
      async markPruned(id) {
        if (first) {
          first = false;
          throw new Error("deadlock detected");
        }
        return store.markPruned(id);
      },
    };
    const handler = createRetentionHandler(
      new RetentionTaskRegistry([createSnapshotRetentionTask(() => failing)]),
    );
    const outcome = await handler.run(ctx, { jobId: JOB, tenantId: TENANT });
    expect(outcome?.summary?.snapshots).toMatchObject({ candidates: 3, pruned: 2 });
    expect(ctx.progress.snapshot()).toMatchObject({ done: 2, failed: 1 });
  });

  it("runs every registered task and refuses duplicate names", () => {
    const registry = new RetentionTaskRegistry([createSnapshotRetentionTask()]);
    expect(() => registry.register(createSnapshotRetentionTask())).toThrow(/already registered/);
    registry.register({ name: "archive", run: async () => ({}) });
    expect(registry.list().map((task) => task.name)).toEqual(["snapshots", "archive"]);
  });
});
