import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PutOptions, StorageSpace } from "../storage/backend.js";
import { LocalStorageBackend } from "../storage/local.js";
import {
  DELETE_ONLY_PRUNE_ARGS,
  parsePruneStatistics,
  type RepositoryAccess,
  ResticError,
  type ResticSession,
  resticBinary,
  resticForget,
  resticInit,
  resticPrune,
  resticSnapshots,
  runRestic,
  storageShortOfSpace,
  withRepository,
} from "./restic-cli.js";

/**
 * Retention on a full storage target (docs/STORAGE.md, "A full target"): restic's normal
 * prune repacks, writing new packs before it deletes the old ones, so on a full target it frees
 * nothing. `resticPrune` then runs a prune that only deletes unused packs. The pure parts run
 * everywhere; the rest runs the real restic binary through the maintenance listener, the last
 * test on a small ext4 file system in a loop device filled by backups until nothing fits (only
 * as root where losetup and mkfs.ext4 work, skipped otherwise).
 */

function resticAvailable(): boolean {
  return spawnSync(resticBinary(), ["version"]).status === 0;
}

const MiB = 1024 * 1024;

const DRY_RUN_OUTPUT = `loading all snapshots...
finding data that is still in use for 1 snapshots
searching used packs...
collecting packs for deletion and repacking

Would have made the following changes:

to repack:           600 blobs / 11.492 MiB
this removes:        300 blobs / 5.734 MiB
to delete:          1245 blobs / 42.125 MiB
total prune:        1545 blobs / 47.859 MiB
remaining:           308 blobs / 5.751 MiB
unused size after prune: 12 B (49.93% of remaining size)
`;

describe("restic's prune statistics", () => {
  it("reads what the repack would read and drop, and the unused share left", () => {
    expect(parsePruneStatistics(DRY_RUN_OUTPUT)).toEqual({
      repackBytes: Math.round(11.492 * MiB),
      repackRemovesBytes: Math.round(5.734 * MiB),
      unusedAfterPercent: 49.93,
    });
    expect(parsePruneStatistics("to repack: 0 blobs / 0 B\nthis removes: 0 blobs / 0 B")).toEqual({
      repackBytes: 0,
      repackRemovesBytes: 0,
      unusedAfterPercent: null,
    });
    expect(parsePruneStatistics("nothing")).toEqual({
      repackBytes: null,
      repackRemovesBytes: null,
      unusedAfterPercent: null,
    });
  });

  it("deletes only: no unused limit, no repack at all, no cache", () => {
    expect(DELETE_ONLY_PRUNE_ARGS).toEqual([
      "--max-unused",
      "unlimited",
      "--max-repack-size",
      "0",
      "--no-cache",
    ]);
  });

  it("calls a target short of space only when it reports its free space", async () => {
    const reporting = (space: StorageSpace | null) => ({ freeSpace: async () => space });
    expect(await storageShortOfSpace({})).toBe(false);
    expect(await storageShortOfSpace(reporting(null))).toBe(false);
    expect(await storageShortOfSpace(reporting({ freeBytes: MiB, totalBytes: 1024 * MiB }))).toBe(
      true,
    );
    expect(
      await storageShortOfSpace(reporting({ freeBytes: 900 * MiB, totalBytes: 1024 * MiB })),
    ).toBe(false);
  });
});

/** A local target that refuses new packs (`data/`) with ENOSPC while `full` is set. */
class FullPacksBackend extends LocalStorageBackend {
  full = false;
  space: StorageSpace | null = null;

  override async put(key: string, data: Buffer | Readable, options?: PutOptions): Promise<void> {
    if (this.full && key.includes("/data/")) {
      if (!Buffer.isBuffer(data)) {
        data.resume();
      }
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    }
    return super.put(key, data, options);
  }

  override async freeSpace(): Promise<StorageSpace | null> {
    return this.space;
  }
}

/**
 * Backups whose data ends up partly used after a forget: small files that stay and small files
 * that go share packs (a normal prune repacks them), and a large file per round fills packs of
 * its own (gone for good once its snapshots are forgotten). Leaves only the files that stay.
 */
