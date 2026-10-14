/**
 * The manifest index as versions (manifest-versions.ts), against Postgres.
 *
 * The reference for every check is what 0.3.4 stored: one row per object per
 * snapshot. Each test builds a snapshot history, keeps the objects of every
 * snapshot as that reference, and proves that `manifestEntries` returns
 * exactly those rows for every active completed snapshot (as a multiset, ids
 * aside), whatever happened in between: unchanged, changed, renamed, deleted
 * and duplicated objects, retention pruning first, middle and last snapshots,
 * retried and out-of-order mirroring, discarded snapshots, and the
 * conversion of an old-format database (from the 0.3.4 schema) by
 * migration 0033 and `convertLegacySnapshot`.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, createDb } from "./index.js";
import {
  type ManifestMirrorEntry,
  OPEN_SEQUENCE,
  convertLegacySnapshot,
  manifestEntries,
  mirrorMetadata,
  recordManifestVersions,
  releaseManifestSnapshot,
} from "./manifest-versions.js";
import { reclaimLegacyManifestSpace, runMigrations } from "./migrate.js";
import { chunkIdsFromDriver } from "./schema/manifest.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const DATABASE = `restow_db_manifest_versions_${suffix}`;
const LEGACY_DATABASE = `restow_db_manifest_legacy_${suffix}`;

/** The last migration 0.3.4 shipped: the per-snapshot `manifest_objects` mirror. */
const LAST_0304_MIGRATION = "0032_pve_enrollment_pve_token";

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

// ---------------------------------------------------------------------------
// A deterministic synthetic history
// ---------------------------------------------------------------------------

/** Small seeded PRNG (mulberry32), so a failing history can be replayed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (label: string) => Buffer.from(label.padEnd(32, "#").slice(0, 32)).toString("hex");

function entry(path: string, extra: Partial<ManifestMirrorEntry> = {}): ManifestMirrorEntry {
  const slash = path.lastIndexOf("/");
  const kind = extra.kind ?? "mail";
  return {
    kind,
    path,
    name: slash < 0 ? path : path.slice(slash + 1),
    parentPath: slash < 0 ? "" : path.slice(0, slash),
    size: kind === "folder" ? 0 : 100,
    mtime: kind === "folder" ? null : new Date(Date.UTC(2026, 0, 1)),
    itemId: `item:${path}`,
    messageId: kind === "mail" ? `<${path}@test>` : null,
    chunkRefs: kind === "folder" ? null : [hex(`c:${path}`)],
    metadata: kind === "folder" ? null : { subject: path, folderId: "AAMk-bookkeeping" },
    deleted: false,
    ...extra,
  };
}

/**
 * Snapshot contents evolving the way a mailbox does: most objects unchanged,
 * some read (metadata), some with new content, some moved, removed, added,
 * marked deleted, and now and then an exact duplicate.
 */
