import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveMaintenanceRepository } from "../endpoints/loopback.js";
import { MemoryStorage } from "../verify/testing.js";
import type { StorageBackend } from "./backend.js";
import {
  type DeletionDecision,
  type DeletionGuard,
  installDeletionEnforcement,
  withDeletionPermit,
} from "./deletion-guard.js";
import {
  compareStorageProgress,
  parseProgressMarkerKey,
  progressFolderOf,
  progressMarkerKey,
  pruneProgressMarkers,
  resetProgressMarkerThrottle,
  withProgressMarkers,
} from "./progress-marker.js";
import {
  RestoreModeGuard,
  type RestoreModeSnapshot,
  type RestoreModeStore,
} from "./restore-mode-guard.js";
import { WriteOnceBackend } from "./testing/write-once-backend.js";

const T = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const INSTALLATION = "inst-1";

/** The database side of the counter, in memory. */
class Counter {
  seq = 0;
  async allocate(): Promise<number> {
    this.seq += 1;
    return this.seq;
  }
}

function markers(storage: MemoryStorage, counter: Counter, now = () => new Date()) {
  return withProgressMarkers(storage, {
    tenantId: T,
    targetId: "primary",
    allocate: () => counter.allocate(),
    installationId: async () => INSTALLATION,
    writer: "worker",
    intervalMs: 60_000,
    now,
  });
}

beforeEach(() => {
  resetProgressMarkerThrottle();
});

describe("progress marker keys", () => {
  it("lays markers out in folders of a thousand, sorted by value", () => {
    expect(progressMarkerKey(T, 1)).toBe(
      `tenants/${T}/progress/000000000000/00000000000000000001.json`,
    );
    expect(progressMarkerKey(T, 12_345)).toBe(
      `tenants/${T}/progress/000000000012/00000000000000012345.json`,
    );
    expect(progressFolderOf(999)).toBe(0);
    expect(progressFolderOf(1000)).toBe(1);
    expect(parseProgressMarkerKey(progressMarkerKey(T, 12_345))).toEqual({
      tenantId: T,
      seq: 12_345,
    });
    // A key in the wrong folder is not a marker.
    expect(
      parseProgressMarkerKey(`tenants/${T}/progress/000000000001/00000000000000000002.json`),
    ).toBeNull();
  });
});

describe("writing markers", () => {
  it("writes a marker before the first data write, then at most once per interval", async () => {
    const storage = new MemoryStorage();
    const counter = new Counter();
    let now = new Date("2026-11-05T10:00:00Z");
    const backend = markers(storage, counter, () => now);
    const order: string[] = [];
    const original = storage.put.bind(storage);
    storage.put = async (key: string, data: Buffer | Readable) => {
      order.push(key.includes("/progress/") ? "marker" : "data");
      return original(key, data);
    };
    await backend.put(`tenants/${T}/packs/ab/one`, Buffer.from("1"));
    await backend.put(`tenants/${T}/packs/ab/two`, Buffer.from("2"));
    now = new Date(now.getTime() + 61_000);
    await backend.put(`tenants/${T}/packs/ab/three`, Buffer.from("3"));
    expect(order).toEqual(["marker", "data", "data", "marker", "data"]);
    const listed = await storage.list(`tenants/${T}/progress/`);
    expect(listed).toEqual([progressMarkerKey(T, 1), progressMarkerKey(T, 2)]);
    const body = JSON.parse((await storage.get(progressMarkerKey(T, 2))).toString());
    expect(body).toMatchObject({ format: 1, installationId: INSTALLATION, tenantId: T, seq: 2 });
  });

  it("fails the data write when the marker cannot be written", async () => {
    const storage = new MemoryStorage();
    const backend = withProgressMarkers(storage, {
      tenantId: T,
      targetId: "primary",
      allocate: async () => {
        throw new Error("database down");
      },
      installationId: async () => INSTALLATION,
      writer: "worker",
    });
    await expect(backend.put(`tenants/${T}/packs/ab/one`, Buffer.from("1"))).rejects.toThrow(
      /progress marker/,
    );
    expect(await storage.head(`tenants/${T}/packs/ab/one`)).toBeNull();
  });

  it("writes new marker objects only, so a write-once target keeps working", async () => {
    const inner = new MemoryStorage();
    const worm = new WriteOnceBackend(inner);
    const counter = new Counter();
    let now = new Date("2026-11-05T10:00:00Z");
    const backend = withProgressMarkers(worm, {
      tenantId: T,
      targetId: "worm",
      allocate: () => counter.allocate(),
      installationId: async () => INSTALLATION,
      writer: "worker",
      now: () => now,
    });
    for (let index = 0; index < 3; index++) {
      await backend.put(`tenants/${T}/packs/ab/${index}`, Buffer.from(String(index)));
      now = new Date(now.getTime() + 120_000);
    }
    expect(worm.refused).toEqual([]);
    expect(await inner.list(`tenants/${T}/progress/`)).toHaveLength(3);
  });

  it("allocates again when the value's marker exists already (the storage is ahead)", async () => {
    const storage = new MemoryStorage();
    await storage.put(progressMarkerKey(T, 1), Buffer.from("{}"));
    const counter = new Counter();
    const collisions: number[] = [];
    const backend = withProgressMarkers(storage, {
      tenantId: T,
      targetId: "primary",
      allocate: () => counter.allocate(),
      installationId: async () => INSTALLATION,
      writer: "worker",
      onCollision: async (_tenant, seq) => {
        collisions.push(seq);
        counter.seq = 5000;
      },
    });
    await backend.put(`tenants/${T}/packs/ab/one`, Buffer.from("1"));
    expect(collisions).toEqual([1]);
    expect(await storage.head(progressMarkerKey(T, 5001))).not.toBeNull();
  });
});

