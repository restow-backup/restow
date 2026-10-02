/**
 * Postgres-backed test of the audit target names: the import, the upload, the
 * protected object (named by its kind) and the machine an entry points at show
 * what they are called today, instead of the id the chain stores.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_audit_labels_test` is recreated there and dropped after).
 * Without it the suite is skipped; docs/TESTING.md lists it under integration.
 */
import { randomUUID } from "node:crypto";
import {
  type Database,
  backupJobs,
  createDb,
  endpoints,
  importUploads,
  mailImports,
  protectedObjects,
  providers,
  sources,
  tenants,
} from "@restow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../../../apps/api/src/features/snapshots/testing/explorer-fixture.js";
import { resolveTargetLabels, targetLabelOf } from "./labels.js";

const DATABASE = "restow_api_audit_labels_test";

describe.skipIf(!testDatabaseAdminUrl)("audit target names against Postgres", () => {
  let db: Database;
  let tenantId: string;
  let importId: string;
  let uploadId: string;
  let objectId: string;
  let machineId: string;
  let unnamedMachineId: string;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    db = createDb(url);
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "Contoso",
        slug: `contoso-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    tenantId = tenant?.id as string;
    const [source] = await db
      .insert(sources)
      .values({
        tenantId,
        kind: "import",
        name: "Imported mail files",
        status: "active",
        config: {},
      })
      .returning();
    const [object] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source?.id as string,
        kind: "imap",
        origin: "manual",
        externalId: "anna-import",
        displayName: "Anna Example",
      })
      .returning();
    objectId = object?.id as string;
    const [imported] = await db
      .insert(mailImports)
      .values({
        tenantId,
        sourceId: source?.id as string,
        protectedObjectId: objectId,
        name: "Anna Example",
        files: [],
        options: { archive: false },
      })
      .returning();
    importId = imported?.id as string;
    const [upload] = await db
      .insert(importUploads)
      .values({
        tenantId,
        fileName: "anna-2019.mbox",
        size: 1024,
        segmentSize: 65_536,
        segmentCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    uploadId = upload?.id as string;
    const machine = (hostname: string, displayName: string | null) => ({
      tenantId,
      hostname,
      displayName,
      os: "linux" as const,
      arch: "amd64" as const,
      profile: "server" as const,
      secretHash: "0".repeat(64),
      config: {} as never,
    });
    const created = await db
      .insert(endpoints)
      .values([machine("web-01", "Web front"), machine("db-02", null)])
      .returning();
    machineId = created.find((row) => row.hostname === "web-01")?.id as string;
    unnamedMachineId = created.find((row) => row.hostname === "db-02")?.id as string;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("names an import after its mailbox and an upload after its file", async () => {
    const entries = [
      { target: importId, targetType: "mail_import" },
      { target: uploadId, targetType: "import_upload" },
    ];
    const labels = await resolveTargetLabels(db, entries);
    expect(targetLabelOf(entries[0] as never, labels)).toBe("Anna Example");
    expect(targetLabelOf(entries[1] as never, labels)).toBe("anna-2019.mbox");
  });

  it("names a protected object under its kind, the way protection changes record it", async () => {
    const entries = ["mailbox", "onedrive", "imap", "protected_object"].map((targetType) => ({
      target: objectId,
      targetType,
    }));
    const labels = await resolveTargetLabels(db, entries);
    for (const entry of entries) {
      expect(targetLabelOf(entry, labels), entry.targetType).toBe("Anna Example");
    }
  });

  it("names a machine by its label, else its host name", async () => {
    const entries = [
      { target: machineId, targetType: "endpoint" },
      { target: unnamedMachineId, targetType: "endpoint" },
    ];
    const labels = await resolveTargetLabels(db, entries);
    expect(targetLabelOf(entries[0] as never, labels)).toBe("Web front");
    expect(targetLabelOf(entries[1] as never, labels)).toBe("db-02");
  });

  it("names a backup job after itself, and after the name its entry recorded once it is gone", async () => {
    const [job] = await db
      .insert(backupJobs)
      .values({ tenantId, kind: "mail", name: "Mail backup" })
      .returning();
    const gone = randomUUID();
    const entries = [
      { target: job?.id as string, targetType: "backup_job" },
      { target: gone, targetType: "backup_job", details: { name: "Deleted job" } },
      { target: randomUUID(), targetType: "backup_job" },
    ];
    const labels = await resolveTargetLabels(db, entries);
    expect(targetLabelOf(entries[0] as never, labels)).toBe("Mail backup");
    expect(targetLabelOf(entries[1] as never, labels)).toBe("Deleted job");
    expect(targetLabelOf(entries[2] as never, labels)).toBeNull();
  });

  it("keeps the recorded name for an import that no longer exists, and no label for an unknown id", async () => {
    const gone = randomUUID();
    const entries = [
      { target: gone, targetType: "mail_import", details: { name: "Bob Example" } },
      { target: randomUUID(), targetType: "import_upload" },
    ];
    const labels = await resolveTargetLabels(db, entries);
    expect(targetLabelOf(entries[0] as never, labels)).toBe("Bob Example");
    expect(targetLabelOf(entries[1] as never, labels)).toBeNull();
  });
});
