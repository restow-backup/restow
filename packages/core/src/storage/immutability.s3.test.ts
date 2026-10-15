import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { ObjectLockedError } from "./backend.js";
import { detectS3ObjectLock } from "./factory.js";
import {
  changeImmutability,
  ImmutableStorageBackend,
  lockUntil,
  renewRetention,
  verifyImmutability,
} from "./immutability.js";
import { S3StorageBackend } from "./s3.js";

/**
 * Immutable backups against a real S3 API with Object Lock. Opt-in: set
 * RESTOW_TEST_S3_LOCK_ENDPOINT to an S3 endpoint that implements Object Lock
 * (AWS, Ceph RGW, or an emulator such as moto's server), with
 * RESTOW_TEST_S3_LOCK_ACCESS_KEY / _SECRET_KEY / _REGION when it needs them.
 * A new bucket with Object Lock is created for each run. Garage, the S3 the
 * smoke test uses, implements neither versioning nor Object Lock.
 */
const endpoint = process.env.RESTOW_TEST_S3_LOCK_ENDPOINT;
const DAY = 86_400_000;

describe.skipIf(!endpoint)("Object Lock on a real S3 API", () => {
  const bucket = `restow-lock-${randomUUID().slice(0, 8)}`;
  let client: S3Client;
  let raw: S3StorageBackend;

  beforeAll(async () => {
    client = new S3Client({
      endpoint,
      region: process.env.RESTOW_TEST_S3_LOCK_REGION ?? "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.RESTOW_TEST_S3_LOCK_ACCESS_KEY ?? "test",
        secretAccessKey: process.env.RESTOW_TEST_S3_LOCK_SECRET_KEY ?? "test",
      },
    });
    await client.send(
      new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }),
    );
    raw = new S3StorageBackend({ bucket, prefix: "restow", client });
  });

  const immutable = (mode: "compliance" | "governance", days: number) =>
    new ImmutableStorageBackend(raw, {
      settings: changeImmutability(null, { mode, days }, new Date()),
    });

  it("detects the bucket's Object Lock", async () => {
    expect((await detectS3ObjectLock(client, bucket)).status).toBe("enabled");
  });

  it("locks a backup object, and neither Restow nor its access key can delete the locked version", async () => {
    const backend = immutable("compliance", 1);
    const key = "tenants/t1/packs/ab/p1";
    const before = Date.now();
    await backend.put(key, Buffer.from("pack bytes"));
    const retention = await raw.retention(key);
    expect(retention?.mode).toBe("COMPLIANCE");
    // S3 keeps the date with second precision.
    expect(
      Math.abs((retention?.retainUntil?.getTime() ?? 0) - lockUntil(new Date(before), 1).getTime()),
    ).toBeLessThan(5_000);
    await expect(backend.delete(key)).rejects.toBeInstanceOf(ObjectLockedError);
    const versions = await client.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `restow/${key}` }),
    );
    const versionId = versions.Versions?.[0]?.VersionId;
    await expect(
      client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: `restow/${key}`, VersionId: versionId }),
      ),
    ).rejects.toBeTruthy();
    // Shortening a COMPLIANCE retention must be refused as well; AWS does, but moto's
    // emulator accepts it, so that rule is covered by the strict in-memory bucket
    // (immutability.test.ts) only.
    expect((await raw.get(key)).toString()).toBe("pack bytes");
  });

  it("locks a multipart upload", async () => {
    const backend = immutable("governance", 1);
    const big = Buffer.alloc(9 * 1024 * 1024, 3);
    await backend.put("endpoints/e1/data/ab/abcd", Readable.from([big]));
    const retention = await raw.retention("endpoints/e1/data/ab/abcd");
    expect(retention?.mode).toBe("GOVERNANCE");
    expect(retention?.size).toBe(big.length);
  });

  it("leaves restic lock files unlocked and deletes them with every version", async () => {
    const backend = immutable("compliance", 1);
    await backend.put("endpoints/e1/locks/l1", Buffer.from("lock"));
    expect((await raw.retention("endpoints/e1/locks/l1"))?.retainUntil).toBeNull();
    await backend.delete("endpoints/e1/locks/l1");
    const versions = await client.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: "restow/endpoints/e1/locks/l1" }),
    );
    expect(versions.Versions ?? []).toHaveLength(0);
    expect(versions.DeleteMarkers ?? []).toHaveLength(0);
  });

  it("deletes an object for good once its retention has run out", async () => {
    const key = "tenants/t1/packs/ab/short";
    await raw.put(key, Buffer.from("x"), {
      retainUntil: new Date(Date.now() + 2_000),
      lockMode: "COMPLIANCE",
    });
    const backend = immutable("compliance", 1);
    await expect(backend.delete(key)).rejects.toBeInstanceOf(ObjectLockedError);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await backend.delete(key);
    expect(await raw.head(key)).toBeNull();
  }, 10_000);

  it("renews the retention and verifies it", async () => {
    const backend = immutable("compliance", 1);
    const key = "tenants/t1/packs/ab/renew";
    await backend.put(key, Buffer.from("r"));
    const until = new Date(Date.now() + 20 * DAY);
    const report = await renewRetention(backend, [key], until);
    expect(report.extended).toBe(1);
    expect(
      Math.abs((await raw.retention(key))?.retainUntil?.getTime() ?? 0) - until.getTime(),
    ).toBeLessThan(1_000);
    const verification = await verifyImmutability(backend, [key], new Date());
    expect(verification).toMatchObject({ sampled: 1, locked: 1, unlocked: 0 });
  });
});
