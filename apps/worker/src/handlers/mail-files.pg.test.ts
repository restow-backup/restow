/**
 * Mail file import, archive ingest, export and cleanup against a real Postgres:
 * the worker handlers on the real chunk, snapshot, cursor and progress seams
 * (docs/IMPORT.md, docs/TESTING.md, integration stage).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
 * `restow_mailfiles_test` is dropped and recreated there, then migrated).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  ChunkReader,
  type Dek,
  Keyring,
  LocalStorageBackend,
  type ProtectedObjectRef,
  type StorageTargets,
  archive,
  createMemoryJobContext,
  generateDek,
  loadManifest,
  mailfiles,
  noopLogger,
  wrapDek,
} from "@restow/core";
import {
  type Database,
  archiveItems,
  createDb,
  importUploads,
  itemFailures,
  jobs,
  mailExports,
  mailImports,
  manifestObjects,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenantKeys,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildEml,
  buildMbox,
  buildMsg,
  buildZip,
} from "../../../../packages/core/src/mailfiles/testing/builders.js";
import { ENTRY, buildCfb } from "../../../../packages/core/src/mailfiles/testing/cfb.js";
import { readZip } from "../../../../packages/core/src/restore/testing/zip-reader.js";
import { createExportHandler, pgExportStore } from "./export.js";
import {
  type AnyJobHandler,
  PgChunkIndex,
  TenantCache,
  TenantConcurrencyLimiter,
  type WorkerJobContext,
  type WorkerRuntime,
  runJob,
  tenantRunner,
} from "./framework.js";
import { createImportHandler } from "./import.js";
import { mailFilesCleanupTask } from "./mail-files-cleanup.js";
import { mailboxTargetObject, restoreTargetKindOf } from "./restore.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_mailfiles_test";

async function recreateTestDatabase(base: string): Promise<string> {
  const admin = createDb(base);
  try {
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.$client.end();
  }
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  await runMigrations(url.toString());
  return url.toString();
}

const dek: Dek = generateDek(1);
const kek = Buffer.alloc(32, 0x5a);

function pgBossJob(queue: string, data: unknown) {
  return {
    id: randomUUID(),
    name: queue,
    data,
    expireInSeconds: 3600,
    priority: 0,
    state: "active" as const,
    retryLimit: 3,
    retryCount: 0,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: new Date(),
    startedOn: new Date(),
    singletonKey: null,
    singletonOn: null,
    expireIn: { toPostgres: () => "", toISO: () => "", toISOString: () => "" },
    createdOn: new Date(),
    completedOn: null,
    keepUntil: new Date(),
    deadLetter: "",
    policy: "stately" as const,
    output: {},
  };
}

const message = (
  subject: string,
  id: string,
  extra: Partial<Parameters<typeof buildEml>[0]> = {},
) =>
  buildEml({
    from: "Bob Example <bob@example.test>",
    to: "alice@example.test",
    subject,
    messageId: `<${id}@example.test>`,
    body: `Dear Alice, this is the mail "${subject}".\r\n`,
    ...extra,
  });

/**
 * Each test imports, archives or exports real mail through Postgres and fsynced
 * pack files: well under a second alone, up to 1.7 s in a CI-like full run, but
 * 5 to 11 s (past vitest's 5 s default) when more workspaces test at once on a
 * busy machine.
 */
const SLOW_UNDER_LOAD = { timeout: 30_000 };

