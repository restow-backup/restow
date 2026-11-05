import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../verify/testing.js";
import {
  assertDeletionPermitted,
  type DeletionDecision,
  type DeletionGuard,
  type DeletionRequest,
  DeletionsHeldError,
  deletionDecision,
  installDeletionEnforcement,
  isAlwaysDeletable,
  KeyOverwriteRefusedError,
  UnguardedDeletionError,
  withDeletionPermit,
  withStorageOperation,
} from "./deletion-guard.js";
import { LocalStorageBackend } from "./local.js";

const T = "8f0c5a8e-7d1b-4c2a-9e3f-1a2b3c4d5e6f";

/** A guard whose restore mode the test switches. */
class TestGuard implements DeletionGuard {
  active = false;
  activatedAt = new Date("2026-11-01T00:00:00Z");
  readonly refused: DeletionRequest[] = [];
  readonly unguarded: { key: string; refused: boolean }[] = [];

  async decide(request: DeletionRequest): Promise<DeletionDecision> {
    if (this.active) {
      if (
        request.pass === "export_reset" &&
        request.createdAt &&
        request.createdAt > this.activatedAt
      ) {
        return { allowed: true, keepUnknownBefore: null, inRestoreMode: true };
      }
      this.refused.push(request);
      return { allowed: false, reason: "restore_mode", restoreModeId: "rm-1" };
    }
    return { allowed: true, keepUnknownBefore: null, inRestoreMode: false };
  }

  holding(): boolean {
    return this.active;
  }

  onUnguarded(key: string, refused: boolean): void {
    this.unguarded.push({ key, refused });
  }
}

