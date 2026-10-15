import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  changeImmutability,
  ImmutableStorageBackend,
  renewRetention,
} from "../storage/immutability.js";
import { S3StorageBackend } from "../storage/s3.js";
import { FakeObjectLockS3 } from "../storage/testing/object-lock-s3.js";
import {
  type RepositoryAccess,
  resticBinary,
  resticForget,
  resticInit,
  resticPrune,
  resticSnapshots,
  runRestic,
  withRepository,
} from "./restic-cli.js";

/**
 * A restic repository on an S3 target with Object Lock, served through
 * Restow's own REST layer (restic itself knows nothing about Object Lock):
 * the real restic binary backs up, forgets and prunes, and every object the
 * storage still locks stays where it is. restic gets 403 for those deletions,
 * which it reports and carries on from; the next prune after the lock ran out
 * removes them.
 */

function resticAvailable(): boolean {
  return spawnSync(resticBinary(), ["version"]).status === 0;
}

const DAY = 86_400_000;

describe.skipIf(!resticAvailable())("restic on an immutable repository", () => {
  let work: string;
  let source: string;
  let now = Date.now();
  const bucket = new FakeObjectLockS3({ now: () => new Date(now) });
  const backend = new ImmutableStorageBackend(
    new S3StorageBackend({ bucket: "b", client: bucket.asClient() }),
    {
      settings: changeImmutability(null, { mode: "compliance", days: 1 }, new Date(now)),
      now: () => new Date(now),
    },
  );
  const deferred: string[] = [];
  let access: RepositoryAccess;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "restow-restic-immutable-"));
    source = join(work, "source");
    await mkdir(source, { recursive: true });
    access = {
      storage: backend,
      prefix: "endpoints/e1/",
      repositoryPassword: "repository-password-for-tests",
      repositoryKey: "e1",
      cacheBase: join(work, "cache"),
      onDeletionDeferred: (key) => {
        deferred.push(key);
      },
    };
    await withRepository(access, async (session) => {
      await resticInit(session);
      for (const content of ["one", "two", "three"]) {
        await writeFile(join(source, "file.txt"), content.repeat(10_000));
        await runRestic(session, ["backup", "--host", "test-host", source]);
      }
    });
  }, 120_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("locks every repository object but restic's lock files", () => {
    const keys = [...bucket.objects.keys()].filter((key) =>
      bucket.objects.get(key)?.some((v) => !v.marker),
    );
    expect(keys.some((key) => key.startsWith("endpoints/e1/data/"))).toBe(true);
    for (const key of keys) {
      const version = bucket.objects.get(key)?.at(-1);
      if (key.startsWith("endpoints/e1/locks/") || key.startsWith("endpoints/e1/index/")) {
        expect(version?.retainUntil).toBeNull();
      } else {
        expect(version?.mode, key).toBe("COMPLIANCE");
      }
    }
  });

  it("keeps a locked snapshot through forget and prune, and the repository stays intact", async () => {
    await withRepository(access, async (session) => {
      const before = (await resticSnapshots(session)).map((snapshot) => snapshot.id);
      expect(before).toHaveLength(3);
      // restic reports the refused removal as a warning (exit code 3) and keeps the snapshot;
      // the worker's retention therefore leaves locked snapshots out of its forget.
      await expect(resticForget(session, [before[1] as string])).rejects.toMatchObject({
        exitCode: 3,
      });
      await resticPrune(session);
      const after = (await resticSnapshots(session)).map((snapshot) => snapshot.id);
      expect(after.sort()).toEqual([...before].sort());
      await runRestic(session, ["check", "--read-data"]);
    });
    expect(deferred.some((key) => key.startsWith("endpoints/e1/snapshots/"))).toBe(true);
  }, 120_000);

  it("prunes around packs and indexes that are still locked, and removes them later", async () => {
    // The snapshot's own lock ran out, but its data was renewed (still in use elsewhere, or
    // not yet known to be unused): forget succeeds, prune cannot remove the locked files.
    now += 10 * DAY;
    const renewed = [...bucket.objects.keys()].filter((key) =>
      key.startsWith("endpoints/e1/data/"),
    );
    const report = await renewRetention(backend, renewed, new Date(now + 5 * DAY));
    expect(report.failedTotal).toBe(0);
    deferred.length = 0;
    await withRepository(access, async (session) => {
      const before = (await resticSnapshots(session)).map((snapshot) => snapshot.id);
      await resticForget(session, [before[1] as string]);
      // The locked packs are refused (a warning), and the prune itself succeeds.
      await resticPrune(session);
      expect((await resticSnapshots(session)).map((snapshot) => snapshot.id)).toHaveLength(2);
      await runRestic(session, ["check", "--read-data"]);
    });
    expect(deferred.length).toBeGreaterThan(0);
    expect(deferred.every((key) => key.startsWith("endpoints/e1/data/"))).toBe(true);
    for (const key of deferred) {
      expect(await backend.head(key)).not.toBeNull();
    }
    now += 6 * DAY;
    await withRepository(access, async (session) => {
      await resticPrune(session);
      await runRestic(session, ["check", "--read-data"]);
    });
    for (const key of deferred) {
      expect(bucket.objects.has(key)).toBe(false);
    }
  }, 120_000);
});
