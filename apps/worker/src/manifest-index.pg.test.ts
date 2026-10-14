/**
 * The worker's side of the versioned manifest index (0.3.5), against Postgres:
 *
 *   - the snapshot index mirrors what the engine commits, keeps one row per
 *     unchanged object across backups, and lets go of what a discarded
 *     snapshot had mirrored,
 *   - retention releases the chunk ids of exactly the pruned snapshot (from
 *     the index, when its manifest is unreadable) and deletes only the
 *     versions no active snapshot needs any more,
 *   - the scrub's question "which objects use these chunks" sees the chunks
 *     of active snapshots only, old per-snapshot rows included,
 *   - the background conversion folds every old per-snapshot row of every
 *     tenant into versions, exactly, and ends.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server.
 */
import { randomUUID } from "node:crypto";
import { type ManifestObject, noopLogger } from "@restow/core";
import {
  type Database,
  chunkIdsFromDriver,
  createDb,
  manifestEntries,
  objectsReferencingChunks,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgSnapshotIndex, tenantRunner, withTenantTx } from "./handlers/framework.js";
import { pgRetentionStore } from "./handlers/retention.js";
import { convertLegacyManifests, startManifestConversion } from "./manifest-conversion.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_manifest_index_test";

const chunk = (label: string) => Buffer.from(label.padEnd(32, ".").slice(0, 32)).toString("hex");

function mail(path: string, version = 1, extra: Partial<ManifestObject> = {}): ManifestObject {
  return {
    path,
    id: `id:${path}`,
    type: "message",
    size: 100 + version,
    mtime: Date.UTC(2026, 0, version),
    chunks: [chunk(`${path}#${version}`)],
    metadata: { subject: path, messageId: `<${path}>`, folderId: "AAMk-bookkeeping" },
    ...extra,
  };
}

interface Fixture {
  tenantId: string;
  objectId: string;
}

async function fixture(db: Database): Promise<Fixture> {
  const [provider] = await db.insert(providers).values({ name: "P" }).returning();
  const [tenant] = await db
    .insert(tenants)
    .values({
      providerId: provider?.id as string,
      name: "T",
      slug: `t-${randomUUID().slice(0, 8)}`,
    })
    .returning();
  const [source] = await db
    .insert(sources)
    .values({ tenantId: tenant?.id as string, kind: "m365", name: "M365", config: {} })
    .returning();
  const [object] = await db
    .insert(protectedObjects)
    .values({
      tenantId: tenant?.id as string,
      sourceId: source?.id as string,
      kind: "mailbox",
      externalId: `${randomUUID()}@example.test`,
    })
    .returning();
  return { tenantId: tenant?.id as string, objectId: object?.id as string };
}

async function entriesOf(db: Database, tenantId: string, snapshotId: string): Promise<string[]> {
  const result = await db.execute<{ path: string; size: string; chunk_refs: unknown }>(sql`
    SELECT m.path, m.size, m.chunk_refs
    FROM ${manifestEntries({ tenantId, snapshots: sql`s.id = ${snapshotId}::uuid`, chunks: true })} AS m
  `);
  return result.rows
    .map((row) => `${row.path}|${row.size}|${chunkIdsFromDriver(row.chunk_refs).join(",")}`)
    .sort();
}

const expected = (objects: readonly ManifestObject[]) =>
  objects.map((object) => `${object.path}|${object.size}|${object.chunks.join(",")}`).sort();

