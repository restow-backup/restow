/**
 * The explorer on the versioned manifest index answers exactly as it did on
 * the per-snapshot mirror of 0.3.4.
 *
 * Two twin mailboxes get the same synthetic history (adds, content changes,
 * read flags, moves between folders, deletions at the source, items marked
 * deleted, attachments of JSON-format messages, duplicates): one stored the
 * 0.3.4 way, one row per object per snapshot in `manifest_objects`, the other
 * through the 0.3.5 writer (`recordManifestVersions`). For every snapshot,
 * the folder listings (both sorts, with and without deleted items, folders
 * only), search, version history, restore and export selection resolution
 * and the implicit folders must be identical, row ids aside. Then retention
 * prunes snapshots of both and the remaining snapshots must still agree.
 */
import { randomUUID } from "node:crypto";
import {
  createDb,
  type Database,
  type ManifestMirrorEntry,
  protectedObjects,
  recordManifestVersions,
  releaseManifestSnapshot,
  snapshots,
} from "@restow/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { implicitFolders, selectedEntries } from "../restore/service.js";
import type { Viewer } from "./access.js";
import { searchQuerySchema, treeQuerySchema, versionsQuerySchema } from "./schemas.js";
import { listTree, listVersions, type SnapshotReader, search } from "./service.js";
import {
  createExplorerFixture,
  dropDatabase,
  type ExplorerFixture,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "./testing/explorer-fixture.js";

const DATABASE = "restow_api_versions_equivalence_test";
const reader = (viewer: Viewer): SnapshotReader => ({ ...viewer, ip: "198.51.100.9" });
const SNAPSHOTS = 8;

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
const day = (n: number) => new Date(Date.UTC(2026, 0, n, 8, 0, 0));

function entry(path: string, extra: Partial<ManifestMirrorEntry> = {}): ManifestMirrorEntry {
  const slash = path.lastIndexOf("/");
  const kind = extra.kind ?? "mail";
  return {
    kind,
    path,
    name: slash < 0 ? path : path.slice(slash + 1),
    parentPath: slash < 0 ? "" : path.slice(0, slash),
    size: kind === "folder" ? 0 : 100,
    mtime: kind === "folder" ? null : day(1),
    itemId: `item:${path}`,
    messageId: null,
    chunkRefs: kind === "folder" ? null : [hex(path)],
    metadata: null,
    deleted: false,
    ...extra,
  };
}

/** A mailbox history: what every snapshot holds. */
function mailboxHistory(seed: number): ManifestMirrorEntry[][] {
  const random = prng(seed);
  const folders = ["mail/Inbox", "mail/Inbox/Projects", "mail/Archive"];
  let current: ManifestMirrorEntry[] = folders.map((path) => entry(path, { kind: "folder" }));
  let counter = 0;
  const add = (snapshot: number) => {
    counter += 1;
    const folder = folders[Math.floor(random() * folders.length)] as string;
    const n = counter;
    current.push(
      entry(`${folder}/Mail ${n}.eml`, {
        itemId: `msg-${n}`,
        mtime: day(1 + (n % 9)),
        metadata: {
          subject: `Subject ${n}${n % 3 === 0 ? " invoice" : ""}`,
          from: `Sender ${n % 4} <s${n % 4}@contoso.test>`,
          receivedDateTime: day(1 + ((n * 7) % 11)).toISOString(),
          folderId: `AAMk-${snapshot}`,
        },
      }),
    );
    if (n % 7 === 0) {
      // An oversized message stored as JSON, with an attachment that is never browsed.
      const message = `${folder}/Big ${n}.json`;
      current.push(
        entry(message, { metadata: { subject: `Big ${n}`, format: "json" }, itemId: `big-${n}` }),
        entry(`${folder}/Big ${n}.attachments/a.pdf`, {
          kind: "file",
          metadata: { messagePath: message },
          itemId: `att-${n}`,
        }),
      );
    }
  };
  for (let i = 0; i < 25; i += 1) {
    add(1);
  }
  const result: ManifestMirrorEntry[][] = [];
  for (let s = 1; s <= SNAPSHOTS; s += 1) {
    if (s > 1) {
      current = current.flatMap((object) => {
        if (object.kind === "folder" || object.metadata?.messagePath) {
          return [object];
        }
        const roll = random();
        if (roll < 0.05) {
          return [];
        }
        if (roll < 0.12) {
          return [{ ...object, metadata: { ...object.metadata, isRead: "true" } }];
        }
        if (roll < 0.16) {
          return [{ ...object, chunkRefs: [hex(`${object.path}@${s}`)], size: 100 + s }];
        }
        if (roll < 0.2) {
          const parent = object.parentPath === "mail/Archive" ? "mail/Inbox" : "mail/Archive";
          return [{ ...object, path: `${parent}/${object.name}`, parentPath: parent }];
        }
        if (roll < 0.23) {
          return [{ ...object, deleted: true }];
        }
        if (roll < 0.26) {
          // Bookkeeping only: the 0.3.5 index keeps the version, 0.3.4 stored a new copy.
          return [{ ...object, metadata: { ...object.metadata, folderId: `AAMk-${s}` } }];
        }
        return [object];
      });
      for (let i = 0; i < 3; i += 1) {
        add(s);
      }
    }
    // Now and then an exact duplicate entry, for this snapshot only: two different
    // objects at one path have no defined order in a listing, before 0.3.5 or since.
    const mails = current.filter((object) => object.kind === "mail");
    const twin = mails[Math.floor(random() * mails.length)];
    result.push(twin && random() < 0.4 ? [...current, { ...twin }] : [...current]);
  }
  return result;
}

/** Strip what legitimately differs between the twins: row ids and the twin's own ids. */
function withoutIds<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, inner) => {
      if (key === "id" && typeof inner === "string" && !inner.startsWith("folder:")) {
        return "<id>";
      }
      if (key === "objectId") {
        return "<object>";
      }
      if (key === "snapshotId" || key === "snapshot") {
        return key === "snapshot"
          ? { ...inner, id: "<snapshot>", objectId: "<object>" }
          : "<snapshot>";
      }
      if (key === "object" && inner && typeof inner === "object") {
        return { ...inner, id: "<object>", externalId: "<external>", displayName: "<name>" };
      }
      return inner;
    }),
  );
}