describe.skipIf(!adminUrl)("mail file import and export against Postgres", SLOW_UNDER_LOAD, () => {
  let db: Database;
  let root: string;
  let storage: StorageTargets;
  let tenantId: string;
  let sourceId: string;
  let object: ProtectedObjectRef;
  let keys: Keyring;
  let importDir: string;
  let tenantSlug: string;

  beforeAll(async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    db = createDb(url);
    root = await mkdtemp(join(tmpdir(), "restow-mailfiles-"));
    storage = { primary: new LocalStorageBackend(join(root, "primary")), copies: [] };
    importDir = join(root, "import");
    await mkdir(importDir, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    const [provider] = await db.insert(providers).values({ name: "test provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider.id, name: "Tenant", slug: `t-${randomUUID().slice(0, 8)}` })
      .returning();
    await db.insert(tenantKeys).values({
      tenantId: tenant.id,
      keyVersion: 1,
      encryptedDek: wrapDek(kek, dek).toString("base64"),
      kekId: "env:test",
    });
    const [source] = await db
      .insert(sources)
      .values({
        tenantId: tenant.id,
        kind: "import",
        name: "Imported mail files",
        status: "active",
        config: {},
      })
      .returning();
    const [row] = await db
      .insert(protectedObjects)
      .values({
        tenantId: tenant.id,
        sourceId: source.id,
        kind: "imap",
        origin: "manual",
        externalId: `import-${randomUUID()}`,
        displayName: "Legacy mailbox",
      })
      .returning();
    tenantId = tenant.id;
    tenantSlug = tenant.slug;
    sourceId = source.id;
    keys = new Keyring(tenant.id, [dek]);
    object = {
      id: row.id,
      tenantId,
      sourceId,
      kind: "imap",
      externalId: row.externalId,
      displayName: row.displayName,
      userId: null,
    };
  });

  function runtime(): WorkerRuntime {
    return {
      db,
      defaultStorage: storage,
      keyrings: new TenantCache(async () => keys),
      storage: new TenantCache(async () => storage),
      logger: noopLogger,
      tenantLimiter: new TenantConcurrencyLimiter(2),
      shutdownSignal: new AbortController().signal,
      now: () => new Date(),
      cancelPollMs: 50,
      progress: { flushEveryItems: 1, flushIntervalMs: 0 },
    };
  }

  const segments = () => new mailfiles.SegmentStore({ storage: storage.primary, keys });

  /** Stage bytes as an upload the way the API does, with its row. */
  async function stageUpload(
    fileName: string,
    bytes: Buffer,
    importId: string,
  ): Promise<{ id: string; size: number }> {
    const id = randomUUID();
    const segmentSize = mailfiles.MIN_SEGMENT_SIZE;
    const count = Math.max(1, Math.ceil(bytes.length / segmentSize));
    for (let index = 0; index < count; index++) {
      await segments().put(
        { tenantId, kind: "staging", id },
        index,
        bytes.subarray(index * segmentSize, (index + 1) * segmentSize),
      );
    }
    await db.insert(importUploads).values({
      id,
      tenantId,
      fileName,
      size: bytes.length,
      segmentSize,
      segmentCount: count,
      status: "consumed",
      detectedFormat: null,
      importId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return { id, size: bytes.length };
  }

  async function startImport(
    files: {
      upload?: { id: string; size: number; name: string };
      folder?: { path: string; kind: "file" | "directory" };
    }[],
    archiveIt: boolean,
    importId: string,
  ) {
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "import",
      status: "queued",
      protectedObjectId: object.id,
      payload: { jobId, tenantId, importId, protectedObjectId: object.id },
    });
    await db.insert(mailImports).values({
      id: importId,
      tenantId,
      sourceId,
      protectedObjectId: object.id,
      jobId,
      name: "Legacy mailbox",
      files: files.map((file) =>
        file.upload
          ? {
              origin: "upload" as const,
              uploadId: file.upload.id,
              kind: "file" as const,
              path: file.upload.name,
              size: file.upload.size,
              format: null,
            }
          : {
              origin: "folder" as const,
              kind: file.folder?.kind ?? "file",
              path: file.folder?.path ?? "",
              size: 0,
              format: null,
            },
      ),
      options: { archive: archiveIt },
    });
    const handler = createImportHandler({ env: { IMPORT_DIR: importDir } });
    await runJob(
      runtime(),
      handler as AnyJobHandler,
      pgBossJob("import", { jobId, tenantId, importId, protectedObjectId: object.id }),
    );
    return jobId;
  }

  async function reportOf(importId: string): Promise<mailfiles.ImportReport> {
    const [row] = await db.select().from(mailImports).where(eq(mailImports.id, importId));
    return row?.report as unknown as mailfiles.ImportReport;
  }

  it("imports an MBOX upload and a ZIP with an unreadable MSG, lists the failure and cleans up", async () => {
    const importId = randomUUID();
    const mbox = buildMbox([
      message("Invoice 1", "in1"),
      message("Invoice 2", "in2"),
      message("Invoice 1", "in1"), // exact repeat: a duplicate
    ]);
    const good = message("From the zip", "zip1", {
      attachments: [{ filename: "report.txt", content: "attachment body" }],
    });
    const zip = await buildZip([
      { name: "Projects/" },
      { name: "Projects/good.eml", data: good },
      {
        name: "Projects/broken.msg",
        data: Buffer.concat([Buffer.from("D0CF11E0A1B11AE1", "hex"), Buffer.alloc(600, 7)]),
      },
      { name: "Projects/readme.txt", data: "not mail" },
    ]);
    const first = await stageUpload("legacy.mbox", mbox, importId);
    const second = await stageUpload("export.zip", zip, importId);

    const jobId = await startImport(
      [
        { upload: { ...first, name: "legacy.mbox" } },
        { upload: { ...second, name: "export.zip" } },
      ],
      false,
      importId,
    );

    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job?.status).toBe("completed");
    const report = await reportOf(importId);
    expect(report.totals).toMatchObject({ messages: 3, duplicates: 1, failed: 1 });
    expect(report.items.map((item) => [item.code, item.outcome])).toContainEqual([
      "unreadable",
      "failed",
    ]);
    expect(report.items.map((item) => item.code)).toContain("duplicate");
    expect(report.files.map((file) => [file.path, file.format, file.status])).toEqual([
      ["legacy.mbox", "mbox", "imported"],
      ["export.zip", "zip", "partial"],
    ]);
    expect(report.files[0]?.sha256).toBe(createHash("sha256").update(mbox).digest("hex"));

    // The failure is a row the operator sees, with the reason.
    const failures = await db.select().from(itemFailures).where(eq(itemFailures.jobId, jobId));
    expect(failures.map((row) => row.itemRef)).toEqual([expect.stringContaining("broken.msg")]);

    // One snapshot, IMAP layout, mirrored for the explorer.
    const [snapshot] = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.protectedObjectId, object.id));
    expect(snapshot?.manifestPath).not.toBeNull();
    const rows = await db
      .select()
      .from(manifestObjects)
      .where(eq(manifestObjects.snapshotId, snapshot?.id as string));
    const mail = rows.filter((row) => row.kind === "mail");
    expect(mail.map((row) => row.path).sort()).toEqual([
      "mail/Projects/1.eml",
      "mail/legacy/1.eml",
      "mail/legacy/2.eml",
    ]);
    expect(rows.some((row) => row.kind === "folder" && row.path === "mail/Projects")).toBe(true);

    // Hash comparison against the source: every stored message reads back byte for byte.
    const manifest = await loadManifest(storage, snapshot?.manifestPath as string, keys);
    const reader = new ChunkReader({
      storage,
      keys,
      index: new PgChunkIndex(tenantRunner(db, tenantId), tenantId),
    });
    const storedHashes: string[] = [];
    for (const stored of manifest.objects.filter((entry) => entry.type === "message")) {
      const bytes = await reader.readObjectToBuffer(stored);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(stored.sha256);
      storedHashes.push(stored.sha256 as string);
    }
    const sourceMessages = [message("Invoice 1", "in1"), message("Invoice 2", "in2"), good];
    expect(storedHashes.sort()).toEqual(
      sourceMessages.map((raw) => createHash("sha256").update(raw).digest("hex")).sort(),
    );
    expect(mail[0]?.metadata).toMatchObject({ delimiter: "/", uidValidity: "1" });

    // Staging is gone.
    expect((await storage.primary.list(`tenants/${tenantId}/staging/`)).length).toBe(0);
  });

  it("survives a ZIP of hostile MSG files: the items are listed as unreadable and the mail around them is imported", async () => {
    const importId = randomUUID();
    const built = () =>
      buildCfb({
        entries: [
          { name: "__properties_version1.0", data: Buffer.alloc(100, 1) },
          { name: "__substg1.0_0037001F", data: Buffer.alloc(9000, 65) },
        ],
      });
    // A directory chain that points back to itself: msgreader ran the process out of heap on it.
    const looping = built();
    const lastDirectory = looping.layout.directorySectors.at(-1) as number;
    looping.bytes.writeUInt32LE(lastDirectory, looping.layout.fatEntryOffset(lastDirectory));
    // A stream that claims two gigabytes.
    const lying = built();
    const stream = lying.layout.entries.find((entry) => entry.name === "__substg1.0_0037001F");
    lying.bytes.writeUInt32LE(
      0x7fffffff,
      lying.layout.entryOffset(stream?.index as number) + ENTRY.sizeLow,
    );
    const good = message("Around the hostile files", "around1");
    const zip = await buildZip([
      { name: "a-good.eml", data: good },
      { name: "hostile/loop.msg", data: looping.bytes },
      { name: "hostile/size.msg", data: lying.bytes },
      { name: "z-good.eml", data: message("After the hostile files", "around2") },
    ]);
    const upload = await stageUpload("hostile.zip", zip, importId);
    const jobId = await startImport(
      [{ upload: { ...upload, name: "hostile.zip" } }],
      false,
      importId,
    );

    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job?.status).toBe("completed");
    const report = await reportOf(importId);
    expect(report.totals).toMatchObject({ messages: 2, failed: 2 });
    const failed = report.items.filter((item) => item.outcome === "failed");
    expect(failed.map((item) => [item.ref, item.code])).toEqual([
      ["hostile.zip!hostile/loop.msg", "unreadable"],
      ["hostile.zip!hostile/size.msg", "unreadable"],
    ]);
    for (const item of failed) {
      expect(item.reason).toContain("damaged");
    }
    expect(report.files[0]).toMatchObject({ format: "zip", status: "partial" });
    // No half-finished attempt is left behind for a retry to trip over.
    const [after] = await db.select({ cursor: jobs.cursor }).from(jobs).where(eq(jobs.id, jobId));
    expect(after?.cursor).toBeNull();
    expect((await storage.primary.list(`tenants/${tenantId}/staging/`)).length).toBe(0);
  });

  it("imports a server-folder tree (MailStore style) with EML and MSG and reads the folder read-only", async () => {
    const tree = join(importDir, tenantSlug, "mailstore-export");
    await mkdir(join(tree, "Inbox", "Clients"), { recursive: true });
    await mkdir(join(tree, "Empty folder"), { recursive: true });
    await writeFile(join(tree, "Inbox", "1 - Offer.eml"), message("Offer", "f1"));
    await writeFile(
      join(tree, "Inbox", "Clients", "2 - Order.msg"),
      await buildMsg({
        from: { address: "bob@example.test", name: "Bob Example" },
        to: [{ address: "alice@example.test" }],
        subject: "Order",
        body: "Please deliver.",
        attachments: [{ filename: "list.txt", content: Buffer.from("1 x thing") }],
      }),
    );
    await writeFile(join(tree, "Inbox", "Thumbs.db"), Buffer.from("not a mail"));
    const importId = randomUUID();
    await startImport(
      [{ folder: { path: `${tenantSlug}/mailstore-export`, kind: "directory" } }],
      false,
      importId,
    );

    const report = await reportOf(importId);
    expect(report.totals).toMatchObject({
      messages: 2,
      skipped: 1,
      failed: 0,
      synthesizedMessages: 1,
    });
    expect(report.files[0]).toMatchObject({ path: "mailstore-export/", format: "directory" });
    expect(report.notes).toContain("msg_reconstructed");
    const [snapshot] = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.protectedObjectId, object.id));
    const rows = await db
      .select()
      .from(manifestObjects)
      .where(eq(manifestObjects.snapshotId, snapshot?.id as string));
    expect(rows.map((row) => row.path).sort()).toEqual([
      "mail/Empty folder",
      "mail/Inbox",
      "mail/Inbox/1.eml",
      "mail/Inbox/Clients",
      "mail/Inbox/Clients/1.eml",
    ]);
  });

  it("keeps the export files of a tenant under the limit: a run that does not fit fails without a file, purged exports do not count, and the record step is atomic", async () => {
    const importId = randomUUID();
    const upload = await stageUpload(
      "quota.mbox",
      buildMbox([message("Quota one", "q1"), message("Quota two", "q2")]),
      importId,
    );
    await startImport([{ upload: { ...upload, name: "quota.mbox" } }], false, importId);
    const [snapshot] = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.protectedObjectId, object.id));

    async function requestExport() {
      const exportId = randomUUID();
      const jobId = randomUUID();
      await db.insert(jobs).values({
        id: jobId,
        tenantId,
        queue: "export",
        status: "queued",
        protectedObjectId: object.id,
        payload: { jobId, tenantId, exportId, protectedObjectId: object.id },
      });
      await db.insert(mailExports).values({
        id: exportId,
        tenantId,
        jobId,
        origin: "snapshot",
        format: "eml_zip",
        snapshotId: snapshot?.id,
        protectedObjectId: object.id,
        selection: { all: true },
      });
      return { exportId, jobId };
    }
    async function runExport(limit: number) {
      const requested = await requestExport();
      await runJob(
        runtime(),
        createExportHandler({ env: { EXPORT_MAX_TENANT_BYTES: String(limit) } }) as AnyJobHandler,
        pgBossJob("export", {
          jobId: requested.jobId,
          tenantId,
          exportId: requested.exportId,
          protectedObjectId: object.id,
        }),
      );
      const [row] = await db
        .select()
        .from(mailExports)
        .where(eq(mailExports.id, requested.exportId));
      const [job] = await db.select().from(jobs).where(eq(jobs.id, requested.jobId));
      return { ...requested, row, job };
    }
    const exportSegments = async (id: string) =>
      (await storage.primary.list(`tenants/${tenantId}/exports/${id}/`)).length;

    // Start from an empty export area.
    await db
      .update(mailExports)
      .set({ purgedAt: new Date() })
      .where(eq(mailExports.tenantId, tenantId));

    const first = await runExport(10 * 1024 * 1024);
    expect(first.job?.status).toBe("completed");
    const size = first.row?.fileSize as number;
    expect(size).toBeGreaterThan(0);
    const limit = size + Math.floor(size / 2);

    // The second file needs `size` bytes, the limit leaves half of that.
    const second = await runExport(limit);
    expect(second.job?.status).toBe("failed");
    expect(second.job?.failure).toMatchObject({ code: "export.quota_exceeded" });
    expect(second.row?.fileSize).toBeNull();
    expect(second.row?.expiresAt).toBeNull();
    expect(await exportSegments(second.exportId)).toBe(0);
    expect(await exportSegments(first.exportId)).toBeGreaterThan(0);

    // A purged export gives its room back.
    await db
      .update(mailExports)
      .set({ purgedAt: new Date() })
      .where(eq(mailExports.id, first.exportId));
    const third = await runExport(limit);
    expect(third.job?.status).toBe("completed");

    // Recording is one step under a lock: with room for one more file, exactly one of two wins.
    const store = pgExportStore(tenantRunner(db, tenantId), tenantId, size * 2 + 10);
    const a = await requestExport();
    const b = await requestExport();
    const record = (id: string) =>
      store.persistResult(id, {
        fileName: "x.zip",
        contentType: "application/zip",
        fileSize: size + 5,
        segmentSize: 65536,
        sha256: "0".repeat(64),
        report: {},
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    const outcomes = await Promise.all([record(a.exportId), record(b.exportId)]);
    expect(outcomes.filter((outcome) => outcome.accepted)).toHaveLength(1);
    expect(outcomes.find((outcome) => !outcome.accepted)).toMatchObject({
      usedBytes: expect.any(Number),
    });
    await db
      .update(mailExports)
      .set({ purgedAt: new Date() })
      .where(eq(mailExports.tenantId, tenantId));
  });

  it("cleans up what nothing will use again: failed exports, stray scopes and the staging of vanished imports", async () => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
    const put = (kind: "staging" | "export", id: string) =>
      segments().put({ tenantId, kind, id }, 0, Buffer.from(`segment of ${id}`));
    const left = async (kind: "staging" | "export", id: string) =>
      (await segments().indexes({ tenantId, kind, id })).length;
    async function exportWith(jobStatus: "failed" | "cancelled" | "queued" | null, endedAt: Date) {
      const exportId = randomUUID();
      let jobId: string | null = null;
      if (jobStatus !== null) {
        jobId = randomUUID();
        await db.insert(jobs).values({
          id: jobId,
          tenantId,
          queue: "export",
          status: jobStatus,
          protectedObjectId: object.id,
          payload: {},
          completedAt: jobStatus === "queued" ? null : endedAt,
          updatedAt: endedAt,
        });
      }
      await db.insert(mailExports).values({
        id: exportId,
        tenantId,
        jobId,
        origin: "snapshot",
        format: "eml_zip",
        protectedObjectId: object.id,
        selection: { all: true },
        createdAt: endedAt,
      });
      await put("export", exportId);
      return exportId;
    }

    // Exports without a file: failed or cancelled long ago, still stopping, still waiting, no job at all.
    const failedLongAgo = await exportWith("failed", hoursAgo(3));
    const cancelledLongAgo = await exportWith("cancelled", hoursAgo(5));
    const justFailed = await exportWith("failed", new Date());
    const waiting = await exportWith("queued", hoursAgo(10));
    const noJobOld = await exportWith(null, hoursAgo(72));
    const noJobYoung = await exportWith(null, hoursAgo(1));

    // Stray scopes: nothing in the database knows them. A live upload and a name that is not ours stay.
    const strayExport = randomUUID();
    const strayStaging = randomUUID();
    await put("export", strayExport);
    await put("staging", strayStaging);
    const liveUpload = randomUUID();
    await put("staging", liveUpload);
    await db.insert(importUploads).values({
      id: liveUpload,
      tenantId,
      fileName: "live.mbox",
      size: 10,
      segmentSize: mailfiles.MIN_SEGMENT_SIZE,
      segmentCount: 1,
      status: "uploading",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await storage.primary.put(
      `tenants/${tenantId}/exports/not-an-id/00000000.seg`,
      Buffer.from("not ours"),
    );

    // The staging of an import whose job row is gone: left alone while young, cleared once old.
    const vanished = randomUUID();
    const vanishedYoung = randomUUID();
    for (const [id, age] of [
      [vanished, 72],
      [vanishedYoung, 1],
    ] as const) {
      await put("staging", id);
      await db.insert(importUploads).values({
        id,
        tenantId,
        fileName: "vanished.mbox",
        size: 10,
        segmentSize: mailfiles.MIN_SEGMENT_SIZE,
        segmentCount: 1,
        status: "consumed",
        importId: randomUUID(),
        expiresAt: hoursAgo(age - 48),
        updatedAt: hoursAgo(age),
      });
    }

    const base = createMemoryJobContext({
      tenantId,
      keys,
      storage,
      logger: noopLogger,
      now: () => new Date(),
    });
    const ctx: WorkerJobContext = {
      ...base,
      db,
      protectedObject: null,
      chunkIndex: new PgChunkIndex(tenantRunner(db, tenantId), tenantId),
    };

    // A dry run counts and deletes nothing.
    const dry = await mailFilesCleanupTask.run(ctx, { dryRun: true });
    expect(dry).toMatchObject({ failedExportsPurged: 3, dryRun: true });
    expect(await left("export", failedLongAgo)).toBe(1);

    const summary = await mailFilesCleanupTask.run(ctx, { dryRun: false });
    expect(summary).toMatchObject({ failedExportsPurged: 3, strayScopesRemoved: 2, errors: 0 });
    for (const id of [failedLongAgo, cancelledLongAgo, noJobOld, strayExport]) {
      expect(await left("export", id), id).toBe(0);
    }
    for (const id of [justFailed, waiting, noJobYoung]) {
      expect(await left("export", id), id).toBe(1);
    }
    expect(await left("staging", strayStaging)).toBe(0);
    expect(await left("staging", liveUpload)).toBe(1);
    expect(await left("staging", vanished)).toBe(0);
    expect(await left("staging", vanishedYoung)).toBe(1);
    expect(await storage.primary.list(`tenants/${tenantId}/exports/not-an-id/`)).toHaveLength(1);
    const [purged] = await db.select().from(mailExports).where(eq(mailExports.id, failedLongAgo));
    expect(purged?.purgedAt).not.toBeNull();
    const [kept] = await db.select().from(mailExports).where(eq(mailExports.id, justFailed));
    expect(kept?.purgedAt).toBeNull();

    // Once more: nothing is left to do, and purged rows are not looked at again.
    expect(await mailFilesCleanupTask.run(ctx, { dryRun: false })).toMatchObject({
      failedExportsPurged: 0,
      strayScopesRemoved: 0,
      uploadsCleared: 0,
    });

    // Tidy up for the tests after this one.
    for (const id of [justFailed, waiting, noJobYoung]) {
      await segments().delete({ tenantId, kind: "export", id });
    }
    await segments().delete({ tenantId, kind: "staging", id: liveUpload });
    await segments().delete({ tenantId, kind: "staging", id: vanishedYoung });
    await storage.primary.delete(`tenants/${tenantId}/exports/not-an-id/00000000.seg`);
    await db.delete(importUploads).where(eq(importUploads.tenantId, tenantId));
    await db
      .update(mailExports)
      .set({ purgedAt: new Date() })
      .where(eq(mailExports.tenantId, tenantId));
  });

  it("archives imported mail with a valid hash chain, keeps the mail date and is idempotent", async () => {
    const importId = randomUUID();
    const upload = await stageUpload(
      "archive.mbox",
      buildMbox([
        message("Old letter", "old1", {
          date: "Mon, 05 Mar 2012 09:30:00 +0000",
          body: "quarterly numbers 2012",
        }),
        message("Newer letter", "old2", {
          date: "Tue, 05 Mar 2019 09:30:00 +0000",
          body: "budget",
        }),
      ]),
      importId,
    );
    await startImport([{ upload: { ...upload, name: "archive.mbox" } }], true, importId);

    const report = await reportOf(importId);
    expect(report.archive).toEqual({ requested: true, ingested: 2, alreadyArchived: 0, failed: 0 });
    const items = await db.select().from(archiveItems).where(eq(archiveItems.tenantId, tenantId));
    expect(items).toHaveLength(2);
    expect(
      items.every(
        (item) => item.capturedVia === "file_import" && item.protectedObjectId === object.id,
      ),
    ).toBe(true);
    const old = items.find((item) => item.subject === "Old letter");
    expect(old?.sentAt?.toISOString()).toBe("2012-03-05T09:30:00.000Z");
    // Retention counts from the import, never from the letter's date.
    expect(old?.receivedAt.getFullYear()).toBeGreaterThanOrEqual(new Date().getFullYear());
    expect(old?.retentionUntil).not.toBeNull();
    expect(old?.bodyText).toContain("quarterly numbers 2012");
    const ordered = [...items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const chain = archive.verifyChain(
      ordered.map((item) => ({
        itemHash: item.itemHash,
        receivedAt: item.receivedAt,
        chainHash: item.chainHash,
      })),
    );
    expect(chain.ok).toBe(true);

    // Importing the same mail again finds nothing new; nothing is archived twice.
    const again = randomUUID();
    const repeat = await stageUpload(
      "archive-again.mbox",
      buildMbox([
        message("Old letter", "old1", {
          date: "Mon, 05 Mar 2012 09:30:00 +0000",
          body: "quarterly numbers 2012",
        }),
      ]),
      again,
    );
    await startImport([{ upload: { ...repeat, name: "archive-again.mbox" } }], true, again).catch(
      () => undefined,
    );
    expect(
      await db.select().from(archiveItems).where(eq(archiveItems.tenantId, tenantId)),
    ).toHaveLength(2);
  });

  it("exports an imported mailbox as EML ZIP and MBOX that read back byte for byte, sealed, then expires", async () => {
    const importId = randomUUID();
    const originals = [
      message("Alpha", "ex1"),
      message("Beta", "ex2", {
        attachments: [{ filename: "a.bin", content: Buffer.alloc(3000, 9) }],
      }),
    ];
    const upload = await stageUpload("two.mbox", buildMbox(originals), importId);
    await startImport([{ upload: { ...upload, name: "two.mbox" } }], false, importId);
    const [snapshot] = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.protectedObjectId, object.id));

    async function runExport(format: "eml_zip" | "mbox") {
      const exportId = randomUUID();
      const jobId = randomUUID();
      await db.insert(jobs).values({
        id: jobId,
        tenantId,
        queue: "export",
        status: "queued",
        protectedObjectId: object.id,
        payload: { jobId, tenantId, exportId, protectedObjectId: object.id },
      });
      await db.insert(mailExports).values({
        id: exportId,
        tenantId,
        jobId,
        origin: "snapshot",
        format,
        snapshotId: snapshot?.id,
        protectedObjectId: object.id,
        selection: { all: true },
      });
      await runJob(
        runtime(),
        createExportHandler({ env: {} }) as AnyJobHandler,
        pgBossJob("export", { jobId, tenantId, exportId, protectedObjectId: object.id }),
      );
      const [row] = await db.select().from(mailExports).where(eq(mailExports.id, exportId));
      if (!row?.fileSize || !row.segmentSize) {
        throw new Error("export produced no file");
      }
      const parts: Buffer[] = [];
      for await (const part of segments().readStream(
        { tenantId, kind: "export", id: exportId },
        { size: row.fileSize, segmentSize: row.segmentSize },
      )) {
        parts.push(part as Buffer);
      }
      return { row, file: Buffer.concat(parts), exportId };
    }

    const eml = await runExport("eml_zip");
    expect(createHash("sha256").update(eml.file).digest("hex")).toBe(eml.row.sha256);
    expect(eml.row.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    const zipped = readZip(eml.file).filter((entry) => entry.name.endsWith(".eml"));
    expect(zipped).toHaveLength(2);
    for (const original of originals) {
      expect(zipped.some((entry) => entry.data.equals(original))).toBe(true);
    }

    const mbox = await runExport("mbox");
    expect(mbox.row.fileName).toMatch(/\.mbox$/);
    // Read the exported MBOX with the import reader: the same messages come back, byte for byte.
    const input: mailfiles.MailInputFile = {
      path: "exported.mbox",
      size: mbox.file.length,
      open: () => Readable.from([mbox.file]),
      read: async (offset, length) => mbox.file.subarray(offset, offset + length),
    };
    const back: Buffer[] = [];
    for await (const event of mailfiles.walkMailFile(input)) {
      if (event.type === "message") {
        back.push(event.raw);
      }
    }
    expect(back).toHaveLength(2);
    for (const original of originals) {
      expect(back.some((raw) => raw.equals(original))).toBe(true);
    }

    // The sweep deletes what expired and keeps the rest.
    await db
      .update(mailExports)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mailExports.id, eml.exportId));
    const base = createMemoryJobContext({
      tenantId,
      keys,
      storage,
      logger: noopLogger,
      now: () => new Date(),
    });
    const ctx: WorkerJobContext = {
      ...base,
      db,
      protectedObject: null,
      chunkIndex: new PgChunkIndex(tenantRunner(db, tenantId), tenantId),
    };
    const summary = await mailFilesCleanupTask.run(ctx, { dryRun: false });
    expect(summary).toMatchObject({ exportsPurged: 1 });
    expect(
      (await storage.primary.list(`tenants/${tenantId}/exports/${eml.exportId}/`)).length,
    ).toBe(0);
    expect(
      (await storage.primary.list(`tenants/${tenantId}/exports/${mbox.exportId}/`)).length,
    ).toBeGreaterThan(0);
    const [purged] = await db.select().from(mailExports).where(eq(mailExports.id, eml.exportId));
    expect(purged?.purgedAt).not.toBeNull();
  });

  it("sweeps expired uploads and the uploads of a finished import", async () => {
    const importId = randomUUID();
    const stale = await stageUpload("stale.mbox", buildMbox([message("s", "s1")]), importId);
    await db
      .update(importUploads)
      .set({ status: "uploading", importId: null, expiresAt: new Date(Date.now() - 1000) })
      .where(eq(importUploads.id, stale.id));
    const base = createMemoryJobContext({
      tenantId,
      keys,
      storage,
      logger: noopLogger,
      now: () => new Date(),
    });
    const ctx: WorkerJobContext = { ...base, db, protectedObject: null };
    const summary = await mailFilesCleanupTask.run(ctx, { dryRun: false });
    expect(summary).toMatchObject({ uploadsExpired: 1 });
    expect((await storage.primary.list(`tenants/${tenantId}/staging/${stale.id}/`)).length).toBe(0);
    const [row] = await db.select().from(importUploads).where(eq(importUploads.id, stale.id));
    expect(row?.status).toBe("expired");
  });

  it("finds the Microsoft 365 mailbox an imported mailbox is restored into and refuses others", async () => {
    const [m365] = await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "M365", status: "active", config: {} })
      .returning();
    await db.insert(protectedObjects).values({
      tenantId,
      sourceId: m365?.id as string,
      kind: "mailbox",
      externalId: "Anna@Example.Test",
      displayName: "Anna",
    });
    const run = tenantRunner(db, tenantId);
    const target = await mailboxTargetObject(run, tenantId, "anna@example.test");
    expect(target).toMatchObject({
      kind: "mailbox",
      sourceId: m365?.id,
      externalId: "Anna@Example.Test",
    });
    // The imported mailbox itself is never a target, and an unknown address is refused.
    await expect(mailboxTargetObject(run, tenantId, object.externalId)).rejects.toThrow(
      /not a Microsoft 365 mailbox/,
    );
    await expect(mailboxTargetObject(run, tenantId, null)).rejects.toThrow(
      /not a Microsoft 365 mailbox/,
    );
    expect(
      restoreTargetKindOf({
        selection: { all: true, options: { targetKind: "mailbox" } },
      } as never),
    ).toBe("mailbox");
    expect(restoreTargetKindOf({ selection: { all: true } } as never)).toBeNull();
  });
});
