/**
 * The explorer's folder listing at the size of a large tenant (a mailbox of
 * 60 000 messages over 200 folders and a OneDrive with 20 000 folders, each
 * with a chain of 30 daily restore points; testing/large-fixture.ts): the
 * listing reads the folder's children and the folders below it from
 * `manifest_versions_object_parent_idx`, not every entry of the restore point
 * (up to 0.4.3 it did, which took seconds for a large mailbox and minutes for
 * a large OneDrive). The plans are checked by the buffers they touch, which
 * does not depend on the machine; the times only against a generous bound.
 *
 * It also proves the index-based listing returns exactly what the full scan
 * (still used for restore points of 0.3.4 and earlier) returns, on the large
 * objects and on a small one made of the edge cases of the skip scan.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_explorer_scale_test` is recreated there and dropped
 * after). Without it the suite is skipped; docs/TESTING.md lists it under
 * integration.
 */
import { createDb, type Database, protectedObjects, snapshots, sources } from "@restow/db";
import { eq, type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { treeQuerySchema } from "./schemas.js";
import { type ListingScope, listingStatement, listTree, queryListing } from "./service.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "./testing/explorer-fixture.js";
import { createLargeFixture, type LargeFixture } from "./testing/large-fixture.js";
import { insertManifestRows, type ManifestFixtureRow } from "./testing/manifest-rows.js";

const DATABASE = "restow_api_explorer_scale_test";

const ADMIN = {
  role: "tenant_admin" as const,
  userId: "00000000-0000-4000-8000-000000000001",
  email: "admin@provider.test",
  ip: "198.51.100.7",
};

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}

function nodesOf(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];
}