function history(seed: number, snapshotsCount: number, initial: number): ManifestMirrorEntry[][] {
  const random = prng(seed);
  let current: ManifestMirrorEntry[] = [
    entry("mail/Inbox", { kind: "folder" }),
    entry("mail/Archive", { kind: "folder" }),
  ];
  let counter = 0;
  const add = () => {
    counter += 1;
    current.push(entry(`mail/${random() < 0.5 ? "Inbox" : "Archive"}/m${counter}.eml`));
  };
  for (let i = 0; i < initial; i += 1) {
    add();
  }
  const result: ManifestMirrorEntry[][] = [];
  for (let s = 0; s < snapshotsCount; s += 1) {
    if (s > 0) {
      current = current.flatMap((object) => {
        if (object.kind === "folder") {
          return [object];
        }
        const roll = random();
        if (roll < 0.05) {
          return []; // removed at the source
        }
        if (roll < 0.1) {
          return [{ ...object, metadata: { ...object.metadata, isRead: "true" } }];
        }
        if (roll < 0.13) {
          return [{ ...object, chunkRefs: [hex(`c:${object.path}:${s}`)], size: 100 + s }];
        }
        if (roll < 0.16) {
          // Moved to the other folder: same item id, new path.
          const name = object.name;
          const parent = object.parentPath === "mail/Inbox" ? "mail/Archive" : "mail/Inbox";
          return [{ ...object, path: `${parent}/${name}`, parentPath: parent }];
        }
        if (roll < 0.18) {
          return [{ ...object, deleted: !object.deleted }];
        }
        if (roll < 0.19) {
          // Only bookkeeping metadata changed: the mirror keeps the version.
          return [{ ...object, metadata: { ...object.metadata, folderId: `AAMk-${s}` } }];
        }
        return [object];
      });
      const added = Math.floor(random() * 4);
      for (let i = 0; i < added; i += 1) {
        add();
      }
      if (random() < 0.3) {
        const mails = current.filter((object) => object.kind !== "folder");
        const twin = mails[Math.floor(random() * mails.length)];
        if (twin) {
          current.push({ ...twin });
        }
      }
    }
    result.push([...current]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Normalising both sides
// ---------------------------------------------------------------------------

function canonical(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, canonical(inner)]),
    );
  }
  return value;
}

function expectedOf(entries: readonly ManifestMirrorEntry[]): string[] {
  return entries
    .map((object) =>
      JSON.stringify({
        kind: object.kind,
        path: object.path,
        name: object.name,
        parentPath: object.parentPath,
        size: object.size,
        mtime: object.mtime ? object.mtime.toISOString() : null,
        itemId: object.itemId,
        messageId: object.messageId,
        chunkRefs: object.chunkRefs ? [...object.chunkRefs] : null,
        metadata: canonical(mirrorMetadata(object.metadata)),
        deleted: object.deleted === true,
      }),
    )
    .sort();
}

interface EntryRow extends Record<string, unknown> {
  kind: string;
  path: string;
  name: string;
  parent_path: string;
  size: string | number;
  mtime: string | Date | null;
  item_id: string | null;
  message_id: string | null;
  chunk_refs: unknown;
  metadata: Record<string, unknown> | null;
  deleted: boolean;
}

async function actualOf(db: Database, tenantId: string, snapshotId: string): Promise<string[]> {
  const result = await db.execute<EntryRow>(
    sql`SELECT * FROM ${manifestEntries({ tenantId, snapshots: sql`s.id = ${snapshotId}::uuid`, chunks: true })} AS m`,
  );
  return result.rows
    .map((row) =>
      JSON.stringify({
        kind: row.kind,
        path: row.path,
        name: row.name,
        parentPath: row.parent_path,
        size: Number(row.size),
        mtime: row.mtime ? new Date(row.mtime).toISOString() : null,
        itemId: row.item_id,
        messageId: row.message_id,
        chunkRefs: row.chunk_refs === null ? null : chunkIdsFromDriver(row.chunk_refs),
        metadata: canonical(row.metadata),
        deleted: row.deleted,
      }),
    )
    .sort();
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  tenantId: string;
  sourceId: string;
}

async function seedTenant(db: Database): Promise<Fixture> {
  const tenantId = randomUUID();
  const providerId = (
    await db.execute<{ id: string }>(sql`INSERT INTO providers (name) VALUES ('P') RETURNING id`)
  ).rows[0]?.id as string;
  await db.execute(
    sql`INSERT INTO tenants (id, provider_id, name, slug) VALUES (${tenantId}, ${providerId}, ${`t-${tenantId}`}, ${`t-${tenantId}`})`,
  );
  const sourceId = (
    await db.execute<{ id: string }>(
      sql`INSERT INTO sources (tenant_id, kind, name, status) VALUES (${tenantId}, 'm365', 'M365', 'active') RETURNING id`,
    )
  ).rows[0]?.id as string;
  return { tenantId, sourceId };
}

