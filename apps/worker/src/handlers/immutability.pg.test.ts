/**
 * The immutable-backup maintenance of the retention job against Postgres: a
 * repository with S3 Object Lock gets the retention of everything still in
 * use renewed, a sample verified (an object written without lock is found),
 * deferred deletions of objects that are gone are dropped, and the state is
 * kept on the target row. The storage is an in-memory bucket that keeps a
 * retention per object.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
 * named `restow_worker_immutability_test` is dropped and recreated there).
 */
import { Readable } from "node:stream";
import {
  changeImmutability,
  type HeadResult,
  ImmutableStorageBackend,
  lockUntil,
  ObjectLockedError,
  type ObjectLockMode,
  type ObjectRetention,
  type PutOptions,
  RENEWAL_BUFFER_DAYS,
  type StorageBackend,
} from "@restow/core";
import {
  createDb,
  type Database,
  immutabilityDeferredDeletions,
  packs,
  protectedObjects,
  providers,
  snapshots,
  sources,
  storageTargets,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maintainImmutableTarget, recordDeferredDeletion } from "./immutability.js";

const DAY = 86_400_000;

/** One version per key, with a retention the storage enforces on delete. */
class LockingBucket implements StorageBackend {
  readonly objects = new Map<
    string,
    { bytes: Buffer; at: Date; mode: ObjectLockMode | null; until: Date | null }
  >();
  constructor(readonly now: () => Date) {}

  async put(key: string, data: Buffer | Readable, options?: PutOptions): Promise<void> {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(await data.toArray());
    this.objects.set(key, {
      bytes,
      at: this.now(),
      mode: options?.retainUntil ? (options.lockMode ?? "COMPLIANCE") : null,
      until: options?.retainUntil ?? null,
    });
  }
  async get(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`missing ${key}`);
    return object.bytes;
  }
  async getStream(key: string): Promise<Readable> {
    return Readable.from([await this.get(key)]);
  }
  async head(key: string): Promise<HeadResult | null> {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.length, lastModified: object.at } : null;
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async retention(key: string): Promise<ObjectRetention | null> {
    const object = this.objects.get(key);
    return object
      ? {
          mode: object.mode,
          retainUntil: object.until,
          lastModified: object.at,
          size: object.bytes.length,
        }
      : null;
  }
  async setRetention(key: string, until: Date, mode: ObjectLockMode): Promise<void> {
    const object = this.objects.get(key);
    if (!object) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
    if (object.until && object.until > until) throw new Error("AccessDenied");
    object.until = until;
    object.mode = mode;
  }
  async deleteAllVersions(key: string, now: Date): Promise<void> {
    const object = this.objects.get(key);
    if (object?.until && object.until > now) throw new ObjectLockedError(key, object.until);
    this.objects.delete(key);
  }
}

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_immutability_test";

