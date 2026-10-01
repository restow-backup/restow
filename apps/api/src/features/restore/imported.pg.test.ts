/**
 * Postgres-backed tests of how restore treats imported mailboxes (docs/IMPORT.md):
 * protected objects of kind imap under a source of kind import. They have no
 * original account, they are restored into an M365 mailbox or an IMAP account of
 * another source (the API records which in `options.targetKind` for the worker),
 * and nothing can ever be restored into them.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_restore_imported_test` is recreated there and dropped after).
 * Without it the suite is skipped.
 */
import { randomUUID } from "node:crypto";
import {
  type Database,
  auditLog,
  createDb,
  manifestObjects,
  protectedObjects,
  restoreJobs,
  snapshots,
  sources,
} from "@restow/db";
import { eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExplorerFixture,
  createExplorerFixture,
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { createRestoreSchema } from "./schemas.js";

const DATABASE = "restow_api_restore_imported_test";

type Service = typeof import("./service.js");

const request = (input: Record<string, unknown>) => createRestoreSchema.parse(input);

describe.skipIf(!testDatabaseAdminUrl)("restoring imported mailboxes against Postgres", () => {
  let db: Database;
  let f: ExplorerFixture;
  let service: Service;
  let importSourceId: string;
  let importObject: string;
  let importExternalId: string;
  let importSnapshot: string;
  let otherImportObject: string;
  let dualMailbox: string;
  let dualImap: string;

  const actor = (viewer: ExplorerFixture["admin"]) => ({ ...viewer, ip: "192.0.2.10" });

  const restoreImported = (target: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    service.createRestore(
      db,
      f.tenantId,
      actor(f.admin),
      request({
        snapshotId: importSnapshot,
        selection: [{ path: "mail/Imported" }],
        target,
        reason: "Moving the archive of the former partner",
        ...extra,
      }),
    );

  async function storedSelection(restoreId: string): Promise<Record<string, unknown>> {
    const [row] = await db.select().from(restoreJobs).where(eq(restoreJobs.id, restoreId));
    return (row?.sourceSelection ?? {}) as Record<string, unknown>;
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    process.env.DATABASE_URL = url;
    process.env.DATABASE_PROVIDER_URL = url;
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("restore");
    await boss.stop({ graceful: false, wait: true });

    db = createDb(url);
    f = await createExplorerFixture(db);

    const [importSource] = await db
      .insert(sources)
      .values({
        tenantId: f.tenantId,
        kind: "import",
        name: "Imported mail files",
        status: "active",
      })
      .returning();
    importSourceId = importSource?.id as string;

    async function importedMailbox(name: string): Promise<{ id: string; externalId: string }> {
      const [created] = await db
        .insert(protectedObjects)
        .values({
          tenantId: f.tenantId,
          sourceId: importSourceId,
          kind: "imap",
          origin: "manual",
          externalId: `import-${randomUUID()}`,
          displayName: name,
        })
        .returning();
      return { id: created?.id as string, externalId: created?.externalId as string };
    }
    const imported = await importedMailbox("Partner archive 2019");
    importObject = imported.id;
    importExternalId = imported.externalId;
    otherImportObject = (await importedMailbox("Second import")).id;

    const [snapshot] = await db
      .insert(snapshots)
      .values({
        tenantId: f.tenantId,
        protectedObjectId: importObject,
        sequence: 1,
        startedAt: new Date("2026-03-01T08:00:00Z"),
        completedAt: new Date("2026-03-01T08:00:00Z"),
        manifestPath: `tenants/${f.tenantId}/manifests/${randomUUID()}`,
        itemCount: 2,
        byteSize: 200,
      })
      .returning();
    importSnapshot = snapshot?.id as string;
    const base = {
      tenantId: f.tenantId,
      snapshotId: importSnapshot,
      protectedObjectId: importObject,
    };
    await db.insert(manifestObjects).values([
      {
        ...base,
        kind: "folder",
        path: "mail/Imported",
        name: "Imported",
        parentPath: "mail",
        size: 0,
      },
      {
        ...base,
        kind: "mail",
        path: "mail/Imported/1.eml",
        name: "1.eml",
        parentPath: "mail/Imported",
        size: 100,
        chunkRefs: ["chunk-1"],
        itemId: "imported-1",
      },
    ]);

    // An address that is an M365 mailbox and an IMAP account at once.
    const [m365] = await db.select().from(sources).where(eq(sources.kind, "m365"));
    const [imap] = await db.select().from(sources).where(eq(sources.kind, "imap"));
    const [mailbox] = await db
      .insert(protectedObjects)
      .values({
        tenantId: f.tenantId,
        sourceId: m365?.id as string,
        kind: "mailbox",
        externalId: "dual@contoso.test",
        displayName: "Dual",
      })
      .returning();
    dualMailbox = mailbox?.id as string;
    const [account] = await db
      .insert(protectedObjects)
      .values({
        tenantId: f.tenantId,
        sourceId: imap?.id as string,
        kind: "imap",
        externalId: "dual@contoso.test",
        displayName: "Dual (IMAP)",
      })
      .returning();
    dualImap = account?.id as string;

    service = await import("./service.js");
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("refuses the original target: an imported mailbox has no original", async () => {
    const before = await db.select().from(restoreJobs);
    await expect(restoreImported({ type: "original" })).rejects.toMatchObject({
      status: 422,
      type: "urn:restow:problem:restore-original-not-available",
    });
    expect(await db.select().from(restoreJobs)).toHaveLength(before.length);
  });

  it("still restores an ordinary mailbox back into its original", async () => {
    const created = await service.createRestore(
      db,
      f.tenantId,
      actor(f.anna),
      request({
        snapshotId: f.mailbox.second,
        selection: [{ path: "mail/Inbox" }],
        target: { type: "original" },
      }),
    );
    expect(created.status).toBe("queued");
    expect(await storedSelection(created.id)).not.toHaveProperty("options");
  });

  it("restores an imported mailbox as a download without a target kind", async () => {
    const created = await restoreImported({ type: "download" });
    expect(created.impersonated).toBe(true);
    expect(await storedSelection(created.id)).toEqual({ folderPaths: ["mail/Imported"] });
  });

  it("records mailbox as the target kind for an M365 mailbox, whatever the case of the address", async () => {
    const created = await restoreImported(
      { type: "other", accountId: "BOB@contoso.test" },
      { options: { restoreFolderName: "Partner mail" } },
    );
    expect(await storedSelection(created.id)).toMatchObject({
      folderPaths: ["mail/Imported"],
      options: { restoreFolderName: "Partner mail", targetKind: "mailbox" },
    });
    const [job] = await db.select().from(restoreJobs).where(eq(restoreJobs.id, created.id));
    expect(job).toMatchObject({ targetType: "other", targetRef: "BOB@contoso.test" });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.target, created.id));
    expect(entry?.details).toMatchObject({ target: "other", targetRef: "BOB@contoso.test" });
  });

  it("finds an M365 mailbox by its directory user's e-mail too", async () => {
    // Anna's mailbox is linked to a directory user; a UPN that differs from the external id still matches it.
    await db
      .update(protectedObjects)
      .set({ externalId: "anna-object-id" })
      .where(eq(protectedObjects.id, f.annaMailbox));
    const created = await restoreImported({ type: "other", accountId: "anna@contoso.test" });
    expect(await storedSelection(created.id)).toMatchObject({ options: { targetKind: "mailbox" } });
    await db
      .update(protectedObjects)
      .set({ externalId: "anna@contoso.test" })
      .where(eq(protectedObjects.id, f.annaMailbox));
  });

  it("records imap as the target kind for an IMAP account of another source", async () => {
    const created = await restoreImported({ type: "other", accountId: "INFO@contoso.test" });
    expect(await storedSelection(created.id)).toMatchObject({ options: { targetKind: "imap" } });
  });

  it("prefers the Exchange mailbox when an address is both", async () => {
    const created = await restoreImported({ type: "other", accountId: "dual@contoso.test" });
    expect(await storedSelection(created.id)).toMatchObject({ options: { targetKind: "mailbox" } });
  });

  it("does not let the client choose the target kind", async () => {
    const created = await restoreImported(
      { type: "other", accountId: "bob@contoso.test" },
      { options: { targetKind: "imap" } },
    );
    expect(await storedSelection(created.id)).toMatchObject({ options: { targetKind: "mailbox" } });
  });

  it("refuses accounts it does not know", async () => {
    await expect(
      restoreImported({ type: "other", accountId: "stranger@example.test" }),
    ).rejects.toMatchObject({
      status: 422,
      type: "urn:restow:problem:restore-target-unknown",
      extensions: { accountId: "stranger@example.test" },
    });
  });

  it("never accepts an imported mailbox as the target, for imported and ordinary objects alike", async () => {
    await expect(
      restoreImported({ type: "other", accountId: importExternalId }),
    ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:restore-target-unknown" });
    await expect(
      service.createRestore(
        db,
        f.tenantId,
        actor(f.admin),
        request({
          snapshotId: f.imap,
          selection: [{ path: "mail/INBOX" }],
          target: { type: "other", accountId: importExternalId },
          reason: "Trying to write into an import",
        }),
      ),
    ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:restore-target-unknown" });
  });

  it("refuses an M365 mailbox that no longer exists in the source", async () => {
    await db
      .update(protectedObjects)
      .set({ status: "orphaned" })
      .where(eq(protectedObjects.id, f.bobMailbox));
    await expect(
      restoreImported({ type: "other", accountId: "bob@contoso.test" }),
    ).rejects.toMatchObject({
      status: 422,
      type: "urn:restow:problem:restore-target-unknown",
    });
    await db
      .update(protectedObjects)
      .set({ status: "active" })
      .where(eq(protectedObjects.id, f.bobMailbox));
  });

  it("keeps an imported mailbox away from end users, restore included", async () => {
    await expect(
      service.createRestore(
        db,
        f.tenantId,
        actor(f.anna),
        request({
          snapshotId: importSnapshot,
          selection: [{ path: "mail/Imported" }],
          target: { type: "other", accountId: "bob@contoso.test" },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  describe("target suggestions", () => {
    it("lists active M365 mailboxes and IMAP accounts of other sources for an imported mailbox", async () => {
      const targets = await service.listTargets(db, f.tenantId, f.admin, importObject);
      expect(targets.map((target) => `${target.kind}:${target.externalId}`).sort()).toEqual([
        "imap:dual@contoso.test",
        "imap:info@contoso.test",
        "mailbox:anna@contoso.test",
        "mailbox:bob@contoso.test",
        "mailbox:dual@contoso.test",
      ]);
      const ids = targets.map((target) => target.id);
      expect(ids).not.toContain(importObject);
      expect(ids).not.toContain(otherImportObject);
      expect(ids).toContain(dualMailbox);
      expect(ids).toContain(dualImap);
    });

    it("leaves out mailboxes that are not active", async () => {
      await db
        .update(protectedObjects)
        .set({ status: "excluded" })
        .where(eq(protectedObjects.id, f.bobMailbox));
      const targets = await service.listTargets(db, f.tenantId, f.admin, importObject);
      expect(targets.map((target) => target.externalId)).not.toContain("bob@contoso.test");
      await db
        .update(protectedObjects)
        .set({ status: "active" })
        .where(eq(protectedObjects.id, f.bobMailbox));
    });

    it("never offers an imported mailbox as a target for an IMAP account", async () => {
      const targets = await service.listTargets(db, f.tenantId, f.admin, f.imapAccount);
      expect(targets.map((target) => target.id)).toEqual([dualImap]);
    });

    it("keeps offering same-source mailboxes for an M365 mailbox", async () => {
      const targets = await service.listTargets(db, f.tenantId, f.admin, f.annaMailbox);
      expect(targets.map((target) => target.externalId).sort()).toEqual([
        "bob@contoso.test",
        "dual@contoso.test",
      ]);
    });
  });
});