describe("comparing the storage with the database", () => {
  async function compare(storage: StorageBackend, dbSeq: () => Promise<number>, keyMax = 1) {
    return compareStorageProgress({
      tenantId: T,
      targetId: "primary",
      backend: storage,
      readDbSeq: dbSeq,
      readDbKeyMax: async () => keyMax,
      installationId: INSTALLATION,
    });
  }

  it("is ok on a healthy installation, also when a value is allocated during the listing", async () => {
    const storage = new MemoryStorage();
    const counter = new Counter();
    const backend = markers(storage, counter);
    await backend.put(`tenants/${T}/packs/ab/one`, Buffer.from("1"));
    // A writer allocates the next value between the listing and the read: the database is ahead,
    // never the storage.
    const result = await compare(storage, async () => {
      await counter.allocate();
      return counter.seq;
    });
    expect(result).toMatchObject({ outcome: "ok", storageMaxSeq: 1, dbSeq: 2, aheadSeq: null });
  });

  it("says none without markers (a fresh installation, an upgrade from before 0.5.0)", async () => {
    expect((await compare(new MemoryStorage(), async () => 0)).outcome).toBe("none");
  });

  it("is ahead when a marker of this installation is above the database", async () => {
    const storage = new MemoryStorage();
    const counter = new Counter();
    let now = new Date("2026-11-05T10:00:00Z");
    const backend = markers(storage, counter, () => now);
    for (let index = 0; index < 4; index++) {
      await backend.put(`tenants/${T}/packs/ab/${index}`, Buffer.from("x"));
      now = new Date(now.getTime() + 120_000);
    }
    // The database was restored from a dump taken at value 2.
    const result = await compare(storage, async () => 2);
    expect(result).toMatchObject({ outcome: "ahead", storageMaxSeq: 4, aheadSeq: 4, dbSeq: 2 });
  });

  it("is ahead when storage holds a key version the database lacks", async () => {
    const storage = new MemoryStorage();
    await storage.put(`tenants/${T}/keys/1`, Buffer.from("a"));
    await storage.put(`tenants/${T}/keys/2`, Buffer.from("b"));
    const result = await compare(storage, async () => 0, 1);
    expect(result).toMatchObject({ outcome: "ahead", unknownKeyVersions: [2] });
  });

  it("only warns about markers of another installation", async () => {
    const storage = new MemoryStorage();
    await storage.put(
      progressMarkerKey(T, 7),
      Buffer.from(JSON.stringify({ format: 1, installationId: "other", tenantId: T, seq: 7 })),
    );
    expect((await compare(storage, async () => 0)).outcome).toBe("foreign");
  });

  it("is unreachable when the target cannot be listed", async () => {
    const storage = new MemoryStorage();
    storage.list = async () => {
      throw new Error("connection refused");
    };
    expect((await compare(storage, async () => 3)).outcome).toBe("unreachable");
  });

  it("prunes old folders but keeps the current one and the one before", async () => {
    const storage = new MemoryStorage();
    for (const seq of [5, 1005, 2005, 3005]) {
      await storage.put(progressMarkerKey(T, seq), Buffer.from("{}"));
    }
    const removed = await pruneProgressMarkers(storage, T, 3005);
    expect(removed).toBe(2);
    expect(await storage.list(`tenants/${T}/progress/`)).toEqual([
      progressMarkerKey(T, 2005),
      progressMarkerKey(T, 3005),
    ]);
  });
});