async function protectedObject(db: Database, fixture: Fixture): Promise<string> {
  return (
    await db.execute<{ id: string }>(
      sql`INSERT INTO protected_objects (tenant_id, source_id, kind, external_id)
          VALUES (${fixture.tenantId}, ${fixture.sourceId}, 'mailbox', ${`mb-${randomUUID()}`}) RETURNING id`,
    )
  ).rows[0]?.id as string;
}

async function createSnapshot(
  db: Database,
  tenantId: string,
  objectId: string,
  sequence: number,
): Promise<string> {
  return (
    await db.execute<{ id: string }>(
      sql`INSERT INTO snapshots (tenant_id, protected_object_id, sequence, status)
          VALUES (${tenantId}, ${objectId}, ${sequence}, 'active') RETURNING id`,
    )
  ).rows[0]?.id as string;
}

async function completeSnapshot(db: Database, snapshotId: string): Promise<void> {
  await db.execute(
    sql`UPDATE snapshots SET manifest_path = ${`manifests/${snapshotId}`}, completed_at = now() WHERE id = ${snapshotId}::uuid`,
  );
}

/** What the engine does on commit: mirror, then complete (same order as SnapshotWriter). */
async function commit(
  db: Database,
  scope: { tenantId: string; protectedObjectId: string; snapshotId: string; sequence: number },
  entries: readonly ManifestMirrorEntry[],
) {
  const outcome = await db.transaction((tx) => recordManifestVersions(tx, scope, entries));
  await completeSnapshot(db, scope.snapshotId);
  return outcome;
}