describe("the deletion guard", () => {
  let guard: TestGuard;
  let uninstall: () => void;

  beforeEach(() => {
    guard = new TestGuard();
    uninstall = installDeletionEnforcement(guard, { strict: true });
  });

  afterEach(() => {
    uninstall();
  });

  it("lets a pass delete with its permit and refuses it in restore mode", async () => {
    const storage = new MemoryStorage();
    await storage.put(`tenants/${T}/packs/ab/one`, Buffer.from("x"));
    await withDeletionPermit({ pass: "orphan_sweep", tenantId: T }, () =>
      storage.delete(`tenants/${T}/packs/ab/one`),
    );
    expect(await storage.head(`tenants/${T}/packs/ab/one`)).toBeNull();

    await storage.put(`tenants/${T}/packs/ab/two`, Buffer.from("x"));
    guard.active = true;
    await expect(
      withDeletionPermit({ pass: "orphan_sweep", tenantId: T }, () =>
        storage.delete(`tenants/${T}/packs/ab/two`),
      ),
    ).rejects.toBeInstanceOf(DeletionsHeldError);
    expect(await storage.head(`tenants/${T}/packs/ab/two`)).not.toBeNull();
    expect(guard.refused.map((request) => request.pass)).toEqual(["orphan_sweep"]);
  });

  it("refuses a delete that started with a permit once restore mode came on", async () => {
    const storage = new MemoryStorage();
    await storage.put(`tenants/${T}/manifests/a.json.zst`, Buffer.from("x"));
    await expect(
      withDeletionPermit({ pass: "snapshot_retention", tenantId: T }, async () => {
        guard.active = true;
        await storage.delete(`tenants/${T}/manifests/a.json.zst`);
      }),
    ).rejects.toBeInstanceOf(DeletionsHeldError);
    expect(await storage.head(`tenants/${T}/manifests/a.json.zst`)).not.toBeNull();
  });

  it("throws for a delete outside every permit in strict mode, and holds it in restore mode", async () => {
    const storage = new MemoryStorage();
    await storage.put(`tenants/${T}/packs/ab/three`, Buffer.from("x"));
    await expect(storage.delete(`tenants/${T}/packs/ab/three`)).rejects.toBeInstanceOf(
      UnguardedDeletionError,
    );
    guard.active = true;
    await expect(storage.delete(`tenants/${T}/packs/ab/three`)).rejects.toBeInstanceOf(
      DeletionsHeldError,
    );
    expect(guard.unguarded).toEqual([
      { key: `tenants/${T}/packs/ab/three`, refused: false },
      { key: `tenants/${T}/packs/ab/three`, refused: true },
    ]);
  });

  it("always lets restic lock files and probe objects go", async () => {
    guard.active = true;
    const storage = new MemoryStorage();
    for (const key of [
      "endpoints/e1/locks/abc",
      "pve-guests/g1.chain-2/locks/def",
      `tenants/${T}/probes/p1`,
      "installation/probes/p2",
    ]) {
      expect(isAlwaysDeletable(key)).toBe(true);
      await storage.put(key, Buffer.from("x"));
      await storage.delete(key);
    }
    expect(isAlwaysDeletable("endpoints/e1/snapshots/abc")).toBe(false);
    expect(isAlwaysDeletable(`tenants/${T}/progress/000000000000/00000000000000000001.json`)).toBe(
      false,
    );
  });

  it("lets an operation delete what it wrote itself, even in restore mode", async () => {
    guard.active = true;
    const storage = new MemoryStorage();
    await storage.put("endpoints/e2/config", Buffer.from("old"));
    await withStorageOperation(async () => {
      await storage.put("endpoints/e3/config", Buffer.from("mine"));
      await storage.delete("endpoints/e3/config");
      await expect(storage.delete("endpoints/e2/config")).rejects.toBeInstanceOf(
        DeletionsHeldError,
      );
    });
    expect(await storage.head("endpoints/e2/config")).not.toBeNull();
  });

  it("allows a post-activation pass only for rows created after restore mode began", async () => {
    guard.active = true;
    const storage = new MemoryStorage();
    await storage.put(`tenants/${T}/exports/x/0`, Buffer.from("x"));
    await expect(
      withDeletionPermit(
        { pass: "export_reset", tenantId: T, createdAt: new Date("2026-10-01T00:00:00Z") },
        () => storage.delete(`tenants/${T}/exports/x/0`),
      ),
    ).rejects.toBeInstanceOf(DeletionsHeldError);
    await withDeletionPermit(
      { pass: "export_reset", tenantId: T, createdAt: new Date("2026-11-02T00:00:00Z") },
      () => storage.delete(`tenants/${T}/exports/x/0`),
    );
    expect(await storage.head(`tenants/${T}/exports/x/0`)).toBeNull();
  });

  it("checks a local directory and refuses to replace a stored wrapped key", async () => {
    const root = await mkdtemp(join(tmpdir(), "restow-guard-"));
    try {
      const local = new LocalStorageBackend(root);
      await local.put(`tenants/${T}/keys/1`, Buffer.from("key-one"));
      await local.put(`tenants/${T}/keys/1`, Buffer.from("key-one"));
      await expect(local.put(`tenants/${T}/keys/1`, Buffer.from("key-two"))).rejects.toBeInstanceOf(
        KeyOverwriteRefusedError,
      );
      expect((await local.get(`tenants/${T}/keys/1`)).toString()).toBe("key-one");
      guard.active = true;
      await expect(local.delete(`tenants/${T}/keys/1`)).rejects.toBeInstanceOf(DeletionsHeldError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("without an installed guard", () => {
  it("checks nothing (the standalone restore, plain unit tests)", async () => {
    expect(await deletionDecision({ pass: "orphan_sweep", tenantId: T })).toEqual({
      allowed: true,
      keepUnknownBefore: null,
      inRestoreMode: false,
    });
    expect(() => assertDeletionPermitted(`tenants/${T}/packs/ab/x`)).not.toThrow();
    const storage = new MemoryStorage();
    await storage.put(`tenants/${T}/keys/1`, Buffer.from("a"));
    await storage.put(`tenants/${T}/keys/1`, Buffer.from("b"));
  });
});