/** A restore mode store in memory. */
class MemoryStore implements RestoreModeStore {
  state: RestoreModeSnapshot = {
    active: false,
    id: null,
    activatedAt: null,
    holdJobsBefore: null,
    keepUnknownBefore: null,
  };
  dbSeq = 0;
  keyMax = 1;
  readonly refusals: string[] = [];
  readonly activations: unknown[] = [];

  async read() {
    return this.state;
  }
  async readDbSeq() {
    return this.dbSeq;
  }
  async readDbKeyMax() {
    return this.keyMax;
  }
  async installationId() {
    return INSTALLATION;
  }
  async recordCheck() {}
  async activateDetected(detection: unknown) {
    this.activations.push(detection);
    const created = !this.state.active;
    const now = new Date();
    this.state = { ...this.state, active: true, id: "rm-1", activatedAt: now, holdJobsBefore: now };
    return { id: "rm-1", created };
  }
  async recordRefusal(input: { pass: string }) {
    this.refusals.push(input.pass);
  }
  async rebaseAbove(_tenantId: string, to: number) {
    this.dbSeq = Math.max(this.dbSeq, to);
  }
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return logger;
  },
};

describe("the restore mode guard", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("switches restore mode on by itself when the storage is ahead, and refuses the pass", async () => {
    const storage = new MemoryStorage();
    await storage.put(
      progressMarkerKey(T, 9),
      Buffer.from(JSON.stringify({ installationId: INSTALLATION })),
    );
    const store = new MemoryStore();
    store.dbSeq = 4;
    const guard = new RestoreModeGuard({
      store,
      targetsOf: async () => [{ id: "primary", backend: storage }],
      logger,
    });
    const decision: DeletionDecision = await guard.decide({ pass: "orphan_sweep", tenantId: T });
    expect(decision).toMatchObject({
      allowed: false,
      reason: "restore_mode",
      restoreModeId: "rm-1",
    });
    expect(store.activations).toHaveLength(1);
    expect(store.refusals).toEqual(["orphan_sweep"]);
    // The database's value is lifted above the storage's, so new markers never collide.
    expect(store.dbSeq).toBeGreaterThan(9);
    expect(guard.holding()).toBe(true);
  });

  it("allows deleting on a healthy installation and keeps the comparison for a while", async () => {
    const storage = new MemoryStorage();
    await storage.put(
      progressMarkerKey(T, 3),
      Buffer.from(JSON.stringify({ installationId: INSTALLATION })),
    );
    const store = new MemoryStore();
    store.dbSeq = 3;
    let lists = 0;
    const counting: StorageBackend = Object.assign(Object.create(storage) as MemoryStorage, {
      list: async (prefix: string) => {
        lists++;
        return storage.list(prefix);
      },
    });
    const guard = new RestoreModeGuard({
      store,
      targetsOf: async () => [{ id: "primary", backend: counting }],
      logger,
    });
    expect((await guard.decide({ pass: "orphan_sweep", tenantId: T })).allowed).toBe(true);
    expect((await guard.decide({ pass: "gc_repack", tenantId: T })).allowed).toBe(true);
    expect(lists).toBe(2);
    expect(store.activations).toEqual([]);
  });

  it("refuses while a target cannot be read, without switching restore mode on", async () => {
    const storage = new MemoryStorage();
    storage.list = async () => {
      throw new Error("timeout");
    };
    const store = new MemoryStore();
    const guard = new RestoreModeGuard({
      store,
      targetsOf: async () => [{ id: "copy", backend: storage }],
      logger,
    });
    expect(await guard.decide({ pass: "snapshot_retention", tenantId: T })).toMatchObject({
      allowed: false,
      reason: "progress_unknown",
    });
    expect(store.state.active).toBe(false);
  });

  async function ourMarker(storage: MemoryStorage, seq: number): Promise<void> {
    await storage.put(
      progressMarkerKey(T, seq),
      Buffer.from(JSON.stringify({ format: 1, installationId: INSTALLATION, tenantId: T, seq })),
    );
  }

  it("takes a collision with its own marker as the detection (storage one value ahead)", async () => {
    // The dump holds value 5, storage holds markers 1 to 6: one short backup after the dump.
    const storage = new MemoryStorage();
    for (let seq = 1; seq <= 6; seq++) {
      await ourMarker(storage, seq);
    }
    const store = new MemoryStore();
    store.dbSeq = 5;
    const guard = new RestoreModeGuard({
      store,
      targetsOf: async () => [{ id: "primary", backend: storage }],
      logger,
    });
    const backend = withProgressMarkers(storage, {
      tenantId: T,
      targetId: "primary",
      allocate: async () => ++store.dbSeq,
      installationId: async () => INSTALLATION,
      writer: "worker",
      onCollision: async (tenantId, seq, collision) => {
        await guard.markerCollision(
          tenantId,
          { id: "primary", backend: storage },
          seq,
          collision.ours,
        );
      },
    });
    await backend.put(`tenants/${T}/packs/ab/one`, Buffer.from("1"));
    // The comparison alone would have seen storage 6 and database 6 and said "ok".
    expect(store.activations).toEqual([
      expect.objectContaining({ targetId: "primary", markerSeq: 6, dbSeq: 5 }),
    ]);
    expect(store.state.active).toBe(true);
    // The new marker lies above everything storage had; a later comparison still refuses.
    const written = (await storage.list(`tenants/${T}/progress/`))
      .map((key) => parseProgressMarkerKey(key)?.seq ?? 0)
      .sort((a, b) => b - a)[0];
    expect(written).toBeGreaterThan(1_000_000);
    expect(await guard.decide({ pass: "orphan_sweep", tenantId: T })).toMatchObject({
      allowed: false,
      reason: "restore_mode",
    });
  });

  it("does not take a collision with another installation's marker as a detection", async () => {
    const storage = new MemoryStorage();
    await storage.put(
      progressMarkerKey(T, 1),
      Buffer.from(JSON.stringify({ format: 1, installationId: "other", tenantId: T, seq: 1 })),
    );
    const store = new MemoryStore();
    const guard = new RestoreModeGuard({
      store,
      targetsOf: async () => [{ id: "primary", backend: storage }],
      logger,
    });
    const backend = withProgressMarkers(storage, {
      tenantId: T,
      targetId: "primary",
      allocate: async () => ++store.dbSeq,
      installationId: async () => INSTALLATION,
      writer: "worker",
      onCollision: async (tenantId, seq, collision) => {
        await guard.markerCollision(
          tenantId,
          { id: "primary", backend: storage },
          seq,
          collision.ours,
        );
      },
    });
    await backend.put(`tenants/${T}/packs/ab/one`, Buffer.from("1"));
    expect(store.activations).toEqual([]);
    expect(await storage.head(progressMarkerKey(T, 2))).not.toBeNull();
  });

  it("compares before the first allocation, so values interleaved on primary and copy are seen", async () => {
    // After the dump (value 5) value 6 went to the copy and 7 to the primary. Without the
    // comparison first, the primary's writer would take 6 (free there) and the copy's 7, and the
    // database would have caught up with storage before any comparison.
    const primary = new MemoryStorage();
    const copy = new MemoryStorage();
    await ourMarker(copy, 6);
    await ourMarker(primary, 7);
    const store = new MemoryStore();
    store.dbSeq = 5;
    const targets = [
      { id: "primary", backend: primary },
      { id: "copy", backend: copy },
    ];
    const guard = new RestoreModeGuard({ store, targetsOf: async () => targets, logger });
    const allocated: number[] = [];
    const writer = (backend: MemoryStorage, targetId: string) =>
      withProgressMarkers(backend, {
        tenantId: T,
        targetId,
        allocate: async () => {
          allocated.push(store.dbSeq + 1);
          return ++store.dbSeq;
        },
        installationId: async () => INSTALLATION,
        writer: "api",
        beforeFirstAllocation: (tenantId) => guard.compareBeforeFirstAllocation(tenantId),
        onCollision: async (tenantId, seq, collision) => {
          await guard.markerCollision(tenantId, { id: targetId, backend }, seq, collision.ours);
        },
      });
    await writer(primary, "primary").put(`tenants/${T}/packs/ab/one`, Buffer.from("1"));
    await writer(copy, "copy").put(`tenants/${T}/packs/ab/one`, Buffer.from("1"));
    expect(store.activations).toEqual([
      expect.objectContaining({ targetId: "primary", markerSeq: 7, dbSeq: 5 }),
    ]);
    // Both writers allocated above everything storage had.
    expect(allocated.every((seq) => seq > 7)).toBe(true);
  });

  it("compares only once before the first allocation on a healthy installation", async () => {
    const storage = new MemoryStorage();
    await ourMarker(storage, 3);
    const store = new MemoryStore();
    store.dbSeq = 3;
    let compared = 0;
    const guard = new RestoreModeGuard({
      store,
      targetsOf: async () => {
        compared++;
        return [{ id: "primary", backend: storage }];
      },
      logger,
    });
    let now = new Date("2026-11-05T10:00:00Z");
    const backend = withProgressMarkers(storage, {
      tenantId: T,
      targetId: "primary",
      allocate: async () => ++store.dbSeq,
      installationId: async () => INSTALLATION,
      writer: "worker",
      now: () => now,
      beforeFirstAllocation: (tenantId) => guard.compareBeforeFirstAllocation(tenantId),
    });
    for (let index = 0; index < 3; index++) {
      await backend.put(`tenants/${T}/packs/ab/${index}`, Buffer.from("x"));
      now = new Date(now.getTime() + 120_000);
    }
    expect(compared).toBe(1);
    expect(store.activations).toEqual([]);
    expect(await storage.list(`tenants/${T}/progress/`)).toHaveLength(4);
  });

  it("refuses restic's deletes through the loopback without the pass's permit", async () => {
    const storage = new MemoryStorage();
    const store = new MemoryStore();
    const guard = new RestoreModeGuard({ store, targetsOf: async () => [], logger });
    uninstall = installDeletionEnforcement(guard satisfies DeletionGuard, { strict: true });
    await storage.put(
      "endpoints/e1/data/ab/abcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      Buffer.from("pack"),
    );
    const remove = async (repository: Awaited<ReturnType<typeof serveMaintenanceRepository>>) => {
      const url = repository.url.replace(/^rest:/, "");
      const response = await fetch(
        `${url}data/abcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc`,
        {
          method: "DELETE",
          headers: {
            authorization: `Basic ${Buffer.from(`${repository.username}:${repository.password}`).toString("base64")}`,
          },
        },
      );
      return response.status;
    };
    // Started outside any pass: restic's delete is not a pass's.
    const outside = await serveMaintenanceRepository(storage, "endpoints/e1/");
    try {
      expect(await remove(outside)).toBe(500);
    } finally {
      await outside.close();
    }
    expect(
      await storage.head(
        "endpoints/e1/data/ab/abcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      ),
    ).not.toBeNull();
    await withDeletionPermit({ pass: "endpoint_retention", tenantId: T }, async () => {
      const inside = await serveMaintenanceRepository(storage, "endpoints/e1/");
      try {
        expect(await remove(inside)).toBe(200);
      } finally {
        await inside.close();
      }
    });
    expect(
      await storage.head(
        "endpoints/e1/data/ab/abcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      ),
    ).toBeNull();
  });
});