async function backUpMixed(session: ResticSession, source: string, rounds: number, big: number) {
  await rm(source, { recursive: true, force: true });
  await mkdir(source, { recursive: true });
  const dropGone = async () => {
    for (let round = 0; round < rounds; round++) {
      await rm(join(source, `big-${round}`), { force: true });
      for (let file = 0; file < 150; file++) {
        await rm(join(source, `gone-${round}-${file}`), { force: true });
      }
    }
  };
  for (let round = 0; round < rounds; round++) {
    await dropGone();
    for (let file = 0; file < 150; file++) {
      await writeFile(join(source, `keep-${round}-${file}`), randomBytes(20_000));
      await writeFile(join(source, `gone-${round}-${file}`), randomBytes(20_000));
    }
    await writeFile(join(source, `big-${round}`), randomBytes(big));
    await runRestic(session, ["backup", "--host", "test-host", source]);
  }
  await dropGone();
}

describe.skipIf(!resticAvailable())("prune on a target short of space", () => {
  let work: string;
  let backend: FullPacksBackend;
  let access: RepositoryAccess;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "restow-restic-prune-space-"));
    backend = new FullPacksBackend(join(work, "storage"));
    access = {
      storage: backend,
      prefix: "endpoints/e1/",
      repositoryPassword: "repository-password-for-tests",
      repositoryKey: "e1",
      cacheBase: join(work, "cache"),
    };
    await withRepository(access, (session) => resticInit(session));
  }, 60_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  async function prepare(): Promise<void> {
    backend.full = false;
    backend.space = null;
    await withRepository(access, async (session) => {
      await backUpMixed(session, join(work, "source"), 2, 3 * MiB);
      const snapshots = await resticSnapshots(session, { noLock: true });
      // A snapshot of the files that stay; every earlier one is forgotten.
      await runRestic(session, ["backup", "--host", "test-host", join(work, "source")]);
      await resticForget(
        session,
        snapshots.map((snapshot) => snapshot.id),
      );
    });
  }

  async function repositoryBytes(): Promise<number> {
    const sizes = await backend.listWithSizes("endpoints/e1/data/");
    return sizes.reduce((sum, entry) => sum + entry.size, 0);
  }

  it("falls back to deleting only when the normal prune runs out of space", async () => {
    await prepare();
    const before = await repositoryBytes();
    backend.full = true;
    const started = Date.now();
    const outcome = await withRepository(access, (session) => resticPrune(session));
    // The listener answered the refused pack with 403: restic gave up at once instead of
    // retrying for a quarter of an hour.
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(outcome).toMatchObject({ mode: "delete_only", reason: "storage_full" });
    expect(outcome.repackDeferred).toBe(true);
    expect(await repositoryBytes()).toBeLessThan(before);
    backend.full = false;
    await withRepository(access, async (session) => {
      await runRestic(session, ["check", "--read-data"]);
      // With room again, the repack the delete-only prune left follows.
      expect(await resticPrune(session)).toMatchObject({ mode: "full", repackDeferred: false });
      await runRestic(session, ["check", "--read-data"]);
    });
  }, 180_000);

  it("deletes only when the target reports too little room for the repack", async () => {
    await prepare();
    backend.space = { freeBytes: 2 * MiB, totalBytes: 1024 * MiB };
    const outcome = await withRepository(access, (session) =>
      resticPrune(session, { storage: backend }),
    );
    expect(outcome).toMatchObject({
      mode: "delete_only",
      reason: "low_space",
      freeBytesBefore: 2 * MiB,
    });
    backend.space = { freeBytes: 900 * MiB, totalBytes: 1024 * MiB };
    expect(
      await withRepository(access, (session) => resticPrune(session, { storage: backend })),
    ).toMatchObject({ mode: "full", reason: null });
    await withRepository(access, (session) => runRestic(session, ["check", "--read-data"]));
  }, 180_000);

  it("says storage_full when not even the delete-only prune fits", async () => {
    await prepare();
    // Nothing fits, not even an index file or a lock.
    const refuseAll = Object.create(backend) as FullPacksBackend;
    refuseAll.put = async (_key, data) => {
      if (!Buffer.isBuffer(data)) {
        data.resume();
      }
      throw Object.assign(new Error("disk quota exceeded"), { code: "EDQUOT" });
    };
    const failure = await withRepository({ ...access, storage: refuseAll }, (session) =>
      resticPrune(session),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ResticError);
    expect((failure as ResticError).failure).toBe("storage_full");
    await withRepository(access, (session) => runRestic(session, ["check"]));
  }, 180_000);
});

