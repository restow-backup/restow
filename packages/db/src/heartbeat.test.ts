import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_FRESH_MS,
  HEARTBEAT_INTERVAL_MS,
  type HeartbeatRow,
  type HeartbeatStore,
  ServiceHeartbeatReporter,
  heartbeatHostname,
  serviceVersion,
} from "./heartbeat.js";

class MemoryStore implements HeartbeatStore {
  readonly rows = new Map<string, HeartbeatRow>();
  readonly writes: HeartbeatRow[] = [];
  readonly pruned: Array<{ instanceId: string; olderThanMs: number }> = [];
  failNextUpserts = 0;
  failRemove = false;

  async upsert(row: HeartbeatRow): Promise<void> {
    if (this.failNextUpserts > 0) {
      this.failNextUpserts -= 1;
      throw new Error("database is down");
    }
    this.writes.push(structuredClone(row));
    this.rows.set(row.instanceId, row);
  }

  async remove(instanceId: string): Promise<void> {
    if (this.failRemove) {
      throw new Error("database is down");
    }
    this.rows.delete(instanceId);
  }

  async prune(instanceId: string, olderThanMs: number): Promise<void> {
    this.pruned.push({ instanceId, olderThanMs });
  }
}

describe("heartbeat constants", () => {
  it("beats every 30 seconds and counts a beat younger than 2 minutes as alive", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(HEARTBEAT_FRESH_MS).toBe(120_000);
  });
});

describe("heartbeatHostname", () => {
  it("keeps host and container names", () => {
    expect(heartbeatHostname("restow-worker-1")).toBe("restow-worker-1");
    expect(heartbeatHostname(" 3f9a1c2b7d10 ")).toBe("3f9a1c2b7d10");
    // A container id can be all digits; that is still a name.
    expect(heartbeatHostname("123456789012")).toBe("123456789012");
  });

  it("never reports an IP address or an empty name", () => {
    for (const value of ["10.0.0.7", "::1", "fe80::1%eth0", "::ffff:192.0.2.1", "", "  ", null]) {
      expect(heartbeatHostname(value), String(value)).toBeNull();
    }
    expect(heartbeatHostname(undefined)).toBeNull();
  });
});

describe("serviceVersion", () => {
  it("reads the version of the image without the tag prefix", () => {
    expect(serviceVersion({ RESTOW_VERSION: "v0.2.1" })).toBe("0.2.1");
    expect(serviceVersion({ RESTOW_VERSION: " 0.1.0-rc.1 " })).toBe("0.1.0-rc.1");
  });

  it("names a local build", () => {
    expect(serviceVersion({})).toBe("0.0.0-dev");
    expect(serviceVersion({ RESTOW_VERSION: "  " })).toBe("0.0.0-dev");
  });
});

describe("ServiceHeartbeatReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function heartbeat(
    store: MemoryStore,
    extra: Partial<ConstructorParameters<typeof ServiceHeartbeatReporter>[0]> = {},
  ) {
    let state = "running";
    const errors: unknown[] = [];
    const beat = new ServiceHeartbeatReporter({
      store,
      role: "worker",
      version: "0.1.0",
      hostname: "restow-worker-1",
      instanceId: "worker-test",
      details: () => ({ state, queues: ["backup"] }),
      onError: (error) => errors.push(error),
      ...extra,
    });
    return {
      beat,
      errors,
      setState: (value: string) => {
        state = value;
      },
    };
  }

  it("reports in at once and then every 30 seconds with the role, version, start and state", async () => {
    const store = new MemoryStore();
    const startedAt = new Date("2026-09-30T10:00:00Z");
    const { beat } = heartbeat(store, { now: () => startedAt });

    await beat.start();
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toEqual({
      role: "worker",
      instanceId: "worker-test",
      version: "0.1.0",
      hostname: "restow-worker-1",
      startedAt,
      details: { state: "running", queues: ["backup"] },
    });
    expect(store.pruned).toEqual([{ instanceId: "worker-test", olderThanMs: 24 * 3_600_000 }]);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(store.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.writes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.writes).toHaveLength(4);
    // The start time is that of the process, not of the beat.
    expect(new Set(store.writes.map((row) => row.startedAt.getTime()))).toEqual(
      new Set([startedAt.getTime()]),
    );
    await beat.stop();
  });

  it("reports the state it has at the time of the beat", async () => {
    const store = new MemoryStore();
    const { beat, setState } = heartbeat(store);
    await beat.start();
    setState("stopping");
    await beat.beat();
    expect(store.writes.map((row) => row.details.state)).toEqual(["running", "stopping"]);
    await beat.stop();
  });

  it("removes its row on a graceful stop and never beats again", async () => {
    const store = new MemoryStore();
    const { beat } = heartbeat(store);
    await beat.start();
    expect(store.rows.has("worker-test")).toBe(true);

    await beat.stop();
    expect(store.rows.has("worker-test")).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * HEARTBEAT_INTERVAL_MS);
    await beat.beat();
    expect(store.rows.has("worker-test")).toBe(false);
    expect(store.writes).toHaveLength(1);
  });

  it("keeps running when the database fails and reports the failure", async () => {
    const store = new MemoryStore();
    store.failNextUpserts = 1;
    const { beat, errors } = heartbeat(store);

    await expect(beat.start()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(store.writes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(store.writes).toHaveLength(1);
    expect(errors).toHaveLength(1);

    store.failRemove = true;
    await expect(beat.stop()).resolves.toBeUndefined();
    expect(errors).toHaveLength(2);
  });

  it("does not let a slow beat overlap the next one", async () => {
    const store = new MemoryStore();
    let slow = false;
    let inFlight = 0;
    let maxInFlight = 0;
    const fastUpsert = store.upsert.bind(store);
    store.upsert = async (row) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (slow) {
        await new Promise((resolve) => setTimeout(resolve, 45_000));
      }
      await fastUpsert(row);
      inFlight -= 1;
    };
    const { beat } = heartbeat(store);
    await beat.start();
    slow = true;
    // Ten minutes pass with every write taking longer than the interval: the ticks
    // that find a write still running are skipped, there is never a second writer.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(maxInFlight).toBe(1);
    const writes = store.writes.length;
    expect(writes).toBeGreaterThan(5);
    expect(writes).toBeLessThan(600 / 45 + 2);
    const stopping = beat.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    await stopping;
    expect(store.rows.has("worker-test")).toBe(false);
  });

  it("gives every process instance its own id by default", () => {
    const store = new MemoryStore();
    const first = new ServiceHeartbeatReporter({ store, role: "scheduler", details: () => ({}) });
    const second = new ServiceHeartbeatReporter({ store, role: "scheduler", details: () => ({}) });
    expect(first.instanceId).toMatch(/^scheduler-[0-9a-f-]{36}$/);
    expect(second.instanceId).not.toBe(first.instanceId);
  });
});