describe.skipIf(!adminUrl)("the versioned manifest index in the worker", () => {
  let db: Database;

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
  });

  afterAll(async () => {
    await db?.$client.end();
    const admin = createDb(adminUrl as string);
    try {
      await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    } finally {
      await admin.$client.end();
    }
  });

  /** A committed backup as the engine makes it: create, mirror, complete. */
  async function backup(
    index: PgSnapshotIndex,
    f: Fixture,
    sequence: number,
    objects: readonly ManifestObject[],
  ): Promise<string> {
    const record = await index.create({
      id: randomUUID(),
      protectedObjectId: f.objectId,
      jobId: null,
      sequence,
      startedAt: new Date(),
    });
    await index.recordObjects(record.id, objects);
    await index.complete(record.id, {
      manifestPath: `tenants/${f.tenantId}/manifests/${record.id}`,
      itemCount: objects.length,
      byteSize: 0,
      completedAt: new Date(),
    });
    return record.id;
  }

  it("mirrors backups as versions, releases pruned snapshots and answers the scrub", async () => {
    const f = await fixture(db);
    const index = new PgSnapshotIndex(tenantRunner(db, f.tenantId), f.tenantId, noopLogger);
    const v1 = [mail("mail/Inbox/a.eml"), mail("mail/Inbox/b.eml"), mail("mail/Inbox/c.eml")];
    const v2 = [v1[0] as ManifestObject, mail("mail/Inbox/b.eml", 2), mail("mail/Inbox/d.eml")];
    const contents = [v1, v1, v1, v2, v2];
    const ids: string[] = [];
    for (const [i, objects] of contents.entries()) {
      ids.push(await backup(index, f, i + 1, objects));
    }
    for (const [i, id] of ids.entries()) {
      expect(await entriesOf(db, f.tenantId, id)).toEqual(expected(contents[i] ?? []));
    }
    const versions = async () =>
      Number(
        (
          await db.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM manifest_versions WHERE protected_object_id = ${f.objectId}::uuid`,
          )
        ).rows[0]?.n,
      );
    // a (all five), b v1, c, b v2, d: five rows for 15 per-snapshot rows.
    expect(await versions()).toBe(5);

    // A discarded attempt: its mirror goes with it.
    const attempt = await index.create({
      id: randomUUID(),
      protectedObjectId: f.objectId,
      jobId: null,
      sequence: 6,
      startedAt: new Date(),
    });
    await index.recordObjects(attempt.id, [...v2, mail("mail/Inbox/e.eml")]);
    expect(await versions()).toBe(6);
    await index.discard(attempt.id);
    expect(await versions()).toBe(5);
    for (const [i, id] of ids.entries()) {
      expect(await entriesOf(db, f.tenantId, id)).toEqual(expected(contents[i] ?? []));
    }

    // The scrub: chunks of c (only in snapshots 1-3) and of d (4-5).
    const cChunks = v1[2]?.chunks ?? [];
    const dChunks = v2[2]?.chunks ?? [];
    const using = (chunks: readonly string[]) =>
      withTenantTx(db, f.tenantId, (tx) => objectsReferencingChunks(tx, f.tenantId, chunks));
    expect(await using(cChunks)).toEqual([f.objectId]);
    expect(await using([chunk("unknown")])).toEqual([]);

    // Retention prunes the first, a middle and the last of the snapshots holding c.
    const store = pgRetentionStore(tenantRunner(db, f.tenantId), f.tenantId);
    for (const i of [1, 0, 2]) {
      const id = ids[i] as string;
      await db.update(snapshots).set({ status: "pruned" }).where(eq(snapshots.id, id));
      // Unreadable manifest: the chunk ids come from the index, exactly this snapshot's.
      expect((await store.loadMirroredChunkIds(id))?.sort()).toEqual(
        (contents[i] ?? []).flatMap((object) => object.chunks).sort(),
      );
      await store.deleteManifestObjects(id);
    }
    for (const i of [3, 4]) {
      expect(await entriesOf(db, f.tenantId, ids[i] as string)).toEqual(
        expected(contents[i] ?? []),
      );
    }
    // c and b v1 are gone with the snapshots that needed them; nothing references c now.
    expect(await versions()).toBe(3);
    expect(await using(cChunks)).toEqual([]);
    expect(await using(dChunks)).toEqual([f.objectId]);
  });

  it("converts every tenant's old per-snapshot rows in the background, exactly, and ends", async () => {
    const tenantsWithData: { f: Fixture; ids: string[]; contents: ManifestObject[][] }[] = [];
    for (let t = 0; t < 2; t += 1) {
      const f = await fixture(db);
      const objects = Array.from({ length: 20 }, (_, i) => mail(`mail/Inbox/m${t}-${i}.eml`));
      const contents = [objects, objects, [...objects.slice(1), mail("mail/Inbox/new.eml")]];
      const ids: string[] = [];
      for (const [i, entries] of contents.entries()) {
        const [row] = await db
          .insert(snapshots)
          .values({
            tenantId: f.tenantId,
            protectedObjectId: f.objectId,
            sequence: i + 1,
            manifestPath: `m/${i}`,
            completedAt: new Date(),
          })
          .returning();
        ids.push(row?.id as string);
        // The 0.3.4 worker's rows.
        for (const object of entries) {
          const slash = object.path.lastIndexOf("/");
          await db.execute(sql`
            INSERT INTO manifest_objects (tenant_id, snapshot_id, protected_object_id, kind, path,
              name, parent_path, size, mtime, item_id, message_id, chunk_refs, metadata)
            VALUES (${f.tenantId}, ${row?.id}, ${f.objectId}, 'mail', ${object.path},
              ${object.path.slice(slash + 1)}, ${object.path.slice(0, slash)}, ${object.size},
              ${new Date(object.mtime).toISOString()}::timestamptz, ${object.id},
              ${object.metadata?.messageId ?? null}, ${JSON.stringify(object.chunks)}::jsonb,
              ${JSON.stringify(object.metadata)}::jsonb)
          `);
        }
      }
      tenantsWithData.push({ f, ids, contents });
    }

    const summary = await convertLegacyManifests({
      db,
      providerDb: db,
      runtime: { logger: noopLogger, shutdownSignal: new AbortController().signal },
    });
    expect(summary).toMatchObject({ snapshots: 6, rows: 2 * (20 + 20 + 20), remaining: false });
    const left = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM manifest_objects`,
    );
    expect(left.rows[0]?.n).toBe(0);
    for (const { f, ids, contents } of tenantsWithData) {
      for (const [i, id] of ids.entries()) {
        expect(await entriesOf(db, f.tenantId, id)).toEqual(expected(contents[i] ?? []));
      }
      const rows = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM manifest_versions WHERE protected_object_id = ${f.objectId}::uuid`,
      );
      expect(rows.rows[0]?.n).toBe(21);
    }

    // The loop itself: nothing left, so it ends on its first tick without converting.
    const shutdown = new AbortController();
    const logged: string[] = [];
    const logger = { ...noopLogger, info: (message: string) => logged.push(message) };
    const stop = startManifestConversion(
      { db, providerDb: db, runtime: { logger, shutdownSignal: shutdown.signal } },
      { firstTickMs: 0, retryMs: 10 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    stop();
    shutdown.abort();
    expect(logged).not.toContain("manifest index conversion started");
  });
});