async function versionCount(db: Database, objectId: string): Promise<number> {
  const result = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM manifest_versions WHERE protected_object_id = ${objectId}::uuid`,
  );
  return Number(result.rows[0]?.n);
}

async function prune(
  db: Database,
  scope: { tenantId: string; protectedObjectId: string; snapshotId: string; sequence: number },
): Promise<number> {
  // Retention's order: flip to pruned, then release the index rows.
  await db.execute(
    sql`UPDATE snapshots SET status = 'pruned' WHERE id = ${scope.snapshotId}::uuid`,
  );
  return db.transaction((tx) => releaseManifestSnapshot(tx, scope));
}

interface Recorded {
  snapshotId: string;
  sequence: number;
  entries: ManifestMirrorEntry[];
  active: boolean;
}

async function expectAllMatch(db: Database, tenantId: string, recorded: readonly Recorded[]) {
  for (const snapshot of recorded.filter((s) => s.active)) {
    expect(
      await actualOf(db, tenantId, snapshot.snapshotId),
      `sequence ${snapshot.sequence}`,
    ).toEqual(expectedOf(snapshot.entries));
  }
}

describe.skipIf(!adminUrl)("manifest versions", () => {
  let db: Database;
  let fixture: Fixture;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl as string });
    try {
      await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.end();
    }
    const url = urlFor(adminUrl as string, DATABASE);
    await runMigrations(url);
    db = createDb(url);
    fixture = await seedTenant(db);
  });

  afterAll(async () => {
    await db?.$client.end();
    if (adminUrl) {
      await dropTestDatabase(adminUrl, DATABASE);
    }
  });

  it("stores N unchanged backups as one row per object, not N", async () => {
    const objectId = await protectedObject(db, fixture);
    const objects = [entry("mail/Inbox", { kind: "folder" })];
    for (let i = 0; i < 49; i += 1) {
      objects.push(entry(`mail/Inbox/m${i}.eml`));
    }
    const recorded: Recorded[] = [];
    const tuples = async () =>
      (
        await db.execute<{ id: string; xmin: string }>(
          sql`SELECT id::text, xmin::text FROM manifest_versions WHERE protected_object_id = ${objectId}::uuid ORDER BY id`,
        )
      ).rows;
    let afterFirst: { id: string; xmin: string }[] = [];
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      if (sequence === 2) {
        afterFirst = await tuples();
      }
      const snapshotId = await createSnapshot(db, fixture.tenantId, objectId, sequence);
      const outcome = await commit(
        db,
        { tenantId: fixture.tenantId, protectedObjectId: objectId, snapshotId, sequence },
        objects,
      );
      expect(outcome).toEqual(
        sequence === 1
          ? { unchanged: 0, extended: 0, inserted: 50, removed: 0, merged: 0 }
          : // Unchanged objects cost no write at all.
            { unchanged: 50, extended: 0, inserted: 0, removed: 0, merged: 0 },
      );
      recorded.push({ snapshotId, sequence, entries: objects, active: true });
    }
    expect(await versionCount(db, objectId)).toBe(50);
    // Not one row was rewritten by the nine unchanged backups (same tuples, same xmin).
    expect(await tuples()).toEqual(afterFirst);
    await expectAllMatch(db, fixture.tenantId, recorded);

    // One changed object adds one version; everything else keeps extending.
    const changed = objects.map((object) =>
      object.path === "mail/Inbox/m7.eml"
        ? { ...object, chunkRefs: [hex("m7-v2")], size: 7 }
        : object,
    );
    const snapshotId = await createSnapshot(db, fixture.tenantId, objectId, 11);
    expect(
      await commit(
        db,
        { tenantId: fixture.tenantId, protectedObjectId: objectId, snapshotId, sequence: 11 },
        changed,
      ),
    ).toEqual({ unchanged: 49, extended: 0, inserted: 1, removed: 1, merged: 0 });
    recorded.push({ snapshotId, sequence: 11, entries: changed, active: true });
    expect(await versionCount(db, objectId)).toBe(51);
    await expectAllMatch(db, fixture.tenantId, recorded);

    // Version history: the item's rows ordered by first sequence.
    const versions = await db.execute<{ first_sequence: number; last_sequence: number }>(sql`
      SELECT first_sequence, last_sequence FROM manifest_versions
      WHERE protected_object_id = ${objectId}::uuid AND path = 'mail/Inbox/m7.eml'
      ORDER BY first_sequence
    `);
    expect(versions.rows).toEqual([
      { first_sequence: 1, last_sequence: 10 },
      { first_sequence: 11, last_sequence: OPEN_SEQUENCE },
    ]);
  });

  it("keeps only what the readers use of the metadata and stores chunk ids as 32 bytes", async () => {
    const objectId = await protectedObject(db, fixture);
    const snapshotId = await createSnapshot(db, fixture.tenantId, objectId, 1);
    const id = "ab".repeat(32);
    await commit(
      db,
      { tenantId: fixture.tenantId, protectedObjectId: objectId, snapshotId, sequence: 1 },
      [
        entry("mail/Inbox/a.eml", {
          chunkRefs: [id, id],
          metadata: { subject: "Hi", from: "a@b", folderId: "x", fingerprint: "y", uid: "1" },
        }),
      ],
    );
    const result = await db.execute<{ metadata: unknown; widths: number[] }>(sql`
      SELECT metadata, (SELECT array_agg(octet_length(c)) FROM unnest(chunk_refs) c) AS widths
      FROM manifest_versions WHERE protected_object_id = ${objectId}::uuid
    `);
    expect(result.rows).toEqual([{ metadata: { subject: "Hi", from: "a@b" }, widths: [32, 32] }]);
  });

  it("returns for every snapshot exactly the per-snapshot rows of 0.3.4, through a realistic history", async () => {
    for (const seed of [1, 2, 3]) {
      const objectId = await protectedObject(db, fixture);
      const contents = history(seed, 12, 40);
      const recorded: Recorded[] = [];
      let perSnapshotRows = 0;
      for (const [index, entries] of contents.entries()) {
        const sequence = index + 1;
        const snapshotId = await createSnapshot(db, fixture.tenantId, objectId, sequence);
        await commit(
          db,
          { tenantId: fixture.tenantId, protectedObjectId: objectId, snapshotId, sequence },
          entries,
        );
        recorded.push({ snapshotId, sequence, entries, active: true });
        perSnapshotRows += entries.length;
        await expectAllMatch(db, fixture.tenantId, recorded);
      }
      const rows = await versionCount(db, objectId);
      // Far fewer rows than one per object per snapshot.
      expect(rows).toBeLessThan(perSnapshotRows / 3);

      // Retention: a middle snapshot, the first, then the last.
      for (const index of [5, 0, 11]) {
        const target = recorded[index] as Recorded;
        await prune(db, {
          tenantId: fixture.tenantId,
          protectedObjectId: objectId,
          snapshotId: target.snapshotId,
          sequence: target.sequence,
        });
        target.active = false;
        await expectAllMatch(db, fixture.tenantId, recorded);
      }
      // No row survives that covers no active snapshot.
      const orphans = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM manifest_versions v
        WHERE v.protected_object_id = ${objectId}::uuid AND NOT EXISTS (
          SELECT 1 FROM snapshots s WHERE s.protected_object_id = v.protected_object_id
            AND s.status = 'active' AND s.sequence BETWEEN v.first_sequence AND v.last_sequence)
      `);
      expect(orphans.rows[0]?.n).toBe(0);

      // The next backup after a pruned latest snapshot extends from the newest active one.
      const sequence = 13;
      const snapshotId = await createSnapshot(db, fixture.tenantId, objectId, sequence);
      const latest = recorded[10] as Recorded;
      await commit(
        db,
        { tenantId: fixture.tenantId, protectedObjectId: objectId, snapshotId, sequence },
        latest.entries,
      );
      recorded.push({ snapshotId, sequence, entries: latest.entries, active: true });
      await expectAllMatch(db, fixture.tenantId, recorded);

      // Pruning everything leaves no row.
      for (const snapshot of recorded.filter((s) => s.active)) {
        await prune(db, {
          tenantId: fixture.tenantId,
          protectedObjectId: objectId,
          snapshotId: snapshot.snapshotId,
          sequence: snapshot.sequence,
        });
      }
      expect(await versionCount(db, objectId)).toBe(0);
    }
  });

  it("replaces what an earlier attempt mirrored when a commit is retried", async () => {
    const objectId = await protectedObject(db, fixture);
    const contents = history(7, 4, 20);
    const recorded: Recorded[] = [];
    for (const [index, entries] of contents.slice(0, 3).entries()) {
      const sequence = index + 1;
      const snapshotId = await createSnapshot(db, fixture.tenantId, objectId, sequence);
      await commit(
        db,
        { tenantId: fixture.tenantId, protectedObjectId: objectId, snapshotId, sequence },
        entries,
      );
      recorded.push({ snapshotId, sequence, entries, active: true });
    }
    const snapshotId = await createSnapshot(db, fixture.tenantId, objectId, 4);
    const scope = {
      tenantId: fixture.tenantId,
      protectedObjectId: objectId,
      snapshotId,
      sequence: 4,
    };
    // A first attempt mirrors something else and fails before completing the row...
    await db.transaction((tx) => recordManifestVersions(tx, scope, contents[0] ?? []));
    // ...the retry mirrors the real content twice (idempotent) and completes.
    await db.transaction((tx) => recordManifestVersions(tx, scope, contents[3] ?? []));
    await commit(db, scope, contents[3] ?? []);
    recorded.push({ snapshotId, sequence: 4, entries: contents[3] ?? [], active: true });
    await expectAllMatch(db, fixture.tenantId, recorded);
  });

  it("stays exact and compact when snapshots are mirrored out of order", async () => {
    const contents = history(11, 8, 30);
    const counts: number[] = [];
    for (const order of [
      [0, 1, 2, 3, 4, 5, 6, 7],
      [7, 6, 5, 4, 3, 2, 1, 0],
      [3, 0, 6, 1, 7, 2, 5, 4],
    ]) {
      const objectId = await protectedObject(db, fixture);
      const recorded: Recorded[] = [];
      for (const [index, entries] of contents.entries()) {
        const sequence = index + 1;
        const snapshotId = await createSnapshot(db, fixture.tenantId, objectId, sequence);
        recorded.push({ snapshotId, sequence, entries, active: false });
      }
      for (const index of order) {
        const snapshot = recorded[index] as Recorded;
        await commit(
          db,
          {
            tenantId: fixture.tenantId,
            protectedObjectId: objectId,
            snapshotId: snapshot.snapshotId,
            sequence: snapshot.sequence,
          },
          snapshot.entries,
        );
        snapshot.active = true;
        await expectAllMatch(db, fixture.tenantId, recorded);
      }
      counts.push(await versionCount(db, objectId));
    }
    // In order and in reverse fold to the same versions; a shuffled order stays close.
    expect(counts[1]).toBe(counts[0]);
    expect(counts[2]).toBeLessThanOrEqual((counts[0] ?? 0) * 1.5);
  });

  it("drops what a discarded snapshot mirrored", async () => {
    const objectId = await protectedObject(db, fixture);
    const base = [entry("mail/Inbox/a.eml"), entry("mail/Inbox/b.eml")];
    const first = await createSnapshot(db, fixture.tenantId, objectId, 1);
    await commit(
      db,
      { tenantId: fixture.tenantId, protectedObjectId: objectId, snapshotId: first, sequence: 1 },
      base,
    );
    const running = await createSnapshot(db, fixture.tenantId, objectId, 2);
    const scope = {
      tenantId: fixture.tenantId,
      protectedObjectId: objectId,
      snapshotId: running,
      sequence: 2,
    };
    await db.transaction((tx) =>
      recordManifestVersions(tx, scope, [...base, entry("mail/Inbox/c.eml")]),
    );
    expect(await versionCount(db, objectId)).toBe(3);
    // The engine discards the uncommitted snapshot: the row goes, then the index rows.
    await db.execute(sql`DELETE FROM snapshots WHERE id = ${running}::uuid`);
    await db.transaction((tx) => releaseManifestSnapshot(tx, scope));
    expect(await versionCount(db, objectId)).toBe(2);
    expect(await actualOf(db, fixture.tenantId, first)).toEqual(expectedOf(base));

    // The sequence is used again by the next backup: it starts from a clean slate.
    const next = await createSnapshot(db, fixture.tenantId, objectId, 2);
    const nextEntries = [entry("mail/Inbox/a.eml")];
    await commit(
      db,
      { tenantId: fixture.tenantId, protectedObjectId: objectId, snapshotId: next, sequence: 2 },
      nextEntries,
    );
    expect(await actualOf(db, fixture.tenantId, first)).toEqual(expectedOf(base));
    expect(await actualOf(db, fixture.tenantId, next)).toEqual(expectedOf(nextEntries));
  });
});