// ---------------------------------------------------------------------------
// A real full file system (root only)
// ---------------------------------------------------------------------------

function loopDevicesUsable(): boolean {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || !resticAvailable()) {
    return false;
  }
  return ["losetup", "mkfs.ext4", "mount", "umount"].every(
    (tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0,
  );
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe.skipIf(!loopDevicesUsable())("retention on a loop-mounted target filled to 100 %", () => {
  let work: string;
  let mountPoint: string;
  let device: string | null = null;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "restow-restic-full-disk-"));
    mountPoint = join(work, "mnt");
    await mkdir(mountPoint, { recursive: true });
    const image = join(work, "target.img");
    run("truncate", ["-s", "96M", image]);
    // No blocks reserved for root: the server (root here) sees the same full disk as anyone.
    run("mkfs.ext4", ["-q", "-F", "-m", "0", image]);
    device = run("losetup", ["--find", "--show", image]);
    run("mount", [device, mountPoint]);
  }, 60_000);

  afterAll(async () => {
    if (device) {
      spawnSync("umount", [mountPoint]);
      spawnSync("losetup", ["-d", device]);
    }
    await rm(work, { recursive: true, force: true });
  });

  it("brings the target back below its limit by deleting only", async () => {
    const backend = new LocalStorageBackend(mountPoint);
    const access: RepositoryAccess = {
      storage: backend,
      prefix: "endpoints/e1/",
      repositoryPassword: "repository-password-for-tests",
      repositoryKey: "e1",
      // restic's cache is on the server's own disk, not on the target.
      cacheBase: join(work, "cache"),
    };
    const source = join(work, "source");
    const usedPercent = async () => {
      const stats = await statfs(mountPoint);
      return 100 * (1 - Number(stats.bavail) / Number(stats.blocks));
    };
    await withRepository(access, async (session) => {
      await resticInit(session);
      // Back up until the target refuses the next pack: it is full.
      let failure: unknown = null;
      for (let round = 0; round < 20 && failure === null; round++) {
        await rm(source, { recursive: true, force: true });
        await mkdir(source, { recursive: true });
        for (let file = 0; file < 40; file++) {
          await writeFile(join(source, `small-${round}-${file}`), randomBytes(20_000));
        }
        await writeFile(join(source, `big-${round}`), randomBytes(12 * MiB));
        failure = await runRestic(session, ["backup", "--host", "test-host", source]).then(
          () => null,
          (error: unknown) => error,
        );
      }
      expect(failure).toBeInstanceOf(ResticError);
      expect((failure as ResticError).failure).toBe("storage_full");
    });
    const full = await usedPercent();
    expect(full).toBeGreaterThan(80);
    // Fill what the failed pack left: the target is at 100 % but for a few blocks.
    const space = await backend.freeSpace();
    if (space && space.freeBytes > 128 * 1024) {
      await writeFile(join(mountPoint, "filler"), Buffer.alloc(space.freeBytes - 128 * 1024));
    }
    expect(await usedPercent()).toBeGreaterThan(99);
    expect(await storageShortOfSpace(backend)).toBe(true);
    // Retention: forget every snapshot but the newest, then prune with the one policy.
    const outcome = await withRepository(access, async (session) => {
      const snapshots = await resticSnapshots(session, { noLock: true });
      expect(snapshots.length).toBeGreaterThan(1);
      await resticForget(
        session,
        snapshots.slice(1).map((snapshot) => snapshot.id),
      );
      return resticPrune(session, { storage: backend });
    });
    expect(outcome.mode).toBe("delete_only");
    expect(outcome.reason).toBe("low_space");
    // Back below the limit: most of the target is free again.
    expect(await usedPercent()).toBeLessThan(60);
    await withRepository(access, async (session) => {
      expect(await resticSnapshots(session)).toHaveLength(1);
      await runRestic(session, ["check", "--read-data"]);
    });
  }, 300_000);
});
