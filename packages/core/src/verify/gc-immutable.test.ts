import { describe, expect, it } from "vitest";
import { noopLogger } from "../engine/logger.js";
import { changeImmutability, ImmutableStorageBackend } from "../storage/immutability.js";
import type { PackCatalog } from "./catalog.js";
import { releaseSupersededPacks, type ScrubEnvironment, sweepOrphanPacks } from "./gc.js";
import { MemoryStorage } from "./testing.js";

/**
 * Garbage collection on a target with immutable backups: a pack file the
 * target still locks is not deleted, is counted as deferred, and stays on the
 * list for a later run, which deletes it once the lock has run out.
 */

const DAY = 86_400_000;
const TENANT = "0f0e0d0c-0b0a-4908-8706-050403020100";

function fixture() {
  let now = Date.now();
  const clock = () => new Date(now);
  const primary = new MemoryStorage(clock);
  const locked = new ImmutableStorageBackend(primary, {
    settings: changeImmutability(null, { mode: "delayed_deletion", days: 7 }, clock()),
    now: clock,
  });
  const copy = new MemoryStorage(clock);
  const env: ScrubEnvironment = {
    tenantId: TENANT,
    storage: { primary: locked, copies: [copy] },
    keys: { open: () => Buffer.alloc(0) } as unknown as ScrubEnvironment["keys"],
    catalog: { listPacks: async () => [] } as unknown as PackCatalog,
    logger: noopLogger,
    signal: new AbortController().signal,
    now: clock,
  };
  return { env, primary, copy, advance: (ms: number) => (now += ms), clock };
}

describe("garbage collection on an immutable target", () => {
  it("keeps a superseded pack the target still locks, and deletes it once the lock ran out", async () => {
    const { env, primary, copy, advance, clock } = fixture();
    const path = `tenants/${TENANT}/packs/ab/old`;
    await env.storage.primary.put(path, Buffer.from("old pack"));
    await copy.put(path, Buffer.from("old pack"));
    advance(2 * DAY);
    const superseded = [
      { path, size: 8, supersededAt: new Date(clock().getTime() - DAY).toISOString() },
    ];

    const first = await releaseSupersededPacks(env, superseded, 0);
    expect(first).toMatchObject({ released: 0, deferredByLock: 1 });
    expect(first.pending.map((pack) => pack.path)).toEqual([path]);
    expect(primary.files.has(path)).toBe(true);
    // The copy without a lock let it go already; that is no reason to forget the primary's.
    expect(copy.files.has(path)).toBe(false);

    advance(6 * DAY);
    const second = await releaseSupersededPacks(env, first.pending, 0);
    expect(second).toMatchObject({ released: 1, deferredByLock: 0, pending: [] });
    expect(primary.files.has(path)).toBe(false);
  });

  it("counts a locked orphan as deferred instead of failing the sweep", async () => {
    const { env, primary, advance } = fixture();
    const path = `tenants/${TENANT}/packs/cd/orphan`;
    await env.storage.primary.put(path, Buffer.from("orphan"));
    advance(2 * DAY);
    const sweep = await sweepOrphanPacks(env, DAY);
    expect(sweep).toEqual({ removed: 0, bytes: 0, kept: 1, deferredByLock: 1 });
    expect(primary.files.has(path)).toBe(true);
    advance(6 * DAY);
    expect(await sweepOrphanPacks(env, DAY)).toMatchObject({ removed: 1, deferredByLock: 0 });
  });
});