describe.skipIf(!testDatabaseAdminUrl)("explorer listing at scale", () => {
  let db: Database;
  let f: LargeFixture;
  let edge: { objectId: string; first: string; second: string };

  beforeAll(async () => {
    db = createDb(await recreateDatabase(testDatabaseAdminUrl as string, DATABASE));
    f = await createLargeFixture(db, { messages: 60_000, files: 40_000, snapshots: 30 });
    edge = await createEdgeObject(db, f.tenantId);
    await db.execute(sql`VACUUM ANALYZE manifest_versions`);
  }, 300_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  const scopeOf = (
    objectId: string,
    snapshotId: string,
    sequence: number,
    path: string,
    options: Partial<ListingScope> = {},
  ): ListingScope => ({
    tenantId: f.tenantId,
    snapshotId,
    objectId,
    sequence,
    path,
    includeDeleted: true,
    foldersOnly: false,
    hideNativeVersions: false,
    sort: "date",
    ...options,
  });

  const newestMail = (path: string, options: Partial<ListingScope> = {}) =>
    scopeOf(f.mailbox, f.mailboxSnapshots[29] as string, 30, path, options);
  const newestDrive = (path: string, options: Partial<ListingScope> = {}) =>
    scopeOf(f.drive, f.driveSnapshots[29] as string, 30, path, {
      hideNativeVersions: true,
      ...options,
    });

  /** The plan of one listing page, with what it read. */
  async function explain(scope: ListingScope, page = { limit: 500, offset: 0 }) {
    const listed = await queryListing(db, scope, page);
    const statement: SQL = listingStatement(scope, page);
    const result = await db.execute<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
    );
    const [explained] = result.rows[0]?.["QUERY PLAN"] ?? [];
    if (!explained) {
      throw new Error("EXPLAIN returned no plan");
    }
    const plan = explained.Plan;
    const nodes = nodesOf(plan);
    return {
      total: listed.total,
      buffers: (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0),
      indexes: new Set(nodes.map((node) => node["Index Name"]).filter(Boolean)),
      seqScans: nodes.filter(
        (node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "manifest_versions",
      ).length,
    };
  }

  it("lists a large mailbox's folders from the index, never reading all its messages", async () => {
    // The mailbox holds ~75 000 version rows on several thousand pages; a scan reads them all.
    for (const scope of [
      newestMail("mail", { foldersOnly: true }),
      newestMail("mail"),
      newestMail(""),
      newestMail("mail/Inbox", { foldersOnly: true }),
      newestMail("mail/Folder 07"),
      scopeOf(f.mailbox, f.mailboxSnapshots[9] as string, 10, "mail", { foldersOnly: true }),
    ]) {
      const plan = await explain(scope);
      expect(plan.seqScans, scope.path).toBe(0);
      expect(plan.indexes.has("manifest_versions_object_parent_idx"), scope.path).toBe(true);
      expect(plan.indexes.has("manifest_versions_object_last_idx"), scope.path).toBe(false);
      // A few index pages per child folder (the skip scan probes each one, including the
      // attachments folders it steps over without listing them), not the thousands of
      // pages of the mailbox's messages.
      const children = plan.total + (await hiddenAttachmentsFolders(scope));
      expect(plan.buffers, scope.path).toBeLessThan(1_000 + 10 * children);
    }
  });

  it("does not list the attachments folders of oversized messages", async () => {
    const scope = newestMail("mail/Inbox", { foldersOnly: true });
    expect(await hiddenAttachmentsFolders(scope)).toBeGreaterThan(0);
    for (const method of ["auto", "scan"] as const) {
      const listed = await queryListing(db, scope, { limit: 10_000, offset: 0 }, method);
      expect(listed.entries.filter((entry) => entry.name.endsWith(".attachments"))).toEqual([]);
      expect(listed.total).toBe(listed.entries.length);
    }
  });

  /** The attachments folders directly in the scope's folder, which the listing hides. */
  async function hiddenAttachmentsFolders(scope: ListingScope): Promise<number> {
    const result = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM manifest_versions
      WHERE protected_object_id = ${scope.objectId}::uuid AND parent_path = ${scope.path}
        AND first_sequence <= ${scope.sequence}::int AND last_sequence >= ${scope.sequence}::int
        AND metadata ->> 'folderKind' = 'attachments'
    `);
    return result.rows[0]?.count ?? 0;
  }

  it("lists a large OneDrive's root and deep folders from the index", async () => {
    const parts = f.deepFolder.split("/");
    expect(parts.length).toBe(4);
    for (const path of ["", ...parts.map((_, depth) => parts.slice(0, depth + 1).join("/"))]) {
      for (const foldersOnly of [true, false]) {
        const plan = await explain(newestDrive(path, { foldersOnly }));
        expect(plan.seqScans, path).toBe(0);
        expect(plan.indexes.has("manifest_versions_object_parent_idx"), path).toBe(true);
        expect(plan.buffers, path).toBeLessThan(1_000 + 10 * plan.total);
      }
    }
  });

  it("answers the explorer's requests well within a second", async () => {
    const tree = (snapshotId: string, query: Record<string, string>) =>
      listTree(db, f.tenantId, ADMIN, snapshotId, treeQuerySchema.parse(query));
    const newestMailbox = f.mailboxSnapshots[29] as string;
    const newestDriveSnapshot = f.driveSnapshots[29] as string;
    const requests = [
      () => tree(newestMailbox, { path: "mail", foldersOnly: "true", limit: "2000" }),
      () => tree(newestMailbox, { path: "mail", limit: "500" }),
      () => tree(newestDriveSnapshot, { path: "", foldersOnly: "true", limit: "2000" }),
      () => tree(newestDriveSnapshot, { path: f.deepFolder, limit: "500" }),
    ];
    for (const request of requests) {
      await request();
      const started = performance.now();
      await request();
      // Tens of milliseconds on a laptop; the bound only catches a return of the full scan.
      expect(performance.now() - started).toBeLessThan(1_000);
    }
    const mail = await tree(newestMailbox, { path: "mail", foldersOnly: "true", limit: "2000" });
    expect(mail.entries.map((entry) => entry.name)).toContain("Inbox");
    expect(mail.total).toBe(20);
  }, 30_000);

  /** Both ways of listing one page, which must agree row for row. */
  async function expectSameListing(scope: ListingScope, page = { limit: 500, offset: 0 }) {
    const indexed = await queryListing(db, scope, page);
    const scanned = await queryListing(db, scope, page, "scan");
    expect(indexed.total, JSON.stringify(scope)).toBe(scanned.total);
    expect(indexed.entries, JSON.stringify(scope)).toEqual(scanned.entries);
    return indexed;
  }

  it("returns what the full scan returns for the large objects", async () => {
    // The scan takes seconds per page here (it is the reference, not the code under test).
    await expectSameListing(newestMail("mail", { foldersOnly: true }));
    await expectSameListing(newestMail("mail/Inbox"), { limit: 200, offset: 0 });
    await expectSameListing(newestMail("mail/Inbox", { sort: "name" }), {
      limit: 200,
      offset: 9_000,
    });
    await expectSameListing(newestMail("mail/Inbox", { includeDeleted: false }), {
      limit: 100,
      offset: 50,
    });
    await expectSameListing(newestMail("mail/Inbox/Sub 1"));
    await expectSameListing(
      scopeOf(f.mailbox, f.mailboxSnapshots[4] as string, 5, "mail/Inbox", {
        includeDeleted: false,
      }),
      { limit: 300, offset: 0 },
    );
    await expectSameListing(newestDrive(f.deepFolder));
    await expectSameListing(newestDrive(f.deepFolder.split("/").slice(0, 2).join("/")));
    // A page past the end still reports the total.
    const past = await expectSameListing(newestMail("mail", { foldersOnly: true }), {
      limit: 10,
      offset: 500,
    });
    expect(past.entries).toEqual([]);
    expect(past.total).toBe(20);
  }, 300_000);

  it("returns what the full scan returns where the skip scan has edge cases", async () => {
    const paths = [
      "",
      "A",
      "A.b",
      "A b",
      "A-c",
      "Docs",
      "Mailish",
      "Attachments only",
      "Gone",
      "Ünïcode",
      "Missing",
    ];
    for (const snapshot of [
      { id: edge.first, sequence: 1 },
      { id: edge.second, sequence: 2 },
    ]) {
      for (const path of paths) {
        for (const includeDeleted of [true, false]) {
          for (const foldersOnly of [true, false]) {
            for (const hideNativeVersions of [true, false]) {
              await expectSameListing(
                scopeOf(edge.objectId, snapshot.id, snapshot.sequence, path, {
                  includeDeleted,
                  foldersOnly,
                  hideNativeVersions,
                  sort: "name",
                }),
              );
            }
          }
        }
      }
    }
    const root = await queryListing(
      db,
      scopeOf(edge.objectId, edge.second, 2, "", {
        includeDeleted: true,
        foldersOnly: true,
        hideNativeVersions: true,
        sort: "name",
      }),
      { limit: 100, offset: 0 },
    );
    // Sorted here: the database's collation decides how the names compare.
    const folders = root.entries
      .map((entry) => [entry.name, entry.implicit, entry.deleted])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
    expect(folders).toEqual([
      ["A", true, false],
      ["A b", true, false],
      ["A-c", false, false],
      ["A.b", true, false],
      ["Docs", false, false],
      ["Gone", true, true],
      ["Mailish", true, false],
      ["Zeta", true, false],
      ["Ünïcode", true, false],
    ]);
  }, 60_000);
});

/**
 * A small object whose paths sit where a skip scan over byte-ordered parent
 * paths can go wrong: siblings whose names continue with a character sorting
 * before `/` (`A`, `A b`, `A-c`, `A.b`), folders known only through deeper
 * rows, OneDrive's own versions and attachments of JSON-format messages (with
 * their attachments folder) below a folder (neither makes a folder appear), a folder whose only entry was
 * deleted in the second restore point, and names beyond ASCII.
 */
async function createEdgeObject(
  db: Database,
  tenantId: string,
): Promise<{ objectId: string; first: string; second: string }> {
  const [source] = await db.select().from(sources).where(eq(sources.tenantId, tenantId)).limit(1);
  const [object] = await db
    .insert(protectedObjects)
    .values({
      tenantId,
      sourceId: (source as { id: string }).id,
      kind: "onedrive",
      externalId: "b!edge",
      displayName: "Edge",
    })
    .returning();
  const objectId = (object as { id: string }).id;
  const snapshot = async (sequence: number) => {
    const at = new Date(Date.UTC(2026, 1, sequence));
    const [row] = await db
      .insert(snapshots)
      .values({
        tenantId,
        protectedObjectId: objectId,
        sequence,
        startedAt: at,
        completedAt: at,
        manifestPath: `tenants/${tenantId}/manifests/edge-${sequence}`,
        itemCount: 1,
        byteSize: 1,
      })
      .returning();
    return (row as { id: string }).id;
  };
  const first = await snapshot(1);
  const second = await snapshot(2);
  const rows = (snapshotId: string, sequence: number): ManifestFixtureRow[] => {
    const at = (path: string, kind: ManifestFixtureRow["kind"], extra = {}) => ({
      tenantId,
      snapshotId,
      protectedObjectId: objectId,
      path,
      kind,
      size: kind === "folder" ? 0 : 10,
      mtime: new Date(Date.UTC(2025, 5, 1 + path.length)),
      ...extra,
    });
    return [
      at("A/x.txt", "file"),
      at("A/sub/deep.txt", "file"),
      at("A.b/y.txt", "file"),
      at("A b/z/w.txt", "file"),
      at("A-c", "folder"),
      at("A-c/f.txt", "file"),
      at("Docs", "folder"),
      at("Docs/r.docx", "file"),
      at("Docs/r.docx:versions/1.0", "file"),
      at("Only versions/q.docx:versions/1.0", "file"),
      at("Mailish/m.json", "mail", { metadata: { subject: "Big", format: "json" } }),
      at("Mailish/m.attachments", "folder", { metadata: { folderKind: "attachments" } }),
      at("Mailish/m.attachments/a.pdf", "file", {
        metadata: { messagePath: "Mailish/m.json" },
      }),
      at("Attachments only/m.attachments", "folder", { metadata: { folderKind: "attachments" } }),
      at("Attachments only/m.attachments/b.pdf", "file", {
        metadata: { messagePath: "Attachments only/m.json" },
      }),
      at("Gone/old.txt", "file", { deleted: sequence === 2 }),
      at("Ünïcode/ä.txt", "file"),
      at("Zeta/ü/x.txt", "file"),
      at("top.txt", "file"),
    ];
  };
  await insertManifestRows(db, [...rows(first, 1), ...rows(second, 2)]);
  return { objectId, first, second };
}
