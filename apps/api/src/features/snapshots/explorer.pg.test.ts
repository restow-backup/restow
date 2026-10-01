/**
 * Postgres-backed tests of the explorer queries: the folder listing with
 * implicit folders, paging and filters, version history across snapshots,
 * OneDrive's own versions, search, end-user scoping, and the audit entry every
 * read of backup contents writes.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_explorer_test` is recreated there and dropped after).
 * Without it the suite is skipped; docs/TESTING.md lists it under integration.
 */
import { type Database, auditLog, createDb, manifestObjects } from "@restow/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import type { Viewer } from "./access.js";
import { treeQuerySchema, versionsQuerySchema } from "./schemas.js";
import {
  SNAPSHOT_AUDIT_ACTIONS,
  type SnapshotReader,
  listObjects,
  listSnapshots,
  listTree,
  listVersions,
  search,
} from "./service.js";
import {
  type ExplorerFixture,
  createExplorerFixture,
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "./testing/explorer-fixture.js";

const DATABASE = "restow_api_explorer_test";

const tree = (query: Record<string, string> = {}) => treeQuerySchema.parse(query);
const versions = (query: Record<string, string>) => versionsQuerySchema.parse(query);

/** Reads come from a documentation address (RFC 5737), which the audit entries carry. */
const CLIENT_IP = "198.51.100.7";
const reader = (viewer: Viewer): SnapshotReader => ({ ...viewer, ip: CLIENT_IP });

describe.skipIf(!testDatabaseAdminUrl)("explorer queries against Postgres", () => {
  let db: Database;
  let f: ExplorerFixture;

  beforeAll(async () => {
    db = createDb(await recreateDatabase(testDatabaseAdminUrl as string, DATABASE));
    f = await createExplorerFixture(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  describe("listTree", () => {
    it("shows area roots that have no row of their own as implicit folders", async () => {
      const root = await listTree(db, f.tenantId, reader(f.admin), f.mailbox.second, tree());
      expect(root.entries.map((e) => [e.name, e.kind, e.implicit])).toEqual([
        ["calendar", "folder", true],
        ["mail", "folder", true],
      ]);
      expect(root.entries[0]?.id).toBe("folder:calendar");
      expect(root.breadcrumb).toEqual([]);
      expect(root.object).toMatchObject({ id: f.annaMailbox, kind: "mailbox", own: false });

      const calendar = await listTree(
        db,
        f.tenantId,
        reader(f.admin),
        f.mailbox.second,
        tree({ path: "calendar" }),
      );
      expect(calendar.entries.map((e) => [e.path, e.implicit])).toEqual([
        ["calendar/Calendar", true],
      ]);
    });

    it("lists folders first, mails newest first, and never the attachment namespace", async () => {
      const inbox = await listTree(
        db,
        f.tenantId,
        reader(f.admin),
        f.mailbox.first,
        tree({ path: "/mail/Inbox/" }),
      );
      expect(inbox.folder).toEqual({ path: "mail/Inbox", name: "Inbox" });
      expect(inbox.breadcrumb.map((segment) => segment.path)).toEqual(["mail", "mail/Inbox"]);
      expect(inbox.entries.map((e) => e.name)).toEqual([
        "Projects",
        "Lunch.bbbb.eml",
        "Quarterly.aaaa.eml",
        "Big.cccc.json",
      ]);
      expect(inbox.entries[1]?.mail?.subject).toBe("Lunch on Friday");
      expect(inbox.total).toBe(4);
      expect(inbox.hasMore).toBe(false);
    });

    it("sorts dated mail by its own recorded date, not by mtime, when the two disagree", async () => {
      // mtime (manifest_objects.mtime) is Exchange's lastModifiedDateTime, which a
      // read-flag or category change bumps independently of when the mail arrived
      // (packages/core/src/backup/exchange/mail.ts); the default sort must follow
      // the mail's own receivedDateTime instead. Uses the IMAP fixture (unused by
      // any other test in this file) so it cannot disturb another test's counts.
      await db.insert(manifestObjects).values([
        {
          tenantId: f.tenantId,
          snapshotId: f.imap,
          protectedObjectId: f.imapAccount,
          kind: "mail",
          path: "mail/INBOX/StaleFlag.hhhh.eml",
          name: "StaleFlag.hhhh.eml",
          parentPath: "mail/INBOX",
          size: 10,
          // A flag was toggled just now (recent mtime), but the mail itself
          // arrived over a year earlier per its own metadata.
          mtime: new Date("2026-01-09T08:00:00.000Z"),
          metadata: { subject: "Stale flag", receivedDateTime: "2024-06-01T08:00:00.000Z" },
        },
        {
          tenantId: f.tenantId,
          snapshotId: f.imap,
          protectedObjectId: f.imapAccount,
          kind: "mail",
          path: "mail/INBOX/FreshMailOldMtime.iiii.eml",
          name: "FreshMailOldMtime.iiii.eml",
          parentPath: "mail/INBOX",
          size: 10,
          mtime: new Date("2020-01-01T08:00:00.000Z"),
          metadata: {
            subject: "Fresh mail, old mtime",
            receivedDateTime: "2026-01-09T08:00:00.000Z",
          },
        },
      ]);

      const inbox = await listTree(
        db,
        f.tenantId,
        reader(f.admin),
        f.imap,
        tree({ path: "mail/INBOX" }),
      );
      // "1.eml" (the fixture's own entry) carries no date at all, so it falls
      // into the undated / natural-name group after both dated messages.
      expect(inbox.entries.map((e) => e.name)).toEqual([
        "FreshMailOldMtime.iiii.eml",
        "StaleFlag.hhhh.eml",
        "1.eml",
      ]);
    });

    it("ranks internalDate ahead of a spoofable sentDateTime, and tolerates an out-of-range date instead of erroring the query", async () => {
      // sentDateTime is the IMAP envelope's Date: header, which the sender
      // controls; internalDate is the mailbox's own arrival time (IMAP's
      // counterpart of Exchange's receivedDateTime) and must win the sort, or
      // a forged future Date: header could pin a message to the top forever.
      await db.insert(manifestObjects).values([
        {
          tenantId: f.tenantId,
          snapshotId: f.imap,
          protectedObjectId: f.imapAccount,
          kind: "mail",
          path: "mail/INBOX/SpoofedFutureDate.jjjj.eml",
          name: "SpoofedFutureDate.jjjj.eml",
          parentPath: "mail/INBOX",
          size: 10,
          mtime: new Date("2026-01-01T08:00:00.000Z"),
          metadata: {
            subject: "Spoofed future Date header",
            sentDateTime: "2099-01-01T00:00:00.000Z",
            internalDate: "2026-01-02T08:00:00.000Z",
          },
        },
        {
          tenantId: f.tenantId,
          snapshotId: f.imap,
          protectedObjectId: f.imapAccount,
          kind: "mail",
          path: "mail/INBOX/OrdinaryArrival.kkkk.eml",
          name: "OrdinaryArrival.kkkk.eml",
          parentPath: "mail/INBOX",
          size: 10,
          mtime: new Date("2026-01-03T08:00:00.000Z"),
          metadata: { subject: "Ordinary arrival", internalDate: "2026-01-03T08:00:00.000Z" },
        },
        {
          tenantId: f.tenantId,
          snapshotId: f.imap,
          protectedObjectId: f.imapAccount,
          kind: "mail",
          path: "mail/INBOX/OutOfRangeDate.llll.eml",
          name: "OutOfRangeDate.llll.eml",
          parentPath: "mail/INBOX",
          size: 10,
          mtime: new Date("2026-01-04T08:00:00.000Z"),
          // Structurally ISO-8601 (matches the regex) but not a real
          // calendar date: a plain `::timestamptz` cast raises here, so this
          // proves the query falls through to mtime instead of erroring.
          metadata: { subject: "Out of range date", internalDate: "2026-02-30T10:00:00" },
        },
      ]);

      const inbox = await listTree(
        db,
        f.tenantId,
        reader(f.admin),
        f.imap,
        tree({ path: "mail/INBOX" }),
      );
      const names = inbox.entries.map((e) => e.name);
      // Newest first: the out-of-range row (falls back to its 01-04 mtime),
      // then the ordinary 01-03 arrival, then the spoofed message — whose
      // real arrival (internalDate 01-02) is the oldest of the three, so the
      // forged 2099 sentDateTime never gets to move it up.
      expect(names.indexOf("OutOfRangeDate.llll.eml")).toBeLessThan(
        names.indexOf("OrdinaryArrival.kkkk.eml"),
      );
      expect(names.indexOf("OrdinaryArrival.kkkk.eml")).toBeLessThan(
        names.indexOf("SpoofedFutureDate.jjjj.eml"),
      );
    });

    it("pages through a folder with a stable order", async () => {
      const page = await listTree(
        db,
        f.tenantId,
        reader(f.admin),
        f.mailbox.first,
        tree({ path: "mail/Inbox", limit: "2", offset: "1" }),
      );
      expect(page.entries.map((e) => e.name)).toEqual(["Lunch.bbbb.eml", "Quarterly.aaaa.eml"]);
      expect(page).toMatchObject({ total: 4, offset: 1, hasMore: true });
    });

    it("keeps deleted items visible unless asked otherwise, and lists only folders on request", async () => {
      const withDeleted = await listTree(
        db,
        f.tenantId,
        reader(f.admin),
        f.mailbox.second,
        tree({ path: "mail/Inbox" }),
      );
      expect(withDeleted.entries.find((e) => e.name === "Lunch.bbbb.eml")?.deleted).toBe(true);

      const withoutDeleted = await listTree(
        db,
        f.tenantId,
        reader(f.admin),
        f.mailbox.second,
        tree({ path: "mail/Inbox", includeDeleted: "false" }),
      );
      expect(withoutDeleted.entries.map((e) => e.name)).not.toContain("Lunch.bbbb.eml");

      const folders = await listTree(
        db,
        f.tenantId,
        reader(f.admin),
        f.mailbox.second,
        tree({ path: "mail/Inbox", foldersOnly: "true" }),
      );
      expect(folders.entries.map((e) => e.name)).toEqual(["Projects"]);
    });

    it("hides OneDrive's version namespace from the folder", async () => {
      const documents = await listTree(
        db,
        f.tenantId,
        reader(f.anna),
        f.drive,
        tree({ path: "Documents" }),
      );
      expect(documents.entries.map((e) => e.name)).toEqual(["report.docx"]);
      expect(documents.object.own).toBe(true);
    });

    it("refuses unfinished snapshots and other people's snapshots with a 404", async () => {
      await expect(
        listTree(db, f.tenantId, reader(f.admin), f.mailbox.running, tree()),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        listTree(db, f.tenantId, reader(f.bob), f.mailbox.first, tree()),
      ).rejects.toBeInstanceOf(ProblemError);
    });
  });

  describe("listVersions", () => {
    it("collapses unchanged content and separates changed content", async () => {
      const unchanged = await listVersions(
        db,
        f.tenantId,
        reader(f.admin),
        f.annaMailbox,
        versions({ path: "mail/Inbox/Quarterly.aaaa.eml" }),
      );
      expect(unchanged.versions).toHaveLength(1);
      expect(unchanged.versions[0]).toMatchObject({
        sequence: 2,
        firstSeenSequence: 1,
        snapshotCount: 2,
        snapshotId: f.mailbox.second,
      });
      expect(unchanged.stored).toEqual([]);

      const changed = await listVersions(
        db,
        f.tenantId,
        reader(f.admin),
        f.annaMailbox,
        versions({ path: "mail/Inbox/Projects/Kickoff.eeee.eml" }),
      );
      expect(changed.versions.map((v) => v.sequence)).toEqual([2, 1]);
    });

    it("shows a deletion as its own version", async () => {
      const lunch = await listVersions(
        db,
        f.tenantId,
        reader(f.admin),
        f.annaMailbox,
        versions({ path: "mail/Inbox/Lunch.bbbb.eml" }),
      );
      expect(lunch.versions.map((v) => [v.sequence, v.deleted])).toEqual([
        [2, true],
        [1, false],
      ]);
    });

    it("lists the versions OneDrive kept, newest first, when a snapshot is named", async () => {
      const report = await listVersions(
        db,
        f.tenantId,
        reader(f.anna),
        f.annaDrive,
        versions({ path: "Documents/report.docx", snapshotId: f.drive }),
      );
      expect(report.versions).toHaveLength(1);
      expect(report.stored.map((v) => [v.versionId, v.modifiedBy])).toEqual([
        ["2.0", "Bob"],
        ["1.0", "Anna"],
      ]);
      expect(report.stored[0]?.path).toBe("Documents/report.docx:versions/2.0");
    });

    it("never shows another person's history to an end user", async () => {
      await expect(
        listVersions(
          db,
          f.tenantId,
          reader(f.bob),
          f.annaMailbox,
          versions({ path: "mail/Inbox/Quarterly.aaaa.eml" }),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("search", () => {
    it("finds by subject in the latest snapshots of what the viewer may see", async () => {
      const forAdmin = await search(db, f.tenantId, reader(f.admin), {
        q: "quarterly",
        limit: 100,
      });
      expect(forAdmin.hits.map((hit) => hit.name).sort()).toEqual([
        "Quarterly.aaaa.eml",
        "Salary.gggg.eml",
      ]);
      expect(forAdmin.hits.find((hit) => hit.name === "Quarterly.aaaa.eml")?.snapshotId).toBe(
        f.mailbox.second,
      );

      const forAnna = await search(db, f.tenantId, reader(f.anna), { q: "quarterly", limit: 100 });
      expect(forAnna.hits.map((hit) => hit.name)).toEqual(["Quarterly.aaaa.eml"]);
    });

    it("skips attachments and OneDrive versions and reports truncation", async () => {
      const pdf = await search(db, f.tenantId, reader(f.admin), { q: "plan.pdf", limit: 100 });
      expect(pdf.hits).toEqual([]);
      const report = await search(db, f.tenantId, reader(f.admin), {
        q: "report",
        snapshotId: f.drive,
        limit: 100,
      });
      expect(report.hits.map((hit) => hit.path)).toEqual(["Documents/report.docx"]);
      const inbox = await search(db, f.tenantId, reader(f.admin), {
        q: "mail/Inbox/",
        objectId: f.annaMailbox,
        limit: 2,
      });
      expect(inbox.hits).toHaveLength(2);
      expect(inbox.truncated).toBe(true);
    });

    it("matches wildcards literally", async () => {
      const none = await search(db, f.tenantId, reader(f.admin), { q: "%_", limit: 100 });
      expect(none.hits).toEqual([]);
    });

    it("matches the sender and the to/cc recipient addresses, not only the subject", async () => {
      await db.insert(manifestObjects).values({
        tenantId: f.tenantId,
        snapshotId: f.mailbox.second,
        protectedObjectId: f.annaMailbox,
        kind: "mail",
        path: "mail/Inbox/VendorThread.kkkk.eml",
        name: "VendorThread.kkkk.eml",
        parentPath: "mail/Inbox",
        size: 10,
        metadata: {
          subject: "Contract renewal",
          from: "Priya Sharma <priya@vendor.test>",
          to: "Quinn Miller <quinn@contoso.test>",
          cc: "Legal Team <legal-notify@contoso.test>",
        },
      });

      const bySender = await search(db, f.tenantId, reader(f.admin), { q: "priya", limit: 100 });
      expect(bySender.hits.map((hit) => hit.name)).toEqual(["VendorThread.kkkk.eml"]);

      const byTo = await search(db, f.tenantId, reader(f.admin), { q: "quinn", limit: 100 });
      expect(byTo.hits.map((hit) => hit.name)).toEqual(["VendorThread.kkkk.eml"]);

      const byCc = await search(db, f.tenantId, reader(f.admin), { q: "legal-notify", limit: 100 });
      expect(byCc.hits.map((hit) => hit.name)).toEqual(["VendorThread.kkkk.eml"]);

      // The mailbox owner sees her own hit by the same fields; another tenant user does not.
      const ownerBySender = await search(db, f.tenantId, reader(f.anna), {
        q: "priya",
        limit: 100,
      });
      expect(ownerBySender.hits.map((hit) => hit.name)).toEqual(["VendorThread.kkkk.eml"]);
      const otherUserByTo = await search(db, f.tenantId, reader(f.bob), { q: "quinn", limit: 100 });
      expect(otherUserByTo.hits).toEqual([]);
    });
  });

  describe("objects and snapshots", () => {
    it("lists only the viewer's own objects for end users, with completed snapshots", async () => {
      const mine = await listObjects(db, f.tenantId, f.anna);
      expect(mine.map((o) => [o.externalId, o.own, o.snapshotCount])).toEqual([
        ["anna@contoso.test", true, 2],
        ["b!drive-anna", true, 1],
      ]);
      expect(mine[0]?.latestSnapshotId).toBe(f.mailbox.second);
      expect(mine[0]?.latestSnapshotAt).toBe("2026-01-02T08:00:00.000Z");

      const all = await listObjects(db, f.tenantId, f.admin);
      expect(all).toHaveLength(4);
      expect(all.every((o) => !o.own)).toBe(true);
    });

    it("lists points in time newest first and hides running snapshots", async () => {
      const points = await listSnapshots(db, f.tenantId, f.anna, {
        objectId: f.annaMailbox,
        limit: 100,
      });
      expect(points.map((s) => s.sequence)).toEqual([2, 1]);
      await expect(
        listSnapshots(db, f.tenantId, f.bob, { objectId: f.annaMailbox, limit: 100 }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("audit", () => {
    /** One reader's entries of an action on a target, newest first (earlier tests read too). */
    const entriesBy = (viewer: Viewer, action: string, target: string) =>
      db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, f.tenantId),
            eq(auditLog.actorUserId, viewer.userId as string),
            eq(auditLog.action, action),
            eq(auditLog.target, target),
          ),
        )
        .orderBy(desc(auditLog.createdAt));

    const latestBy = async (viewer: Viewer, action: string, target: string) =>
      (await entriesBy(viewer, action, target))[0];

    it("records who opened which folder of whose backup", async () => {
      await listTree(db, f.tenantId, reader(f.admin), f.mailbox.first, tree({ path: "mail" }));
      await listTree(db, f.tenantId, reader(f.anna), f.mailbox.first, tree());

      const byAdmin = await latestBy(f.admin, SNAPSHOT_AUDIT_ACTIONS.treeRead, f.mailbox.first);
      expect(byAdmin).toMatchObject({
        actor: "admin@provider.test",
        targetType: "snapshot",
        onBehalfOf: "anna@contoso.test",
        ip: CLIENT_IP,
      });
      expect(byAdmin?.details).toMatchObject({
        protectedObjectId: f.annaMailbox,
        objectKind: "mailbox",
        externalId: "anna@contoso.test",
        snapshotSequence: 1,
        path: "mail",
      });
      const byAnna = await latestBy(f.anna, SNAPSHOT_AUDIT_ACTIONS.treeRead, f.mailbox.first);
      expect(byAnna).toMatchObject({ actor: "Anna@Contoso.test", onBehalfOf: null });
      expect(byAnna?.details).toMatchObject({ path: "" });
    });

    it("records a version history with the snapshot it was read from", async () => {
      await listVersions(
        db,
        f.tenantId,
        reader(f.admin),
        f.annaDrive,
        versions({ path: "Documents/report.docx", snapshotId: f.drive }),
      );
      const history = await latestBy(f.admin, SNAPSHOT_AUDIT_ACTIONS.versionsRead, f.annaDrive);
      expect(history).toMatchObject({
        targetType: "protected_object",
        onBehalfOf: "anna@contoso.test",
        ip: CLIENT_IP,
      });
      expect(history?.details).toMatchObject({
        path: "Documents/report.docx",
        snapshotId: f.drive,
        objectKind: "onedrive",
      });
    });

    it("records searches with their scope and the objects that matched", async () => {
      const found = await search(db, f.tenantId, reader(f.admin), { q: "salary", limit: 100 });
      const tenantWide = await latestBy(f.admin, SNAPSHOT_AUDIT_ACTIONS.searched, f.tenantId);
      expect(tenantWide).toMatchObject({ targetType: "tenant", onBehalfOf: null, ip: CLIENT_IP });
      expect(tenantWide?.details).toMatchObject({
        query: "salary",
        hits: found.hits.length,
        truncated: false,
        matchedObjectIds: [f.bobMailbox],
      });

      await search(db, f.tenantId, reader(f.admin), {
        q: "nothing-matches",
        objectId: f.bobMailbox,
        limit: 10,
      });
      const oneObject = await latestBy(f.admin, SNAPSHOT_AUDIT_ACTIONS.searched, f.bobMailbox);
      expect(oneObject).toMatchObject({
        targetType: "protected_object",
        onBehalfOf: "bob@contoso.test",
      });
      expect(oneObject?.details).toMatchObject({ hits: 0, matchedObjectIds: [] });
    });

    it("writes nothing for a read that was refused", async () => {
      await expect(listTree(db, f.tenantId, reader(f.bob), f.drive, tree())).rejects.toMatchObject({
        status: 404,
      });
      expect(await entriesBy(f.bob, SNAPSHOT_AUDIT_ACTIONS.treeRead, f.drive)).toEqual([]);
    });
  });
});