// ---------------------------------------------------------------------------
// Upgrading a 0.3.4 database
// ---------------------------------------------------------------------------

/** A migrations folder holding only what shipped up to and including `tag`. */
function migrationsFolderUpTo(tag: string): string {
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as {
    entries: { tag: string }[];
  };
  const last = journal.entries.findIndex((item) => item.tag === tag);
  if (last < 0) {
    throw new Error(`${tag} is not in the migration journal`);
  }
  const entries = journal.entries.slice(0, last + 1);
  const folder = mkdtempSync(join(tmpdir(), "restow-0304-migrations-"));
  mkdirSync(join(folder, "meta"));
  for (const item of entries) {
    copyFileSync(join(migrationsFolder, `${item.tag}.sql`), join(folder, `${item.tag}.sql`));
  }
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return folder;
}

/** Insert one snapshot's objects the way 0.3.4's worker did (one row each, jsonb chunk ids). */
async function insertLegacyRows(
  pool: pg.Pool,
  scope: { tenantId: string; protectedObjectId: string; snapshotId: string },
  entries: readonly ManifestMirrorEntry[],
): Promise<void> {
  for (const object of entries) {
    await pool.query(
      `INSERT INTO manifest_objects (tenant_id, snapshot_id, protected_object_id, kind, path, name,
         parent_path, size, mtime, item_id, message_id, chunk_refs, metadata, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14)`,
      [
        scope.tenantId,
        scope.snapshotId,
        scope.protectedObjectId,
        object.kind,
        object.path,
        object.name,
        object.parentPath,
        object.size,
        object.mtime,
        object.itemId,
        object.messageId,
        object.chunkRefs === null ? null : JSON.stringify(object.chunkRefs),
        object.metadata === null ? null : JSON.stringify(object.metadata),
        object.deleted === true,
      ],
    );
  }
}

