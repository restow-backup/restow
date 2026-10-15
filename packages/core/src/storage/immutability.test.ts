import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectRetentionCommand,
} from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObjectLockedError } from "./backend.js";
import { openStorageTarget } from "./factory.js";
import {
  changeImmutability,
  delayedUntil,
  type ImmutabilitySettings,
  ImmutableStorageBackend,
  immutableBackendOf,
  lockClassOf,
  lockUntil,
  lowersImmutability,
  parseImmutabilitySettings,
  RENEWAL_BUFFER_DAYS,
  renewalDue,
  renewalOverdue,
  renewRetention,
  splitLockedSnapshots,
  spreadSample,
  verifyImmutability,
} from "./immutability.js";
import { LocalStorageBackend } from "./local.js";
import { S3StorageBackend } from "./s3.js";
import { FakeObjectLockS3 } from "./testing/object-lock-s3.js";

const DAY = 86_400_000;
const T = "11111111-1111-4111-8111-111111111111";

/** A clock the test moves; starts at the real time so nothing depends on a calendar date. */
function clock() {
  let now = Date.now();
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function settings(
  mode: ImmutabilitySettings["mode"],
  days: number,
  at: Date,
): ImmutabilitySettings {
  return changeImmutability(null, { mode, days }, at);
}

describe("which keys are locked", () => {
  it("locks the chunk store's packs, committed manifests and wrapped keys", () => {
    expect(lockClassOf(`tenants/${T}/packs/ab/abcdef`)).toBe("backup");
    expect(lockClassOf(`tenants/${T}/manifests/s1.json.zst`)).toBe("backup");
    expect(lockClassOf(`tenants/${T}/keys/1`)).toBe("backup");
  });

  it("locks a restic repository's packs, snapshots, keys and config, not its lock and index files", () => {
    for (const root of ["endpoints", "file-shares", "pve-guests"]) {
      expect(lockClassOf(`${root}/e1/config`)).toBe("backup");
      expect(lockClassOf(`${root}/e1/data/ab/abcd`)).toBe("backup");
      expect(lockClassOf(`${root}/e1/index/abcd`)).toBe("transient");
      expect(lockClassOf(`${root}/e1/snapshots/abcd`)).toBe("backup");
      expect(lockClassOf(`${root}/e1/keys/abcd`)).toBe("backup");
      expect(lockClassOf(`${root}/e1/locks/abcd`)).toBe("transient");
    }
  });

  it("leaves checkpoints, staging, exports, downloads and probes unlocked, and archive records alone", () => {
    expect(lockClassOf(`tenants/${T}/manifests/s1.partial`)).toBe("transient");
    expect(lockClassOf(`tenants/${T}/staging/u1/0`)).toBe("transient");
    expect(lockClassOf(`tenants/${T}/exports/x/file.mbox`)).toBe("transient");
    expect(lockClassOf(`tenants/${T}/downloads/r/file.zip`)).toBe("transient");
    expect(lockClassOf(`tenants/${T}/probes/p`)).toBe("transient");
    expect(lockClassOf("installation/probes/p")).toBe("transient");
    expect(lockClassOf(`tenants/${T}/archive/items/x`)).toBe("archive");
  });
});

describe("raising and lowering", () => {
  it("calls fewer days, off and a weaker mode lowering; more days and a stronger mode raising", () => {
    const current = { mode: "compliance" as const, days: 30 };
    expect(lowersImmutability(current, { mode: "compliance", days: 29 })).toBe(true);
    expect(lowersImmutability(current, { mode: null, days: 0 })).toBe(true);
    expect(lowersImmutability(current, { mode: "governance", days: 60 })).toBe(true);
    expect(lowersImmutability(current, { mode: "compliance", days: 31 })).toBe(false);
    expect(
      lowersImmutability({ mode: "governance", days: 30 }, { mode: "compliance", days: 30 }),
    ).toBe(false);
    expect(lowersImmutability(null, { mode: "governance", days: 1 })).toBe(false);
    expect(lowersImmutability({ mode: null, days: 0 }, { mode: null, days: 0 })).toBe(false);
  });

  it("keeps every change in the history and reads malformed values as off", () => {
    const at = new Date();
    const first = changeImmutability(null, { mode: "compliance", days: 30 }, at);
    const second = changeImmutability(
      first,
      { mode: null, days: 30 },
      new Date(at.getTime() + DAY),
    );
    expect(second.mode).toBeNull();
    expect(second.days).toBe(0);
    expect(second.history).toHaveLength(2);
    expect(parseImmutabilitySettings(JSON.parse(JSON.stringify(second)))).toEqual(second);
    expect(parseImmutabilitySettings({ mode: "forever", days: -1 })).toEqual({
      mode: null,
      days: 0,
      history: [],
    });
    expect(parseImmutabilitySettings(null)).toBeNull();
  });
});

describe("the deletion delay follows the history", () => {
  const start = Date.now();
  const at = (days: number) => new Date(start + days * DAY);

  it("never shortens what was written before a lowering, and lengthens it after a raise", () => {
    let history = settings("delayed_deletion", 30, at(0));
    history = changeImmutability(history, { mode: "delayed_deletion", days: 7 }, at(10));
    history = changeImmutability(history, { mode: null, days: 0 }, at(20));
    // Written while 30 days applied: still 30, though lowered and switched off since.
    expect(delayedUntil(at(5), history.history)?.getTime()).toBe(at(35).getTime());
    // Written while 7 days applied.
    expect(delayedUntil(at(12), history.history)?.getTime()).toBe(at(19).getTime());
    // Written after it was switched off.
    expect(delayedUntil(at(25), history.history)).toBeNull();
    // Written before anything was set: a later setting still covers it while it is on.
    const raised = changeImmutability(history, { mode: "delayed_deletion", days: 90 }, at(30));
    expect(delayedUntil(at(25), raised.history)?.getTime()).toBe(at(115).getTime());
  });
});

describe("renewal timing", () => {
  it("is due once the last pass is a day short of the buffer, and overdue beyond the buffer", () => {
    const now = new Date();
    expect(renewalDue(null, now)).toBe(true);
    expect(renewalDue(new Date(now.getTime() - (RENEWAL_BUFFER_DAYS - 2) * DAY), now)).toBe(false);
    expect(renewalDue(new Date(now.getTime() - (RENEWAL_BUFFER_DAYS - 1) * DAY), now)).toBe(true);
    const since = new Date(now.getTime() - 30 * DAY);
    expect(renewalOverdue(new Date(now.getTime() - 3 * DAY), since, now)).toBe(false);
    expect(
      renewalOverdue(new Date(now.getTime() - (RENEWAL_BUFFER_DAYS + 1) * DAY), since, now),
    ).toBe(true);
    expect(renewalOverdue(null, new Date(now.getTime() - DAY), now)).toBe(false);
  });

  it("samples evenly", () => {
    expect(spreadSample([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(spreadSample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5)).toEqual([1, 3, 5, 7, 9]);
  });
});

describe("Object Lock on S3 (strict in-memory bucket)", () => {
  let time: ReturnType<typeof clock>;
  let bucket: FakeObjectLockS3;
  let raw: S3StorageBackend;

  beforeEach(() => {
    time = clock();
    bucket = new FakeObjectLockS3({ now: time.now });
    raw = new S3StorageBackend({ bucket: "b", client: bucket.asClient() });
  });

  function locked(mode: "compliance" | "governance" = "compliance", days = 30) {
    return new ImmutableStorageBackend(raw, {
      settings: settings(mode, days, time.now()),
      now: time.now,
    });
  }

  it("writes backup objects with the retention of the period plus the buffer, transient ones without", async () => {
    const backend = locked();
    const pack = `tenants/${T}/packs/ab/p1`;
    await backend.put(pack, Buffer.from("pack"));
    await backend.put(`tenants/${T}/manifests/s1.partial`, Buffer.from("checkpoint"));
    const retention = await raw.retention(pack);
    expect(retention?.mode).toBe("COMPLIANCE");
    expect(retention?.retainUntil?.getTime()).toBe(lockUntil(time.now(), 30).getTime());
    expect(retention?.retainUntil?.getTime()).toBe(
      time.now().getTime() + (30 + RENEWAL_BUFFER_DAYS) * DAY,
    );
    expect((await raw.retention(`tenants/${T}/manifests/s1.partial`))?.retainUntil).toBeNull();
  });

  it("locks a streamed upload too, part by part with Content-MD5 when no checksum is configured", async () => {
    const backend = locked("governance", 10);
    const big = Buffer.alloc(9 * 1024 * 1024, 7);
    await backend.put(
      "endpoints/e1/data/ab/abcd",
      Readable.from([big.subarray(0, 5_000_000), big.subarray(5_000_000)]),
    );
    const retention = await raw.retention("endpoints/e1/data/ab/abcd");
    expect(retention?.mode).toBe("GOVERNANCE");
    expect(retention?.size).toBe(big.length);
    expect(
      bucket.calls.some((call) => call.command === "UploadPartCommand" && call.input.ContentMD5),
    ).toBe(true);
  });

  it("refuses to delete a locked object and deletes nothing, then removes every version once it ran out", async () => {
    const backend = locked("compliance", 1);
    const key = `tenants/${T}/packs/ab/p1`;
    await backend.put(key, Buffer.from("one"));
    await expect(backend.delete(key)).rejects.toBeInstanceOf(ObjectLockedError);
    expect(await raw.get(key)).toEqual(Buffer.from("one"));
    time.advance((1 + RENEWAL_BUFFER_DAYS) * DAY + 1000);
    await backend.delete(key);
    expect(bucket.objects.has(key)).toBe(false);
    expect(await raw.head(key)).toBeNull();
  });

  it("removes old versions and delete markers a plain delete would leave behind", async () => {
    const backend = locked("compliance", 1);
    const key = "endpoints/e1/locks/l1";
    await backend.put(key, Buffer.from("lock"));
    await raw.delete(key);
    await backend.put(key, Buffer.from("lock again"));
    expect(bucket.objects.get(key)).toHaveLength(3);
    await backend.delete(key);
    expect(bucket.objects.has(key)).toBe(false);
  });

  it("keeps the locked data when someone with Restow's access key deletes or overwrites it", async () => {
    const backend = locked("compliance", 30);
    const key = `tenants/${T}/manifests/s1.json.zst`;
    await backend.put(key, Buffer.from("manifest"));
    const [original] = bucket.objects.get(key) ?? [];
    // A plain delete only hides it behind a delete marker ...
    await bucket.send(new DeleteObjectCommand({ Bucket: "b", Key: key }));
    expect(await raw.head(key)).toBeNull();
    // ... deleting the version itself is refused, shortening the retention too ...
    await expect(
      bucket.send(
        new DeleteObjectCommand({ Bucket: "b", Key: key, VersionId: original?.versionId }),
      ),
    ).rejects.toMatchObject({ name: "AccessDenied" });
    await expect(
      bucket.send(
        new PutObjectRetentionCommand({
          Bucket: "b",
          Key: key,
          VersionId: original?.versionId,
          Retention: { Mode: "COMPLIANCE", RetainUntilDate: time.now() },
        }),
      ),
    ).rejects.toMatchObject({ name: "AccessDenied" });
    // ... and even with the bypass header in COMPLIANCE mode.
    await expect(
      bucket.send(
        new DeleteObjectCommand({
          Bucket: "b",
          Key: key,
          VersionId: original?.versionId,
          BypassGovernanceRetention: true,
        }),
      ),
    ).rejects.toMatchObject({ name: "AccessDenied" });
    // An overwrite is a new version; the locked one is still readable by its id.
    await raw.put(key, Buffer.from("garbage"));
    const read = (await bucket.send(
      new GetObjectCommand({ Bucket: "b", Key: key, VersionId: original?.versionId }),
    )) as { Body: { transformToByteArray(): Promise<Uint8Array> } };
    expect(Buffer.from(await read.Body.transformToByteArray()).toString()).toBe("manifest");
    // Restow itself cannot delete it either.
    await expect(backend.delete(key)).rejects.toBeInstanceOf(ObjectLockedError);
  });

  it("lets a GOVERNANCE lock be lifted only with the bypass permission Restow never uses", async () => {
    const backend = locked("governance", 30);
    const key = `tenants/${T}/keys/1`;
    await backend.put(key, Buffer.from("key"));
    const [version] = bucket.objects.get(key) ?? [];
    await expect(backend.delete(key)).rejects.toBeInstanceOf(ObjectLockedError);
    await bucket.send(
      new DeleteObjectCommand({
        Bucket: "b",
        Key: key,
        VersionId: version?.versionId,
        BypassGovernanceRetention: true,
      }),
    );
    expect(bucket.objects.has(key)).toBe(false);
  });

  it("refuses Object Lock parameters on a bucket without Object Lock", async () => {
    const plain = new FakeObjectLockS3({ objectLock: false, now: time.now });
    const backend = new ImmutableStorageBackend(
      new S3StorageBackend({ bucket: "b", client: plain.asClient() }),
      { settings: settings("compliance", 30, time.now()), now: time.now },
    );
    await expect(backend.put(`tenants/${T}/packs/ab/p1`, Buffer.from("x"))).rejects.toMatchObject({
      name: "InvalidRequest",
    });
  });

  it("renews objects still in use, and counts those already locked longer or gone", async () => {
    const backend = locked("compliance", 10);
    await backend.put(`tenants/${T}/packs/ab/p1`, Buffer.from("1"));
    await backend.put(`tenants/${T}/packs/ab/p2`, Buffer.from("2"));
    const longer = new ImmutableStorageBackend(raw, {
      settings: settings("compliance", 400, time.now()),
      now: time.now,
    });
    await longer.put(`tenants/${T}/packs/ab/p3`, Buffer.from("3"));
    time.advance(6 * DAY);
    const until = lockUntil(time.now(), 10);
    const report = await renewRetention(
      backend,
      [
        `tenants/${T}/packs/ab/p1`,
        `tenants/${T}/packs/ab/p2`,
        `tenants/${T}/packs/ab/p3`,
        `tenants/${T}/packs/ab/gone`,
      ],
      until,
    );
    expect(report).toMatchObject({ extended: 2, alreadyLonger: 1, failedTotal: 0 });
    expect(report.missing).toEqual([`tenants/${T}/packs/ab/gone`]);
    expect((await raw.retention(`tenants/${T}/packs/ab/p1`))?.retainUntil?.getTime()).toBe(
      until.getTime(),
    );
  });

  it("finds objects written without lock, and a weaker mode than asked", async () => {
    const backend = locked("compliance", 30);
    await backend.put(`tenants/${T}/packs/ab/good`, Buffer.from("g"));
    bucket.ignoreLockHeaders = true;
    await backend.put(`tenants/${T}/packs/ab/bad`, Buffer.from("b"));
    bucket.ignoreLockHeaders = false;
    await locked("governance", 30).put(`tenants/${T}/packs/ab/weak`, Buffer.from("w"));
    const report = await verifyImmutability(
      backend,
      [
        `tenants/${T}/packs/ab/good`,
        `tenants/${T}/packs/ab/bad`,
        `tenants/${T}/packs/ab/weak`,
        `tenants/${T}/packs/ab/none`,
      ],
      time.now(),
    );
    expect(report).toMatchObject({ sampled: 4, locked: 1, unlocked: 1, weakerMode: 1, missing: 1 });
    expect(report.problems.map((problem) => problem.state).sort()).toEqual([
      "missing",
      "unlocked",
      "weaker_mode",
    ]);
  });

  it("reports the storage's own answer as the protection of a restore point", async () => {
    const backend = locked("compliance", 30);
    const key = `tenants/${T}/manifests/s1.json.zst`;
    await backend.put(key, Buffer.from("m"));
    const protection = await backend.protection(key);
    expect(protection).toMatchObject({ source: "object_lock", mode: "COMPLIANCE", exists: true });
    expect(protection.until?.getTime()).toBe(lockUntil(time.now(), 30).getTime());
    expect((await backend.protection("tenants/x/manifests/none.json.zst")).exists).toBe(false);
  });

  it("tells retention which restic snapshots are still locked", async () => {
    const backend = locked("compliance", 1);
    await backend.put("endpoints/e1/snapshots/aaaa", Buffer.from("a"));
    await raw.put("endpoints/e1/snapshots/bbbb", Buffer.from("b"));
    const split = await splitLockedSnapshots(backend, "endpoints/e1/", ["aaaa", "bbbb"]);
    expect(split.remove).toEqual(["bbbb"]);
    expect(split.locked.map((entry) => entry.id)).toEqual(["aaaa"]);
    expect(await splitLockedSnapshots(raw, "endpoints/e1/", ["aaaa"])).toEqual({
      remove: ["aaaa"],
      locked: [],
    });
  });

  it("is applied by openStorageTarget from the row's setting", async () => {
    const record = {
      id: "t1",
      kind: "s3",
      config: { bucket: "restow-backups", region: "us-east-1" },
      secretRef: null,
      immutability: settings("compliance", 14, time.now()),
    };
    const opened = await openStorageTarget(
      record,
      { get: async () => null },
      { s3Client: bucket.asClient() },
    );
    expect(immutableBackendOf(opened.backend)?.settings.days).toBe(14);
    expect(immutableBackendOf(opened.backend)?.targetId).toBe("t1");
    const plain = await openStorageTarget(
      { ...record, immutability: null },
      { get: async () => null },
      {
        s3Client: bucket.asClient(),
      },
    );
    expect(immutableBackendOf(plain.backend)).toBeNull();
  });
});

describe("the deletion delay of a directory", () => {
  let root: string;
  let time: ReturnType<typeof clock>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "restow-immutable-"));
    time = clock();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses to delete or overwrite a backup file inside its delay and allows it after", async () => {
    const backend = new ImmutableStorageBackend(new LocalStorageBackend(root), {
      settings: settings("delayed_deletion", 7, time.now()),
      now: time.now,
    });
    const key = `tenants/${T}/packs/ab/p1`;
    await backend.put(key, Buffer.from("pack"));
    // The file's time is what the delay counts from; pin it to the test clock.
    await utimes(join(root, key), time.now(), time.now());
    await expect(backend.delete(key)).rejects.toMatchObject({ reason: "deletion_delay" });
    await expect(backend.put(key, Buffer.from("other"))).rejects.toBeInstanceOf(ObjectLockedError);
    const protection = await backend.protection(key);
    expect(protection.source).toBe("deletion_delay");
    expect(protection.until?.getTime()).toBe(time.now().getTime() + 7 * DAY);
    // Transient files go at once.
    await backend.put(`tenants/${T}/staging/u/0`, Buffer.from("s"));
    await backend.delete(`tenants/${T}/staging/u/0`);
    time.advance(7 * DAY + 1000);
    await backend.delete(key);
    expect(await backend.head(key)).toBeNull();
  });
});