describe.skipIf(!testDatabaseAdminUrl)(
  "versioned index equals the 0.3.4 per-snapshot mirror",
  () => {
    let db: Database;
    let f: ExplorerFixture;
    let legacy: { object: string; snapshots: string[] };
    let versioned: { object: string; snapshots: string[] };
    let contents: ManifestMirrorEntry[][];

    beforeAll(async () => {
      db = createDb(await recreateDatabase(testDatabaseAdminUrl as string, DATABASE));
      f = await createExplorerFixture(db);
      const [anna] = await db
        .select({ sourceId: protectedObjects.sourceId })
        .from(protectedObjects)
        .where(eq(protectedObjects.id, f.annaMailbox));
      const twin = async (externalId: string) => {
        const [row] = await db
          .insert(protectedObjects)
          .values({
            tenantId: f.tenantId,
            sourceId: anna?.sourceId as string,
            kind: "mailbox",
            externalId,
            displayName: externalId,
          })
          .returning();
        const ids: string[] = [];
        for (let sequence = 1; sequence <= SNAPSHOTS; sequence += 1) {
          const [snapshot] = await db
            .insert(snapshots)
            .values({
              tenantId: f.tenantId,
              protectedObjectId: row?.id as string,
              sequence,
              startedAt: day(sequence),
              completedAt: day(sequence),
              createdAt: day(sequence),
              manifestPath: `tenants/${f.tenantId}/manifests/${randomUUID()}`,
            })
            .returning();
          ids.push(snapshot?.id as string);
        }
        return { object: row?.id as string, snapshots: ids };
      };
      legacy = await twin("legacy@contoso.test");
      versioned = await twin("versioned@contoso.test");
      contents = mailboxHistory(5);
      for (const [index, entries] of contents.entries()) {
        for (const object of entries) {
          await db.execute(sql`
          INSERT INTO manifest_objects (tenant_id, snapshot_id, protected_object_id, kind, path, name,
            parent_path, size, mtime, item_id, message_id, chunk_refs, metadata, deleted)
          VALUES (${f.tenantId}, ${legacy.snapshots[index]}, ${legacy.object}, ${object.kind},
            ${object.path}, ${object.name}, ${object.parentPath}, ${object.size},
            ${object.mtime ? object.mtime.toISOString() : null}::timestamptz, ${object.itemId},
            ${object.messageId}, ${object.chunkRefs ? JSON.stringify(object.chunkRefs) : null}::jsonb,
            ${object.metadata ? JSON.stringify(object.metadata) : null}::jsonb, ${object.deleted === true})
        `);
        }
        await db.transaction((tx) =>
          recordManifestVersions(
            tx,
            {
              tenantId: f.tenantId,
              protectedObjectId: versioned.object,
              snapshotId: versioned.snapshots[index] as string,
              sequence: index + 1,
            },
            entries,
          ),
        );
      }
    }, 120_000);

    afterAll(async () => {
      await db?.$client.end();
      await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    });

    async function views(objectId: string, snapshotId: string) {
      const out: Record<string, unknown> = {};
      for (const path of ["", "mail", "mail/Inbox", "mail/Inbox/Projects", "mail/Archive"]) {
        for (const sort of ["date", "name"]) {
          for (const includeDeleted of ["true", "false"]) {
            for (const foldersOnly of ["true", "false"]) {
              const listed = await listTree(
                db,
                f.tenantId,
                reader(f.admin),
                snapshotId,
                treeQuerySchema.parse({ path, sort, includeDeleted, foldersOnly, limit: "500" }),
              );
              out[`tree:${path}:${sort}:${includeDeleted}:${foldersOnly}`] = withoutIds(listed);
            }
          }
        }
        // Paging.
        const page = await listTree(
          db,
          f.tenantId,
          reader(f.admin),
          snapshotId,
          treeQuerySchema.parse({ path, limit: "5", offset: "5" }),
        );
        out[`page:${path}`] = withoutIds(page);
      }
      for (const q of ["invoice", "Sender 2", "Mail 1", "a.pdf"]) {
        const found = await search(
          db,
          f.tenantId,
          reader(f.admin),
          searchQuerySchema.parse({ q, snapshotId, limit: "200" }),
        );
        out[`search:${q}`] = withoutIds(found);
      }
      const latest = await search(
        db,
        f.tenantId,
        reader(f.admin),
        searchQuerySchema.parse({ q: "Subject", objectId, limit: "500" }),
      );
      out["search:latest"] = withoutIds(latest);
      // Every item's history by path, and by path or its own source id (a moved item keeps
      // its history). Two different items in one snapshot have no defined order among
      // themselves, so each query names one item.
      for (let n = 1; n <= 12; n += 1) {
        for (const folder of ["mail/Inbox", "mail/Inbox/Projects", "mail/Archive"]) {
          const path = `${folder}/Mail ${n}.eml`;
          for (const itemId of [undefined, `msg-${n}`]) {
            const history = await listVersions(
              db,
              f.tenantId,
              reader(f.admin),
              objectId,
              versionsQuerySchema.parse({ path, ...(itemId ? { itemId } : {}), snapshotId }),
            );
            out[`versions:${path}:${itemId}`] = withoutIds(history);
          }
        }
      }
      const keys = {
        paths: ["mail/Inbox/Mail 3.eml", "mail/Archive/Mail 5.eml", "mail/Inbox", "nope"],
        itemIds: ["msg-7", "msg-12", "missing"],
      };
      out.selection = (await selectedEntries(db, f.tenantId, snapshotId, keys))
        .map((row) => JSON.stringify(row))
        .sort();
      out.implicit = [
        ...(await implicitFolders(db, f.tenantId, snapshotId, ["mail", "mail/Inbox", "nope"])),
      ].sort();
      return out;
    }

    it("answers every view of every snapshot identically", async () => {
      for (let index = 0; index < SNAPSHOTS; index += 1) {
        const old = await views(legacy.object, legacy.snapshots[index] as string);
        const now = await views(versioned.object, versioned.snapshots[index] as string);
        expect(now, `snapshot ${index + 1}`).toEqual(old);
        // Not vacuous: the views have content.
        expect((old["tree:mail/Inbox:date:true:false"] as { total: number }).total).toBeGreaterThan(
          5,
        );
        expect((old["search:invoice"] as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
      }
      // And with far fewer rows than the per-snapshot copy.
      const counts = await db.execute<{ legacy: number; versions: number }>(sql`
      SELECT (SELECT count(*) FROM manifest_objects WHERE protected_object_id = ${legacy.object}::uuid)::int AS legacy,
             (SELECT count(*) FROM manifest_versions WHERE protected_object_id = ${versioned.object}::uuid)::int AS versions
    `);
      const row = counts.rows[0] as { legacy: number; versions: number };
      expect(row.versions).toBeLessThan(row.legacy / 3);
    }, 120_000);

    it("still agrees after retention pruned the first, a middle and the last snapshot", async () => {
      for (const index of [0, 4, SNAPSHOTS - 1]) {
        for (const twin of [legacy, versioned]) {
          const snapshotId = twin.snapshots[index] as string;
          await db.update(snapshots).set({ status: "pruned" }).where(eq(snapshots.id, snapshotId));
          await db.transaction((tx) =>
            releaseManifestSnapshot(tx, {
              tenantId: f.tenantId,
              protectedObjectId: twin.object,
              snapshotId,
              sequence: index + 1,
            }),
          );
        }
      }
      for (let index = 0; index < SNAPSHOTS; index += 1) {
        if ([0, 4, SNAPSHOTS - 1].includes(index)) {
          continue;
        }
        const old = await views(legacy.object, legacy.snapshots[index] as string);
        const now = await views(versioned.object, versioned.snapshots[index] as string);
        expect(now, `snapshot ${index + 1}`).toEqual(old);
      }
    }, 120_000);
  },
);