describe.skipIf(!adminUrl)("upgrading a 0.3.4 manifest index", () => {
  let folder: string;
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl as string });
    try {
      await admin.query(`CREATE DATABASE ${LEGACY_DATABASE}`);
    } finally {
      await admin.end();
    }
    folder = migrationsFolderUpTo(LAST_0304_MIGRATION);
    pool = new pg.Pool({ connectionString: urlFor(adminUrl as string, LEGACY_DATABASE) });
    await migrate(drizzle(pool), { migrationsFolder: folder });
    db = createDb(urlFor(adminUrl as string, LEGACY_DATABASE));
  });

  afterAll(async () => {
    await Promise.all([pool?.end(), db?.$client.end()]);
    if (folder) {
      rmSync(folder, { recursive: true, force: true });
    }
    if (adminUrl) {
      await dropTestDatabase(adminUrl, LEGACY_DATABASE);
    }
  });

  it("migrates instantly, reads the old rows meanwhile, converts them exactly and gives the space back", async () => {
    // 0.3.4 data: two mailboxes, one with a running (uncommitted) last snapshot.
    const fixture = await seedTenant(db);
    const objects: { id: string; snapshots: Recorded[] }[] = [];
    let legacyRows = 0;
    for (const seed of [21, 22]) {
      const id = await protectedObject(db, fixture);
      const contents = history(seed, 10, 60);
      const snapshots: Recorded[] = [];
      for (const [index, entries] of contents.entries()) {
        const sequence = index + 1;
        const snapshotId = await createSnapshot(db, fixture.tenantId, id, sequence);
        await insertLegacyRows(
          pool,
          { tenantId: fixture.tenantId, protectedObjectId: id, snapshotId },
          entries,
        );
        legacyRows += entries.length;
        const running = seed === 22 && sequence === contents.length;
        if (!running) {
          await completeSnapshot(db, snapshotId);
        }
        // `active` here: completed, so the explorer reads it.
        snapshots.push({ snapshotId, sequence, entries, active: !running });
      }
      objects.push({ id, snapshots });
    }
    // A chunk id that is not hex (hand-made data) converts without failing.
    await pool.query(
      `UPDATE manifest_objects SET chunk_refs = '["not-hex"]'::jsonb
       WHERE path = (SELECT min(path) FROM manifest_objects WHERE kind = 'mail')`,
    );
    const odd = await pool.query<{ snapshot_id: string }>(
      `SELECT snapshot_id FROM manifest_objects WHERE chunk_refs = '["not-hex"]'::jsonb`,
    );
    const oddSnapshots = new Set(odd.rows.map((row) => row.snapshot_id));

    // Migration 0033 (the api start): schema only, the old rows stay.
    const started = Date.now();
    await runMigrations(urlFor(adminUrl as string, LEGACY_DATABASE));
    expect(Date.now() - started).toBeLessThan(30_000);
    const indexes = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'manifest_objects' ORDER BY indexname",
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "manifest_objects_pkey",
      "manifest_objects_snapshot_parent_idx",
    ]);
    const remaining = async () =>
      Number(
        (await pool.query<{ n: string }>("SELECT count(*) AS n FROM manifest_objects")).rows[0]?.n,
      );
    expect(await remaining()).toBe(legacyRows);

    const check = async () => {
      for (const object of objects) {
        for (const snapshot of object.snapshots.filter((candidate) => candidate.active)) {
          const actual = await actualOf(db, fixture.tenantId, snapshot.snapshotId);
          if (oddSnapshots.has(snapshot.snapshotId)) {
            expect(actual.length).toBe(snapshot.entries.length);
          } else {
            expect(actual, `sequence ${snapshot.sequence}`).toEqual(expectedOf(snapshot.entries));
          }
        }
      }
    };
    // Before any conversion the readers serve the old rows.
    await check();

    // Half of the first mailbox converted: old and new rows side by side, still exact.
    const [first, second] = objects as [(typeof objects)[0], (typeof objects)[0]];
    for (const snapshot of first.snapshots.slice(0, 5)) {
      await db.transaction((tx) =>
        convertLegacySnapshot(tx, fixture.tenantId, snapshot.snapshotId),
      );
    }
    await check();
    // A new backup lands mid-conversion: it writes versions and is exact too.
    const extra = await createSnapshot(db, fixture.tenantId, first.id, 11);
    const extraEntries = first.snapshots[9]?.entries ?? [];
    await commit(
      db,
      { tenantId: fixture.tenantId, protectedObjectId: first.id, snapshotId: extra, sequence: 11 },
      extraEntries,
    );
    first.snapshots.push({ snapshotId: extra, sequence: 11, entries: extraEntries, active: true });
    await check();

    // The rest, oldest first, as the worker does.
    for (const object of objects) {
      for (const snapshot of object.snapshots.slice(0, 10)) {
        const outcome = await db.transaction((tx) =>
          convertLegacySnapshot(tx, fixture.tenantId, snapshot.snapshotId),
        );
        if (object === first && snapshot.sequence <= 5) {
          expect(outcome).toBeNull();
        } else {
          expect(outcome?.converted).toBe(snapshot.entries.length);
        }
      }
    }
    await check();
    expect(await remaining()).toBe(0);

    // The converted index is as compact as one written by 0.3.5 from the start.
    const converted = await versionCount(db, second.id);
    const direct = await protectedObject(db, fixture);
    for (const snapshot of second.snapshots) {
      const snapshotId = await createSnapshot(db, fixture.tenantId, direct, snapshot.sequence);
      const scope = {
        tenantId: fixture.tenantId,
        protectedObjectId: direct,
        snapshotId,
        sequence: snapshot.sequence,
      };
      // The running snapshot is not mirrored before its commit (the conversion drops its old rows).
      if (snapshot.active) {
        await commit(db, scope, snapshot.entries);
      }
    }
    expect(converted).toBe(await versionCount(db, direct));
    const totalSnapshotsRows = second.snapshots.reduce((sum, s) => sum + s.entries.length, 0);
    expect(converted).toBeLessThan(totalSnapshotsRows / 3);

    // The next api start truncates the empty old table; not while rows are left.
    const ownerPool = new pg.Pool({
      connectionString: urlFor(adminUrl as string, LEGACY_DATABASE),
    });
    try {
      expect(await reclaimLegacyManifestSpace(ownerPool, 0)).toBe(true);
      const size = await ownerPool.query<{ bytes: string }>(
        "SELECT pg_relation_size('manifest_objects')::text AS bytes",
      );
      expect(Number(size.rows[0]?.bytes)).toBe(0);
      await insertLegacyRows(
        ownerPool,
        { tenantId: fixture.tenantId, protectedObjectId: first.id, snapshotId: extra },
        [entry("mail/x.eml")],
      );
      expect(await reclaimLegacyManifestSpace(ownerPool, 0)).toBe(false);
      await ownerPool.query("DELETE FROM manifest_objects");
    } finally {
      await ownerPool.end();
    }
  });
});
