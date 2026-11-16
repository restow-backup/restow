import { afterEach, describe, expect, it } from "vitest";
import { noopLogger } from "../engine/logger.js";
import { mirrorItem } from "../storage/copy.js";
import {
  type DeletionDecision,
  type DeletionGuard,
  type DeletionRequest,
  installDeletionEnforcement,
} from "../storage/deletion-guard.js";
import type { PackCatalog } from "./catalog.js";
import { releaseSupersededPacks, type ScrubEnvironment, sweepOrphanPacks } from "./gc.js";
import { MemoryStorage } from "./testing.js";

/**
 * Garbage collection after restoring a database dump: while restore mode is on, the orphan
 * sweep and the release of superseded packs delete nothing (every pack written after the dump
 * has no catalog row), and once it ended with "keep" the orphans from before its end stay for
 * good while newer ones are swept again.
 */

const DAY = 86_400_000;
const TENANT = "3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d";

class SwitchGuard implements DeletionGuard {
  active = false;
  keepUnknownBefore: Date | null = null;
  readonly refused: DeletionRequest[] = [];
  async decide(request: DeletionRequest): Promise<DeletionDecision> {
    if (this.active) {
      this.refused.push(request);
      return { allowed: false, reason: "restore_mode", restoreModeId: "rm" };
    }
    return { allowed: true, keepUnknownBefore: this.keepUnknownBefore, inRestoreMode: false };
  }
  holding() {
    return this.active;
  }
}

function fixture() {
  let now = Date.now();
  const clock = () => new Date(now);
  const primary = new MemoryStorage(clock);
  const copy = new MemoryStorage(clock);
  const env: ScrubEnvironment = {
    tenantId: TENANT,
    storage: { primary, copies: [copy] },
    keys: { open: () => Buffer.alloc(0) } as unknown as ScrubEnvironment["keys"],
    catalog: { listPacks: async () => [] } as unknown as PackCatalog,
    logger: noopLogger,
    signal: new AbortController().signal,
    now: clock,
  };
  return { env, primary, copy, advance: (ms: number) => (now += ms), clock };
}

describe("garbage collection in restore mode", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("sweeps no orphan and releases no superseded pack while restore mode is on [RETAIN-008]", async () => {
    const guard = new SwitchGuard();
    uninstall = installDeletionEnforcement(guard, { strict: true });
    const { env, primary, copy, advance } = fixture();
    const path = `tenants/${TENANT}/packs/ab/after-the-dump`;
    await primary.put(path, Buffer.from("pack"));
    await copy.put(path, Buffer.from("pack"));
    advance(3 * DAY);
    guard.active = true;
    expect(await sweepOrphanPacks(env, DAY)).toEqual({
      removed: 0,
      bytes: 0,
      kept: 0,
      deferredByLock: 0,
      held: true,
    });
    const superseded = [{ path, size: 4, supersededAt: new Date(0).toISOString() }];
    const release = await releaseSupersededPacks(env, superseded, DAY);
    expect(release).toMatchObject({ released: 0, pending: superseded });
    expect(primary.files.has(path)).toBe(true);
    expect(copy.files.has(path)).toBe(true);
    expect(guard.refused.map((request) => request.pass)).toEqual([
      "orphan_sweep",
      "superseded_release",
    ]);
  });

  it("keeps orphans from before a restore mode that ended with keep, sweeps newer ones", async () => {
    const guard = new SwitchGuard();
    uninstall = installDeletionEnforcement(guard, { strict: true });
    const { env, primary, advance, clock } = fixture();
    const old = `tenants/${TENANT}/packs/ab/kept`;
    await primary.put(old, Buffer.from("old"));
    advance(DAY);
    guard.keepUnknownBefore = clock();
    advance(DAY);
    const fresh = `tenants/${TENANT}/packs/cd/new-orphan`;
    await primary.put(fresh, Buffer.from("new"));
    advance(2 * DAY);
    const sweep = await sweepOrphanPacks(env, DAY);
    expect(sweep).toMatchObject({ removed: 1, kept: 1 });
    expect(primary.files.has(old)).toBe(true);
    expect(primary.files.has(fresh)).toBe(false);
  });
});

describe("the copy mirror and wrapped keys", () => {
  it("never overwrites a differing key on a copy and reports it [CRYPT-004]", async () => {
    const source = new MemoryStorage();
    const target = new MemoryStorage();
    const key = `tenants/${TENANT}/keys/2`;
    await source.put(key, Buffer.from("database key"));
    await target.put(key, Buffer.from("key written after the dump"));
    const outcome = await mirrorItem(
      { source, target, items: [], verify: "hash" },
      { key, size: null, sha256: null },
    );
    expect(outcome.outcome).toBe("key_conflict");
    expect((await target.get(key)).toString()).toBe("key written after the dump");
    // A missing key is still copied.
    await source.put(`tenants/${TENANT}/keys/3`, Buffer.from("three"));
    expect(
      (
        await mirrorItem(
          { source, target, items: [], verify: "hash" },
          { key: `tenants/${TENANT}/keys/3`, size: null, sha256: null },
        )
      ).outcome,
    ).toBe("copied");
  });
});