describe.skipIf(!adminUrl)("immutable backups in the retention job", () => {
  let db: Database;
  let tenantId: string;
  let targetId: string;
  let now = Date.now();
  const clock = () => new Date(now);

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    try {
      await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await admin.$client.end();
    }
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id as string, name: "Contoso", slug: "contoso" })
      .returning();
    tenantId = tenant?.id as string;
    const [target] = await db
      .insert(storageTargets)
      .values({
        tenantId,
        kind: "s3",
        role: "primary",
        config: { bucket: "restow-backups" },
        immutability: changeImmutability(
          null,
          { mode: "compliance", days: 30 },
          new Date(now - 2 * DAY),
        ),
      })
      .returning();
    targetId = target?.id as string;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
  });

  it("renews what is in use, finds an object written without lock and keeps the state", async () => {
    const bucket = new LockingBucket(clock);
    const [row] = await db.select().from(storageTargets).where(eq(storageTargets.id, targetId));
    const backend = new ImmutableStorageBackend(bucket, {
      settings: changeImmutability(null, { mode: "compliance", days: 30 }, new Date(now - 2 * DAY)),
      now: clock,
      targetId,
    });
    expect(row?.immutability?.mode).toBe("compliance");
    const live = `tenants/${tenantId}/packs/aa/live`;
    const unlocked = `tenants/${tenantId}/packs/bb/unlocked`;
    const manifest = `tenants/${tenantId}/manifests/s1.json.zst`;
    await backend.put(live, Buffer.from("live"));
    await bucket.put(unlocked, Buffer.from("written by a worker that had not seen the setting"));
    await backend.put(manifest, Buffer.from("manifest"));
    await backend.put(`tenants/${tenantId}/keys/1`, Buffer.from("key"));
    await db.insert(packs).values([
      { tenantId, path: live, sha256: "00", size: 4 },
      { tenantId, path: unlocked, sha256: "11", size: 10 },
    ]);
    const [source] = await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "M365", status: "active" })
      .returning();
    const [object] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source?.id as string,
        kind: "mailbox",
        externalId: "alice",
        displayName: "Alice",
      })
      .returning();
    await db.insert(snapshots).values({
      tenantId,
      protectedObjectId: object?.id as string,
      sequence: 1,
      manifestPath: manifest,
      completedAt: clock(),
    });
    // A deletion refused earlier whose object is gone since, and one still there.
    await recordDeferredDeletion(
      db,
      tenantId,
      backend,
      "endpoints/e1/data/aa/gone",
      new Date(now - DAY),
    );
    await recordDeferredDeletion(db, tenantId, backend, live, new Date(now - DAY));

    now += 3 * DAY;
    const first = await maintainImmutableTarget({ db, tenantId, backend, now: clock() });
    expect(first.renewed).toBe(true);
    // The renewal runs before the sample is read, so the pack written without lock is locked now.
    expect(first.renewal).toMatchObject({ failedTotal: 0 });
    expect(first.verification).toMatchObject({ unlocked: 0 });
    expect(first.deferredCleared).toBe(1);
    // The deferred key `live` is left out of the renewal, so its lock can run out.
    expect(bucket.objects.get(live)?.until?.getTime()).toBe(
      lockUntil(new Date(now - 3 * DAY), 30).getTime(),
    );
    expect(bucket.objects.get(unlocked)?.until?.getTime()).toBe(lockUntil(clock(), 30).getTime());
    const [after] = await db.select().from(storageTargets).where(eq(storageTargets.id, targetId));
    expect(after?.immutabilityState?.renewedAt).toBe(clock().toISOString());
    expect(after?.immutabilityState?.verification?.sampled).toBeGreaterThan(0);
    const deferred = await db.select().from(immutabilityDeferredDeletions);
    expect(deferred.map((entry) => entry.key)).toEqual([live]);

    // Two days later no renewal is due; a pack written without lock now is found.
    now += 2 * DAY;
    const fresh = `tenants/${tenantId}/packs/cc/fresh`;
    await bucket.put(fresh, Buffer.from("fresh"));
    await db.insert(packs).values({ tenantId, path: fresh, sha256: "22", size: 5 });
    const second = await maintainImmutableTarget({ db, tenantId, backend, now: clock() });
    expect(second.renewed).toBe(false);
    expect(second.verification).toMatchObject({ unlocked: 1 });
    const [state] = await db.select().from(storageTargets).where(eq(storageTargets.id, targetId));
    expect(state?.immutabilityState?.verification?.problems).toEqual([
      expect.objectContaining({ key: fresh, state: "unlocked" }),
    ]);

    // Renewal is due again a day short of the buffer.
    now += (RENEWAL_BUFFER_DAYS - 3) * DAY;
    const third = await maintainImmutableTarget({ db, tenantId, backend, now: clock() });
    expect(third.renewed).toBe(true);
    expect(third.verification).toMatchObject({ unlocked: 0 });
  }, 60_000);
});
