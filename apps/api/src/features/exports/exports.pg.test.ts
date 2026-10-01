/**
 * Postgres-backed tests of mail exports: creating them from a snapshot and from
 * the archive, the permission and impersonation rules, tenant isolation under
 * Row Level Security, the list and detail responses, cancelling, and the
 * download that streams the sealed segments the worker wrote.
 *
 * The service runs on the application role that Row Level Security binds
 * (src/testing/database-roles.ts); the suite's own handle is the owner, for
 * fixtures and assertions. The HTTP cases use the real router and middleware:
 * only better-auth's session lookup is replaced (sessions by the
 * `x-test-user` header, as in features/snapshots/routes.pg.test.ts). Segments
 * live in a memory storage backend, except for one case that goes through the
 * real `segmentStoreFor` onto a local directory with the tenant's real key.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_exports_test` is recreated there and
 * dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  Keyring,
  type StorageBackend,
  generateDek,
  kekFromBase64,
  mailfiles,
  wrapDek,
} from "@restow/core";
import {
  type Database,
  archiveItems,
  auditLog,
  createDb,
  itemFailures,
  jobProgress,
  jobs,
  mailExports,
  manifestObjects,
  member,
  organization,
  protectedObjects,
  providerMembers,
  providers,
  snapshots,
  sources,
  tenantKeys,
  tenants,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenantTx } from "../../lib/tenant-context.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  type ExplorerFixture,
  createExplorerFixture,
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { createExportSchema } from "./schemas.js";

const DATABASE = "restow_api_exports_test";
const SEGMENT = mailfiles.MIN_SEGMENT_SIZE;

/** Sessions by the `x-test-user` header; better-auth itself is not under test here. */
const sessions = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../auth.js", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) =>
        sessions.get(headers.get("x-test-user") ?? "") ?? null,
    },
  },
}));

/** The segment store the service reads from; null lets the real `segmentStoreFor` through. */
const segmentOverride = vi.hoisted(() => ({ store: null as unknown }));
vi.mock("../../lib/segment-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/segment-store.js")>();
  return {
    ...actual,
    segmentStoreFor: (database: Database, tenantId: string) =>
      segmentOverride.store
        ? Promise.resolve(segmentOverride.store as mailfiles.SegmentStore)
        : actual.segmentStoreFor(database, tenantId),
  };
});

type Service = typeof import("./service.js");

/** The `EXPORT_MAX_TENANT_BYTES` of this suite. */
const QUOTA_BYTES = 1_000_000_000;

/** A map-backed storage backend that counts how often a segment was opened. */
class MemoryStorage implements StorageBackend {
  readonly files = new Map<string, Buffer>();
  gets = 0;

  async put(key: string, data: Buffer | Readable): Promise<void> {
    if (Buffer.isBuffer(data)) {
      this.files.set(key, Buffer.from(data));
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of data) {
      parts.push(Buffer.from(part as Uint8Array));
    }
    this.files.set(key, Buffer.concat(parts));
  }

  async get(key: string): Promise<Buffer> {
    this.gets++;
    const file = this.files.get(key);
    if (!file) {
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
    }
    return Buffer.from(file);
  }

  async getStream(key: string): Promise<Readable> {
    return Readable.from([await this.get(key)]);
  }

  async head(key: string): Promise<{ size: number } | null> {
    const file = this.files.get(key);
    return file ? { size: file.length } : null;
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
}

function sessionOf(
  userId: string,
  email: string,
  name: string,
  role: "user" | "admin",
): Record<string, unknown> {
  return {
    user: { id: userId, email, name, role, banned: false, twoFactorEnabled: false },
    session: {
      id: randomUUID(),
      userId,
      authMethod: "passkey",
      activeOrganizationId: null,
      impersonatedBy: null,
    },
  };
}

describe.skipIf(!testDatabaseAdminUrl)("mail exports against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let f: ExplorerFixture;
  let service: Service;
  let app: Hono;
  let memory: MemoryStorage;
  let store: mailfiles.SegmentStore;
  let storageDir: string;
  let masterKey: string;

  let fabrikam: string;
  let fabrikamExport: string;
  let fabrikamArchiveItem: string;
  let importObject: string;
  let importSnapshot: string;
  const archiveItem: Record<"invoiceMarch" | "invoiceApril" | "lunch", string> = {
    invoiceMarch: "",
    invoiceApril: "",
    lunch: "",
  };

  const actor = (viewer: ExplorerFixture["admin"]) => ({ ...viewer, ip: "192.0.2.10" });

  const snapshotRequest = (overrides: Record<string, unknown> = {}) =>
    createExportSchema.parse({
      origin: "snapshot",
      snapshotId: f.mailbox.second,
      selection: [{ path: "mail/Inbox" }],
      format: "eml_zip",
      ...overrides,
    });

  const archiveRequest = (selection: Record<string, unknown>, overrides = {}) =>
    createExportSchema.parse({ origin: "archive", selection, format: "eml_zip", ...overrides });

  /** Anna's export of a small selection; the usual starting point of a case. */
  async function annasExport(overrides: Record<string, unknown> = {}) {
    return service.createExport(appDb, f.tenantId, actor(f.anna), snapshotRequest(overrides));
  }

  /**
   * What the worker does when an export finishes: the file as sealed segments
   * in storage, then the file facts on the row and the job completed.
   */
  async function complete(
    created: { id: string; jobId: string },
    options: {
      size?: number;
      expiresAt?: Date | null;
      completedAt?: Date;
      purgedAt?: Date | null;
      contentType?: string | null;
      fileName?: string;
      report?: Record<string, unknown>;
      target?: mailfiles.SegmentStore;
    } = {},
  ): Promise<{ bytes: Buffer; sha256: string; segments: number }> {
    const bytes = randomBytes(options.size ?? SEGMENT * 2 + 1234);
    const written = await (options.target ?? store).writeStream(
      { tenantId: f.tenantId, kind: "export", id: created.id },
      Readable.from([bytes]),
      { segmentSize: SEGMENT },
    );
    const completedAt = options.completedAt ?? new Date();
    await owner
      .update(mailExports)
      .set({
        fileName: options.fileName ?? "export.zip",
        contentType: options.contentType === undefined ? "application/zip" : options.contentType,
        fileSize: written.size,
        segmentSize: written.segmentSize,
        sha256: written.sha256,
        expiresAt:
          options.expiresAt === undefined
            ? new Date(completedAt.getTime() + 24 * 3600 * 1000)
            : options.expiresAt,
        purgedAt: options.purgedAt ?? null,
        report: options.report ?? {
          messages: 3,
          folders: 1,
          bytes: written.size,
          failed: 0,
          skipped: { calendar: 0, contacts: 0, other: 0 },
          items: [],
        },
      })
      .where(eq(mailExports.id, created.id));
    await owner
      .update(jobs)
      .set({ status: "completed", completedAt })
      .where(eq(jobs.id, created.jobId));
    return { bytes, sha256: written.sha256, segments: written.segments };
  }

  async function http(
    as: string,
    method: string,
    path: string,
    options: { body?: unknown; tenant?: string | null } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { "x-test-user": as };
    if (options.tenant !== null) {
      headers["x-restow-tenant"] = options.tenant ?? f.tenantId;
    }
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    return app.request(`/api/v1/exports${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  async function auditEntries(action: string, target: string) {
    return owner
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.target, target)));
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    // The API's shared handles and configuration read the environment on import.
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    masterKey = randomBytes(32).toString("base64");
    process.env.RESTOW_MASTER_KEY = masterKey;
    storageDir = await mkdtemp(join(tmpdir(), "restow-exports-test-"));
    process.env.STORAGE_TARGET = "local";
    process.env.STORAGE_LOCAL_PATH = storageDir;
    // A limit the other tests stay far below and the quota test can reach with one row.
    process.env.EXPORT_MAX_TENANT_BYTES = String(QUOTA_BYTES);
    owner = createDb(url);
    appDb = createDb(roles.appUrl);

    // pg-boss owns its schema as the installation role (apps/worker/src/index.ts);
    // the API only ever enqueues into it, on the application role.
    const boss = new PgBoss({ connectionString: roles.providerUrl });
    await boss.start();
    await boss.createQueue("export");
    await boss.stop({ graceful: false, wait: true });

    f = await createExplorerFixture(owner);

    // The tenant's people as organization members, so the real tenant middleware admits them.
    const organizationId = randomUUID();
    await owner.insert(organization).values({
      id: organizationId,
      name: "Contoso",
      slug: `contoso-${organizationId.slice(0, 8)}`,
      createdAt: new Date(),
    });
    await owner.update(tenants).set({ organizationId }).where(eq(tenants.id, f.tenantId));
    await owner.insert(member).values(
      [
        [f.admin, "admin"],
        [f.anna, "member"],
        [f.bob, "member"],
      ].map(([viewer, role]) => ({
        id: randomUUID(),
        organizationId,
        userId: (viewer as ExplorerFixture["admin"]).userId as string,
        role: role as string,
        createdAt: new Date(),
      })),
    );
    sessions.set("admin", sessionOf(f.admin.userId as string, f.admin.email, "Admin", "user"));
    sessions.set("anna", sessionOf(f.anna.userId as string, f.anna.email, "Anna", "user"));
    sessions.set("bob", sessionOf(f.bob.userId as string, f.bob.email, "Bob", "user"));
    sessions.set("provider", sessionOf(f.admin.userId as string, f.admin.email, "Admin", "admin"));

    // The imported mailbox: a protected object of kind imap under a source of kind import.
    const [importSource] = await owner
      .insert(sources)
      .values({
        tenantId: f.tenantId,
        kind: "import",
        name: "Imported mail files",
        status: "active",
      })
      .returning();
    const [imported] = await owner
      .insert(protectedObjects)
      .values({
        tenantId: f.tenantId,
        sourceId: importSource?.id as string,
        kind: "imap",
        origin: "manual",
        externalId: `import-${randomUUID()}`,
        displayName: "Legacy mail 2019",
      })
      .returning();
    importObject = imported?.id as string;
    const [importedSnapshot] = await owner
      .insert(snapshots)
      .values({
        tenantId: f.tenantId,
        protectedObjectId: importObject,
        sequence: 1,
        startedAt: new Date("2026-02-01T08:00:00Z"),
        completedAt: new Date("2026-02-01T08:00:00Z"),
        manifestPath: `tenants/${f.tenantId}/manifests/${randomUUID()}`,
        itemCount: 2,
        byteSize: 200,
      })
      .returning();
    importSnapshot = importedSnapshot?.id as string;
    const importBase = {
      tenantId: f.tenantId,
      snapshotId: importSnapshot,
      protectedObjectId: importObject,
    };
    await owner.insert(manifestObjects).values([
      {
        ...importBase,
        kind: "folder",
        path: "mail/Imported",
        name: "Imported",
        parentPath: "mail",
        size: 0,
      },
      {
        ...importBase,
        kind: "mail",
        path: "mail/Imported/1.eml",
        name: "1.eml",
        parentPath: "mail/Imported",
        size: 100,
        chunkRefs: ["chunk-import-1"],
        itemId: "import-msg-1",
      },
    ]);

    // Archive items of Contoso (message dates differ from the capture time) and of another tenant.
    let previousChain: string | null = null;
    const seed = async (
      tenantId: string,
      label: string,
      subject: string,
      sentAt: Date | null,
      hasAttachment: boolean,
    ): Promise<string> => {
      const chainHash: string = `chain-${label}`;
      const [row] = await owner
        .insert(archiveItems)
        .values({
          tenantId,
          messageId: `msg-${label}`,
          itemHash: `hash-${label}`,
          prevChainHash: previousChain,
          chainHash,
          receivedAt: new Date("2026-09-01T00:00:00Z"),
          sentAt,
          capturedVia: "file_import",
          storagePath: `tenants/${tenantId}/archive/${label}`,
          subject,
          hasAttachment,
          envelope: { from: "sender@contoso.test", to: ["anna@contoso.test"] },
        })
        .returning({ id: archiveItems.id });
      previousChain = chainHash;
      return row?.id as string;
    };
    archiveItem.invoiceMarch = await seed(
      f.tenantId,
      "c1",
      "Invoice March",
      new Date("2019-03-05T10:00:00Z"),
      true,
    );
    archiveItem.invoiceApril = await seed(
      f.tenantId,
      "c2",
      "Invoice April",
      new Date("2019-04-05T10:00:00Z"),
      false,
    );
    archiveItem.lunch = await seed(f.tenantId, "c3", "Lunch plans", null, false);

    // A second tenant with a mailbox, a snapshot, an archive item and a finished export.
    const [provider] = await owner.select().from(providers).limit(1);
    const [otherTenant] = await owner
      .insert(tenants)
      .values({ providerId: provider?.id as string, name: "Fabrikam", slug: "fabrikam" })
      .returning();
    fabrikam = otherTenant?.id as string;
    const [otherSource] = await owner
      .insert(sources)
      .values({ tenantId: fabrikam, kind: "m365", name: "Fabrikam M365", status: "active" })
      .returning();
    const [otherObject] = await owner
      .insert(protectedObjects)
      .values({
        tenantId: fabrikam,
        sourceId: otherSource?.id as string,
        kind: "mailbox",
        externalId: "zoe@fabrikam.test",
        displayName: "Zoe",
      })
      .returning();
    const [otherSnapshot] = await owner
      .insert(snapshots)
      .values({
        tenantId: fabrikam,
        protectedObjectId: otherObject?.id as string,
        sequence: 1,
        startedAt: new Date("2026-02-01T08:00:00Z"),
        completedAt: new Date("2026-02-01T08:00:00Z"),
        manifestPath: `tenants/${fabrikam}/manifests/${randomUUID()}`,
        itemCount: 1,
        byteSize: 100,
      })
      .returning();
    previousChain = null;
    fabrikamArchiveItem = await seed(fabrikam, "f1", "Invoice Fabrikam", null, false);
    const otherJobId = randomUUID();
    await owner.insert(jobs).values({
      id: otherJobId,
      tenantId: fabrikam,
      queue: "export",
      status: "completed",
      protectedObjectId: otherObject?.id as string,
      completedAt: new Date(),
    });
    const [otherExport] = await owner
      .insert(mailExports)
      .values({
        tenantId: fabrikam,
        jobId: otherJobId,
        origin: "snapshot",
        format: "eml_zip",
        snapshotId: otherSnapshot?.id as string,
        protectedObjectId: otherObject?.id as string,
        selection: { all: true },
        fileName: "zoe.zip",
        fileSize: 10,
        segmentSize: SEGMENT,
        expiresAt: new Date(Date.now() + 3600 * 1000),
      })
      .returning();
    fabrikamExport = otherExport?.id as string;

    memory = new MemoryStorage();
    store = new mailfiles.SegmentStore({
      storage: memory,
      keys: new Keyring(f.tenantId, [generateDek(1)]),
    });
    segmentOverride.store = store;

    service = await import("./service.js");
    const { exportsRoutes } = await import("./routes.js");
    const { errorHandler, notFoundHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.notFound(notFoundHandler);
    app.route("/api/v1/exports", exportsRoutes);
  }, 90_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await appDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    if (roles) {
      await roles.drop(testDatabaseAdminUrl as string);
    }
    await rm(storageDir, { recursive: true, force: true });
  }, 60_000);

  // -------------------------------------------------------------------------
  // Formats
  // -------------------------------------------------------------------------

  describe("formats", () => {
    it("lists core's formats: EML ZIP and MBOX available, PST planned", async () => {
      const res = await http("anna", "GET", "/formats");
      expect(res.status).toBe(200);
      const { formats } = (await res.json()) as {
        formats: { id: string; available: boolean; planned?: boolean }[];
      };
      const byId = new Map(formats.map((format) => [format.id, format]));
      expect(byId.get("eml_zip")?.available).toBe(true);
      expect(byId.get("mbox")?.available).toBe(true);
      expect(byId.get("pst")).toMatchObject({ available: false, planned: true });
      expect(formats.map((format) => format.id)).toEqual(
        mailfiles.EXPORT_FORMATS.map((format) => format.id),
      );
    });

    it("refuses pst before anything is written", async () => {
      const before = await owner.select().from(mailExports);
      await expect(annasExport({ format: "pst" })).rejects.toMatchObject({
        status: 422,
        type: "urn:restow:problem:export-format-unavailable",
        extensions: { format: "pst", planned: true },
      });
      expect(await owner.select().from(mailExports)).toHaveLength(before.length);
    });

    it("follows the measured state of MSG and honours the formats it is given", async () => {
      const msg = mailfiles.EXPORT_FORMATS.find((format) => format.id === "msg_zip");
      if (msg?.available) {
        expect((await annasExport({ format: "msg_zip" })).status).toBe("queued");
      } else {
        await expect(annasExport({ format: "msg_zip" })).rejects.toMatchObject({
          status: 422,
          type: "urn:restow:problem:export-format-unavailable",
        });
      }
      const unavailable = [
        { id: "eml_zip", available: true },
        { id: "msg_zip", available: false, reason: "round trip failed" },
      ] as const;
      await expect(
        service.createExport(
          appDb,
          f.tenantId,
          actor(f.anna),
          snapshotRequest({ format: "msg_zip" }),
          {
            formats: unavailable,
          },
        ),
      ).rejects.toMatchObject({
        status: 422,
        extensions: { format: "msg_zip", planned: false, reason: "round trip failed" },
      });
      const available = [{ id: "msg_zip", available: true }] as const;
      const created = await service.createExport(
        appDb,
        f.tenantId,
        actor(f.anna),
        snapshotRequest({ format: "msg_zip" }),
        { formats: available },
      );
      const [stored] = await owner.select().from(mailExports).where(eq(mailExports.id, created.id));
      expect(stored?.format).toBe("msg_zip");
    });
  });

  // -------------------------------------------------------------------------
  // Create from a snapshot
  // -------------------------------------------------------------------------

  describe("creating an export from a snapshot", () => {
    it("writes the request, the lifecycle row, the queue entry and the audit entry together", async () => {
      const created = await annasExport({
        selection: [
          { path: "calendar", kind: "folder" },
          { path: "mail/Inbox/Quarterly.aaaa.eml", kind: "item" },
          { itemId: "msg-kickoff" },
          { path: "mail/Inbox/Lunch.bbbb.eml" },
        ],
        format: "mbox",
        fileName: "Anna Inbox",
      });
      expect(created).toEqual({
        id: expect.any(String),
        jobId: expect.any(String),
        status: "queued",
      });

      const [stored] = await owner.select().from(mailExports).where(eq(mailExports.id, created.id));
      expect(stored).toMatchObject({
        tenantId: f.tenantId,
        jobId: created.jobId,
        origin: "snapshot",
        format: "mbox",
        snapshotId: f.mailbox.second,
        protectedObjectId: f.annaMailbox,
        actorUserId: f.anna.userId,
        impersonated: false,
        reason: null,
        fileName: null,
        fileSize: null,
        expiresAt: null,
        purgedAt: null,
        selection: {
          folderPaths: ["calendar"],
          paths: ["mail/Inbox/Lunch.bbbb.eml", "mail/Inbox/Quarterly.aaaa.eml"],
          objectIds: ["msg-kickoff"],
          options: { fileName: "Anna Inbox" },
        },
      });

      const [job] = await owner.select().from(jobs).where(eq(jobs.id, created.jobId));
      const payload = {
        jobId: created.jobId,
        tenantId: f.tenantId,
        exportId: created.id,
        protectedObjectId: f.annaMailbox,
      };
      expect(job).toMatchObject({
        queue: "export",
        status: "queued",
        protectedObjectId: f.annaMailbox,
        payload,
      });
      expect(job?.pgBossJobId).toBeTruthy();

      const queued = await owner.execute<{
        name: string;
        priority: number;
        data: Record<string, unknown>;
      }>(sql`SELECT name, priority, data FROM pgboss.job WHERE id = ${job?.pgBossJobId}::uuid`);
      expect(queued.rows[0]).toEqual({ name: "export", priority: 90, data: payload });

      const [entry] = await auditEntries("export.requested", created.id);
      expect(entry).toMatchObject({
        tenantId: f.tenantId,
        actorUserId: f.anna.userId,
        targetType: "export_job",
        onBehalfOf: null,
        ip: "192.0.2.10",
      });
      expect(entry?.details).toMatchObject({
        jobId: created.jobId,
        origin: "snapshot",
        format: "mbox",
        snapshotId: f.mailbox.second,
        protectedObjectId: f.annaMailbox,
        objectKind: "mailbox",
        selection: { all: false, folders: 1, items: 3 },
        fileName: "Anna Inbox",
        reason: null,
        onBehalfOf: null,
      });
    });

    it("rejects entries that are not in the snapshot instead of exporting less", async () => {
      const before = await owner.select().from(mailExports);
      await expect(
        annasExport({
          selection: [{ path: "mail/Inbox" }, { path: "mail/Nowhere" }, { itemId: "ghost" }],
        }),
      ).rejects.toMatchObject({
        status: 422,
        type: "urn:restow:problem:export-selection-unknown",
        extensions: { unknown: ["path:mail/Nowhere", "itemId:ghost"] },
      });
      expect(await owner.select().from(mailExports)).toHaveLength(before.length);
    });

    it("selects the whole snapshot through the root and folders that only exist implicitly", async () => {
      const everything = await annasExport({ selection: [{ path: "" }] });
      const [all] = await owner.select().from(mailExports).where(eq(mailExports.id, everything.id));
      expect(all?.selection).toEqual({ all: true });

      const implicit = await annasExport({
        selection: [{ path: "mail" }, { path: "mail/Inbox/Quarterly.aaaa.eml" }],
      });
      const [stored] = await owner
        .select()
        .from(mailExports)
        .where(eq(mailExports.id, implicit.id));
      expect(stored?.selection).toEqual({ folderPaths: ["mail"] });
    });

    it("refuses the snapshot of a OneDrive as not mail", async () => {
      const before = await owner.select().from(mailExports);
      const request = snapshotRequest({
        snapshotId: f.drive,
        selection: [{ path: "" }],
        reason: "Offboarding export",
      });
      for (const viewer of [f.admin, f.anna]) {
        await expect(
          service.createExport(appDb, f.tenantId, actor(viewer), request),
        ).rejects.toMatchObject({
          status: 422,
          type: "urn:restow:problem:export-not-mail",
          extensions: { objectKind: "onedrive" },
        });
      }
      expect(await owner.select().from(mailExports)).toHaveLength(before.length);
    });

    it("exports an IMAP account snapshot", async () => {
      const created = await service.createExport(
        appDb,
        f.tenantId,
        actor(f.admin),
        snapshotRequest({
          snapshotId: f.imap,
          selection: [{ path: "mail/INBOX" }],
          reason: "Handing over the shared inbox",
        }),
      );
      const [stored] = await owner.select().from(mailExports).where(eq(mailExports.id, created.id));
      expect(stored?.protectedObjectId).toBe(f.imapAccount);
    });
  });

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  describe("the storage limit for exports", () => {
    it("refuses a new export while the finished ones take the whole limit, and allows it again once they are purged", async () => {
      const first = await annasExport();
      await complete(first);
      // The file is recorded with a size that uses up the limit (the bytes stay small on disk).
      await owner
        .update(mailExports)
        .set({ fileSize: QUOTA_BYTES })
        .where(eq(mailExports.id, first.id));

      const refused = await annasExport().catch((error: unknown) => error);
      expect(refused).toMatchObject({
        status: 422,
        type: "urn:restow:problem:export-quota-exceeded",
        extensions: { limitBytes: QUOTA_BYTES, ttlHours: 24 },
      });
      expect(
        (refused as { extensions: { usedBytes: number } }).extensions.usedBytes,
      ).toBeGreaterThanOrEqual(QUOTA_BYTES);
      // Nothing was written for the refused request.
      const rows = async () =>
        (await owner.select().from(mailExports).where(eq(mailExports.tenantId, f.tenantId))).length;
      const before = await rows();
      await expect(annasExport()).rejects.toMatchObject({ status: 422 });
      expect(await rows()).toBe(before);

      // An export whose download time ran out still holds its bytes until the cleanup deleted it.
      await owner
        .update(mailExports)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(mailExports.id, first.id));
      await expect(annasExport()).rejects.toMatchObject({ status: 422 });

      await owner
        .update(mailExports)
        .set({ purgedAt: new Date() })
        .where(eq(mailExports.id, first.id));
      expect((await annasExport()).status).toBe("queued");
    });

    it("answers the problem over HTTP with the type the dialog maps", async () => {
      const first = await annasExport();
      await complete(first);
      await owner
        .update(mailExports)
        .set({ fileSize: QUOTA_BYTES })
        .where(eq(mailExports.id, first.id));
      const res = await http("anna", "POST", "", { body: snapshotRequest() });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        type: "urn:restow:problem:export-quota-exceeded",
        usedBytes: expect.any(Number),
        limitBytes: QUOTA_BYTES,
      });
      await owner
        .update(mailExports)
        .set({ purgedAt: new Date() })
        .where(eq(mailExports.id, first.id));
    });
  });

  describe("who may export what", () => {
    it("keeps end users to their own data", async () => {
      await expect(
        service.createExport(appDb, f.tenantId, actor(f.bob), snapshotRequest()),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.createExport(
          appDb,
          f.tenantId,
          actor(f.anna),
          snapshotRequest({ snapshotId: f.bobSnapshot, selection: [{ path: "mail/Inbox" }] }),
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.createExport(
          appDb,
          f.tenantId,
          actor(f.anna),
          snapshotRequest({ snapshotId: importSnapshot, selection: [{ path: "mail/Imported" }] }),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("requires a reason when an admin exports another person's data, and audits on whose behalf", async () => {
      await expect(
        service.createExport(appDb, f.tenantId, actor(f.admin), snapshotRequest()),
      ).rejects.toMatchObject({
        status: 422,
        type: "urn:restow:problem:export-reason-required",
      });

      const created = await service.createExport(
        appDb,
        f.tenantId,
        actor(f.admin),
        snapshotRequest({ reason: "Ticket 4711: leaver mailbox for legal" }),
      );
      const [stored] = await owner.select().from(mailExports).where(eq(mailExports.id, created.id));
      expect(stored).toMatchObject({
        impersonated: true,
        reason: "Ticket 4711: leaver mailbox for legal",
        actorUserId: f.admin.userId,
      });
      const [entry] = await auditEntries("export.requested", created.id);
      expect(entry?.onBehalfOf).toBe("anna@contoso.test");
      expect(entry?.details).toMatchObject({
        reason: "Ticket 4711: leaver mailbox for legal",
        onBehalfOf: "anna@contoso.test",
      });
    });

    it("treats an imported mailbox like somebody else's data: a reason, and the audit names it", async () => {
      const request = snapshotRequest({
        snapshotId: importSnapshot,
        selection: [{ path: "mail/Imported" }],
      });
      await expect(
        service.createExport(appDb, f.tenantId, actor(f.admin), request),
      ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:export-reason-required" });
      const created = await service.createExport(
        appDb,
        f.tenantId,
        actor(f.admin),
        snapshotRequest({
          snapshotId: importSnapshot,
          selection: [{ path: "mail/Imported" }],
          reason: "Migration to the new archive",
        }),
      );
      const [entry] = await auditEntries("export.requested", created.id);
      expect(entry?.onBehalfOf).toMatch(/^import-/);
      expect(entry?.details).toMatchObject({ objectKind: "imap", protectedObjectId: importObject });
    });

    it("lets a tenant admin export from the archive and refuses end users", async () => {
      const request = archiveRequest({ itemIds: [archiveItem.invoiceMarch] });
      await expect(
        service.createExport(appDb, f.tenantId, actor(f.anna), request),
      ).rejects.toMatchObject({ status: 403 });
      const created = await service.createExport(appDb, f.tenantId, actor(f.admin), request);
      expect(created.status).toBe("queued");
    });

    it("applies the same rules over HTTP", async () => {
      const own = await http("anna", "POST", "", {
        body: {
          origin: "snapshot",
          snapshotId: f.mailbox.second,
          selection: [{ path: "mail/Inbox" }],
          format: "eml_zip",
        },
      });
      expect(own.status).toBe(202);
      expect(await own.json()).toEqual({
        id: expect.any(String),
        jobId: expect.any(String),
        status: "queued",
      });

      const others = await http("bob", "POST", "", {
        body: {
          origin: "snapshot",
          snapshotId: f.mailbox.second,
          selection: [{ path: "mail/Inbox" }],
          format: "eml_zip",
        },
      });
      expect(others.status).toBe(404);

      const archive = await http("anna", "POST", "", {
        body: { origin: "archive", selection: { itemIds: [archiveItem.lunch] }, format: "mbox" },
      });
      expect(archive.status).toBe(403);

      const invalid = await http("anna", "POST", "", { body: { origin: "snapshot" } });
      expect(invalid.status).toBe(422);

      const noReason = await http("admin", "POST", "", {
        body: {
          origin: "snapshot",
          snapshotId: f.mailbox.second,
          selection: [{ path: "mail/Inbox" }],
          format: "eml_zip",
        },
      });
      expect(noReason.status).toBe(422);
      expect(await noReason.json()).toMatchObject({
        type: "urn:restow:problem:export-reason-required",
      });
    });

    it("applies the provider team's role: a read-only provider admin can look but not export or download", async () => {
      const created = await annasExport();
      await complete(created);
      await owner
        .insert(providerMembers)
        .values({ userId: f.admin.userId as string, role: "read_only", allTenants: true });
      try {
        expect((await http("provider", "GET", "")).status).toBe(200);
        expect((await http("provider", "GET", `/${created.id}`)).status).toBe(200);
        const download = await http("provider", "GET", `/${created.id}/download`);
        expect(download.status).toBe(403);
        expect(await download.json()).toMatchObject({
          type: "urn:restow:problem:provider-role-required",
        });
        const create = await http("provider", "POST", "", {
          body: {
            origin: "snapshot",
            snapshotId: f.mailbox.second,
            selection: [{ path: "mail/Inbox" }],
            format: "eml_zip",
            reason: "Ticket 1",
          },
        });
        expect(create.status).toBe(403);
      } finally {
        await owner
          .delete(providerMembers)
          .where(eq(providerMembers.userId, f.admin.userId as string));
      }
      // Without a team row the provider admin is an owner and may download.
      expect((await http("provider", "GET", `/${created.id}/download`)).status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Create from the archive
  // -------------------------------------------------------------------------

  describe("creating an export from the archive", () => {
    it("exports explicit item ids that belong to the tenant", async () => {
      const created = await service.createExport(
        appDb,
        f.tenantId,
        actor(f.admin),
        archiveRequest({ itemIds: [archiveItem.invoiceApril, archiveItem.invoiceMarch] }),
      );
      const [stored] = await owner.select().from(mailExports).where(eq(mailExports.id, created.id));
      expect(stored).toMatchObject({
        origin: "archive",
        snapshotId: null,
        protectedObjectId: null,
        impersonated: false,
        selection: { itemIds: [archiveItem.invoiceMarch, archiveItem.invoiceApril].sort() },
      });
      const [job] = await owner.select().from(jobs).where(eq(jobs.id, created.jobId));
      expect(job?.protectedObjectId).toBeNull();
      expect(job?.payload).toEqual({
        jobId: created.jobId,
        tenantId: f.tenantId,
        exportId: created.id,
      });
      const [entry] = await auditEntries("export.requested", created.id);
      expect(entry?.details).toMatchObject({
        origin: "archive",
        selection: { kind: "itemIds", items: 2 },
        reason: null,
      });
      expect(entry?.onBehalfOf).toBeNull();

      const detail = await service.getExport(appDb, f.tenantId, f.admin, created.id);
      expect(detail).toMatchObject({
        origin: "archive",
        object: null,
        snapshotId: null,
        selection: { items: 2, folders: null },
      });
    });

    it("rejects ids that do not exist or belong to another tenant", async () => {
      const missing = randomUUID();
      await expect(
        service.createExport(
          appDb,
          f.tenantId,
          actor(f.admin),
          archiveRequest({ itemIds: [archiveItem.lunch, missing, fabrikamArchiveItem] }),
        ),
      ).rejects.toMatchObject({
        status: 422,
        type: "urn:restow:problem:export-selection-unknown",
        extensions: {
          unknown: expect.arrayContaining([`itemId:${missing}`, `itemId:${fabrikamArchiveItem}`]),
          unknownCount: 2,
        },
      });
    });

    it("stores a search filter and counts what it matches", async () => {
      const created = await service.createExport(
        appDb,
        f.tenantId,
        actor(f.admin),
        archiveRequest({ filter: { q: "invoice", from: "sender@" } }),
      );
      const [stored] = await owner.select().from(mailExports).where(eq(mailExports.id, created.id));
      expect(stored?.selection).toEqual({
        filter: { q: "invoice", from: "sender@" },
        matched: 2,
      });
      const [entry] = await auditEntries("export.requested", created.id);
      expect(entry?.details).toMatchObject({
        selection: { kind: "filter", items: 2, capped: false, filter: { q: "invoice" } },
      });
      const detail = await service.getExport(appDb, f.tenantId, f.admin, created.id);
      expect(detail.selection).toEqual({ items: 2, folders: null });
    });

    it("filters by the message's own date, falling back to the capture date", async () => {
      // Imported mail was written years before it was captured: April 2019 matches by sent_at.
      const inApril = await service.createExport(
        appDb,
        f.tenantId,
        actor(f.admin),
        archiveRequest({
          filter: { dateFrom: "2019-04-01T00:00:00Z", dateTo: "2019-12-31T00:00:00Z" },
        }),
      );
      const [april] = await owner.select().from(mailExports).where(eq(mailExports.id, inApril.id));
      expect(april?.selection).toMatchObject({ matched: 1 });

      // The item without a message date is found by its capture date.
      const captured = await service.createExport(
        appDb,
        f.tenantId,
        actor(f.admin),
        archiveRequest({ filter: { dateFrom: "2026-08-01T00:00:00Z" } }),
      );
      const [recent] = await owner
        .select()
        .from(mailExports)
        .where(eq(mailExports.id, captured.id));
      expect(recent?.selection).toMatchObject({ matched: 1 });
    });

    it("counts at most the cap and says when it was reached", async () => {
      const created = await service.createExport(
        appDb,
        f.tenantId,
        actor(f.admin),
        archiveRequest({ filter: { q: "invoice" } }),
        { archiveMatchCap: 1 },
      );
      const [stored] = await owner.select().from(mailExports).where(eq(mailExports.id, created.id));
      expect(stored?.selection).toEqual({ filter: { q: "invoice" }, matched: 1, capped: true });
      const detail = await service.getExport(appDb, f.tenantId, f.admin, created.id);
      expect(detail.selection).toEqual({ items: 1, folders: null, capped: true });
      const [entry] = await auditEntries("export.requested", created.id);
      expect(entry?.details).toMatchObject({ selection: { items: 1, capped: true } });
    });

    it("refuses a filter that matches nothing", async () => {
      const before = await owner.select().from(mailExports);
      await expect(
        service.createExport(
          appDb,
          f.tenantId,
          actor(f.admin),
          archiveRequest({ filter: { q: "nothing-like-this-exists" } }),
        ),
      ).rejects.toMatchObject({
        status: 422,
        type: "urn:restow:problem:export-selection-empty",
      });
      expect(await owner.select().from(mailExports)).toHaveLength(before.length);
    });
  });

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  describe("reading exports", () => {
    it("shows end users their own requests and admins all of the tenant, newest first", async () => {
      const annas = await service.listExports(appDb, f.tenantId, f.anna, { limit: 50 });
      expect(annas.length).toBeGreaterThan(0);
      expect(annas.every((entry) => entry.actor.userId === f.anna.userId)).toBe(true);

      const bobsOwn = await service.createExport(
        appDb,
        f.tenantId,
        actor(f.bob),
        snapshotRequest({ snapshotId: f.bobSnapshot, selection: [{ path: "mail/Inbox" }] }),
      );
      const bobs = await service.listExports(appDb, f.tenantId, f.bob, { limit: 50 });
      expect(bobs.map((entry) => entry.id)).toEqual([bobsOwn.id]);

      const all = await service.listExports(appDb, f.tenantId, f.admin, { limit: 50 });
      expect(all.length).toBeGreaterThan(annas.length);
      expect(all.some((entry) => entry.actor.userId === f.bob.userId)).toBe(true);
      const times = all.map((entry) => Date.parse(entry.createdAt));
      expect(times).toEqual([...times].sort((a, b) => b - a));

      const limited = await service.listExports(appDb, f.tenantId, f.admin, { limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it("hides other people's exports from an end user, in the list, the detail and the download", async () => {
      const created = await annasExport();
      await complete(created);
      await expect(service.getExport(appDb, f.tenantId, f.bob, created.id)).rejects.toMatchObject({
        status: 404,
      });
      expect((await http("bob", "GET", `/${created.id}`)).status).toBe(404);
      expect((await http("bob", "GET", `/${created.id}/download`)).status).toBe(404);
      expect((await http("bob", "POST", `/${created.id}/cancel`)).status).toBe(404);
      const list = (await (await http("bob", "GET", "")).json()) as { items: { id: string }[] };
      expect(list.items.map((entry) => entry.id)).not.toContain(created.id);
    });

    it("describes a queued export", async () => {
      const created = await annasExport({ format: "mbox" });
      const detail = await service.getExport(appDb, f.tenantId, f.anna, created.id);
      expect(detail).toEqual({
        id: created.id,
        jobId: created.jobId,
        origin: "snapshot",
        format: "mbox",
        status: "queued",
        object: {
          id: f.annaMailbox,
          kind: "mailbox",
          externalId: "anna@contoso.test",
          displayName: "Anna",
        },
        snapshotId: f.mailbox.second,
        selection: { items: 0, folders: 1 },
        fileName: null,
        fileSize: null,
        sha256: null,
        createdAt: expect.any(String),
        completedAt: null,
        expiresAt: null,
        available: false,
        progress: null,
        phase: null,
        actor: { userId: f.anna.userId, name: "Anna", email: "anna@contoso.test" },
        impersonated: false,
        reason: null,
        errorMessage: null,
        report: null,
        failures: [],
      });
    });

    it("describes a completed export with its file, report and expiry", async () => {
      const created = await annasExport();
      const { sha256 } = await complete(created, {
        fileName: "Anna.zip",
        report: {
          messages: 5,
          folders: 2,
          bytes: 999,
          failed: 1,
          skipped: { calendar: 2, contacts: 1, other: 0 },
          items: [{ ref: "mail/Inbox/x.eml", reason: "data missing" }],
        },
      });
      const detail = await service.getExport(appDb, f.tenantId, f.anna, created.id);
      expect(detail).toMatchObject({
        status: "completed",
        fileName: "Anna.zip",
        fileSize: SEGMENT * 2 + 1234,
        sha256,
        available: true,
        completedAt: expect.any(String),
        expiresAt: expect.any(String),
        report: {
          messages: 5,
          folders: 2,
          bytes: 999,
          failed: 1,
          skipped: { calendar: 2, contacts: 1, other: 0 },
          items: [{ ref: "mail/Inbox/x.eml", reason: "data missing" }],
        },
      });
      const listed = await service.listExports(appDb, f.tenantId, f.anna, { limit: 50 });
      expect(listed.find((entry) => entry.id === created.id)).toMatchObject({
        available: true,
        fileName: "Anna.zip",
      });
    });

    it("carries the failure message and the failed items of a failed export", async () => {
      const created = await annasExport();
      await owner
        .update(jobs)
        .set({ status: "failed", errorMessage: "storage target unreachable" })
        .where(eq(jobs.id, created.jobId));
      await owner.insert(itemFailures).values({
        tenantId: f.tenantId,
        jobId: created.jobId,
        itemRef: "mail/Inbox/broken.eml",
        reason: "chunk missing",
        attempts: 2,
      });
      const detail = await service.getExport(appDb, f.tenantId, f.anna, created.id);
      expect(detail).toMatchObject({
        status: "failed",
        available: false,
        errorMessage: "storage target unreachable",
        failures: [{ itemRef: "mail/Inbox/broken.eml", reason: "chunk missing", attempts: 2 }],
      });
    });

    it("shows progress and phase while the export runs", async () => {
      const created = await annasExport();
      await owner
        .update(jobs)
        .set({
          status: "active",
          payload: sql`${jobs.payload} || '{"runtime":{"phase":"writing"}}'::jsonb`,
        })
        .where(eq(jobs.id, created.jobId));
      await owner.insert(jobProgress).values({
        tenantId: f.tenantId,
        jobId: created.jobId,
        total: 10,
        done: 4,
        failed: 1,
        bytes: 4096,
        etaSeconds: 30,
      });
      const detail = await service.getExport(appDb, f.tenantId, f.anna, created.id);
      expect(detail).toMatchObject({
        status: "active",
        phase: "writing",
        progress: { total: 10, done: 4, failed: 1, bytes: 4096, etaSeconds: 30 },
      });
    });

    it("serves the list and the detail over HTTP", async () => {
      const created = await annasExport();
      const list = await http("anna", "GET", "?limit=5");
      expect(list.status).toBe(200);
      const body = (await list.json()) as { items: { id: string }[] };
      expect(body.items.length).toBeLessThanOrEqual(5);
      expect(body.items[0]?.id).toBeTruthy();
      const detail = await http("anna", "GET", `/${created.id}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ id: created.id, status: "queued" });
      expect((await http("anna", "GET", "/not-an-id")).status).toBe(422);
      expect((await http("anna", "GET", `/${randomUUID()}`)).status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe("isolation between tenants", () => {
    it("never shows, cancels or downloads another tenant's export", async () => {
      await expect(
        service.getExport(appDb, f.tenantId, f.admin, fabrikamExport),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.cancelExport(appDb, f.tenantId, actor(f.admin), fabrikamExport),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.openDownload(appDb, f.tenantId, actor(f.admin), fabrikamExport),
      ).rejects.toMatchObject({ status: 404 });
      const list = await service.listExports(appDb, f.tenantId, f.admin, { limit: 50 });
      expect(list.map((entry) => entry.id)).not.toContain(fabrikamExport);
      const other = await service.listExports(appDb, fabrikam, f.admin, { limit: 50 });
      expect(other.map((entry) => entry.id)).toEqual([fabrikamExport]);
    });

    it("cannot export another tenant's snapshot", async () => {
      const [foreign] = await owner
        .select()
        .from(snapshots)
        .where(eq(snapshots.tenantId, fabrikam));
      await expect(
        service.createExport(
          appDb,
          f.tenantId,
          actor(f.admin),
          snapshotRequest({
            snapshotId: foreign?.id,
            selection: [{ path: "" }],
            reason: "Trying my luck",
          }),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("is enforced by the database, not only by the queries", async () => {
      const seen = await withTenantTx(appDb, f.tenantId, (tx) =>
        tx
          .select({ id: mailExports.id })
          .from(mailExports)
          .where(eq(mailExports.id, fabrikamExport)),
      );
      expect(seen).toEqual([]);
      const own = await withTenantTx(appDb, fabrikam, (tx) =>
        tx
          .select({ id: mailExports.id })
          .from(mailExports)
          .where(eq(mailExports.id, fabrikamExport)),
      );
      expect(own).toHaveLength(1);
    });

    it("does not let a member of one tenant reach another through the tenant selector", async () => {
      const res = await http("anna", "GET", "", { tenant: fabrikam });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  describe("cancelling", () => {
    it("cancels a queued export once and audits it", async () => {
      const created = await annasExport();
      const cancelled = await service.cancelExport(appDb, f.tenantId, actor(f.anna), created.id);
      expect(cancelled.status).toBe("cancelled");
      await expect(
        service.cancelExport(appDb, f.tenantId, actor(f.anna), created.id),
      ).rejects.toMatchObject({ status: 409 });
      const [entry] = await auditEntries("export.cancelled", created.id);
      expect(entry).toMatchObject({ targetType: "export_job", actorUserId: f.anna.userId });
      expect(entry?.details).toMatchObject({ previousStatus: "queued", jobId: created.jobId });
    });

    it("cancels a running export, lets an admin cancel somebody else's, and keeps finished ones", async () => {
      const running = await annasExport();
      await owner.update(jobs).set({ status: "active" }).where(eq(jobs.id, running.jobId));
      const cancelled = await service.cancelExport(appDb, f.tenantId, actor(f.admin), running.id);
      expect(cancelled.status).toBe("cancelled");
      const [entry] = await auditEntries("export.cancelled", running.id);
      expect(entry?.details).toMatchObject({ previousStatus: "active" });

      const done = await annasExport();
      await complete(done);
      await expect(
        service.cancelExport(appDb, f.tenantId, actor(f.anna), done.id),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("cancels over HTTP", async () => {
      const created = await annasExport();
      const res = await http("anna", "POST", `/${created.id}/cancel`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: created.id, status: "cancelled" });
      expect((await http("anna", "POST", `/${created.id}/cancel`)).status).toBe(409);
    });
  });

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  describe("downloading", () => {
    it("streams the decrypted file with the right headers", async () => {
      const created = await annasExport();
      const { bytes } = await complete(created, {
        fileName: "Anna Inbox.zip",
        contentType: "application/zip",
      });
      const res = await http("anna", "GET", `/${created.id}/download`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/zip");
      expect(res.headers.get("content-length")).toBe(String(bytes.length));
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-disposition")).toContain('filename="Anna Inbox.zip"');
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    });

    it("takes the tenant from the query parameter, like a plain browser navigation", async () => {
      const created = await annasExport();
      const { bytes } = await complete(created);
      const res = await http("anna", "GET", `/${created.id}/download?tenant=${f.tenantId}`, {
        tenant: null,
      });
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
      expect((await http("anna", "GET", `/${created.id}/download`, { tenant: null })).status).toBe(
        400,
      );
    });

    it("uses the recorded content type, with a per-format fallback", async () => {
      const mbox = await annasExport({ format: "mbox" });
      await complete(mbox, { fileName: "Anna.mbox", contentType: null });
      const res = await http("anna", "GET", `/${mbox.id}/download`);
      expect(res.headers.get("content-type")).toBe("application/mbox");
      await res.arrayBuffer();
    });

    it("records the download before the first byte and names the person whose data it is", async () => {
      const created = await annasExport();
      const { sha256 } = await complete(created);
      const download = await service.openDownload(appDb, f.tenantId, actor(f.anna), created.id);
      // Nothing has been read yet, but the entry is on record.
      const [own] = await auditEntries("export.downloaded", created.id);
      expect(own).toMatchObject({
        tenantId: f.tenantId,
        actorUserId: f.anna.userId,
        targetType: "export_job",
        onBehalfOf: null,
      });
      expect(own?.details).toMatchObject({
        origin: "snapshot",
        format: "eml_zip",
        fileName: "export.zip",
        size: SEGMENT * 2 + 1234,
        sha256,
        snapshotId: f.mailbox.second,
      });
      download.stream.destroy();

      await service
        .openDownload(appDb, f.tenantId, actor(f.admin), created.id)
        .then((d) => d.stream.destroy());
      const entries = await auditEntries("export.downloaded", created.id);
      expect(entries).toHaveLength(2);
      expect(entries.find((entry) => entry.actorUserId === f.admin.userId)?.onBehalfOf).toBe(
        "anna@contoso.test",
      );
    });

    it("streams segment by segment instead of buffering the file", async () => {
      const created = await annasExport();
      const { bytes, segments } = await complete(created, { size: SEGMENT * 5 - 100 });
      expect(segments).toBe(5);
      memory.gets = 0;
      const download = await service.openDownload(appDb, f.tenantId, actor(f.anna), created.id);
      expect(memory.gets).toBe(0);
      const reader = Readable.toWeb(download.stream).getReader();
      const first = await reader.read();
      expect(first.value?.length).toBeGreaterThan(0);
      expect(memory.gets).toBeLessThan(5);
      const parts: Buffer[] = [Buffer.from(first.value as Uint8Array)];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        parts.push(Buffer.from(next.value));
      }
      expect(Buffer.concat(parts).equals(bytes)).toBe(true);
    });

    it("answers 409 until the export has completed", async () => {
      const created = await annasExport();
      const res = await http("anna", "GET", `/${created.id}/download`);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        type: "urn:restow:problem:export-not-ready",
        status: 409,
        jobStatus: "queued",
      });
      await owner.update(jobs).set({ status: "active" }).where(eq(jobs.id, created.jobId));
      expect((await http("anna", "GET", `/${created.id}/download`)).status).toBe(409);
      await owner.update(jobs).set({ status: "failed" }).where(eq(jobs.id, created.jobId));
      expect((await http("anna", "GET", `/${created.id}/download`)).status).toBe(409);
      expect(await auditEntries("export.downloaded", created.id)).toHaveLength(0);
    });

    it("answers 410 once the export expired or its file was purged", async () => {
      const expired = await annasExport();
      await complete(expired, { expiresAt: new Date(Date.now() - 1000) });
      const res = await http("anna", "GET", `/${expired.id}/download`);
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ type: "urn:restow:problem:export-expired" });
      expect((await service.getExport(appDb, f.tenantId, f.anna, expired.id)).available).toBe(
        false,
      );

      const purged = await annasExport();
      await complete(purged, { purgedAt: new Date() });
      expect((await http("anna", "GET", `/${purged.id}/download`)).status).toBe(410);
      expect(await auditEntries("export.downloaded", expired.id)).toHaveLength(0);
      expect(await auditEntries("export.downloaded", purged.id)).toHaveLength(0);
    });

    it("falls back to the configured lifetime when the worker set no expiry", async () => {
      const stale = await annasExport();
      await complete(stale, {
        expiresAt: null,
        completedAt: new Date(Date.now() - 25 * 3600 * 1000),
      });
      expect((await http("anna", "GET", `/${stale.id}/download`)).status).toBe(410);

      const fresh = await annasExport();
      await complete(fresh, { expiresAt: null, completedAt: new Date(Date.now() - 3600 * 1000) });
      const detail = await service.getExport(appDb, f.tenantId, f.anna, fresh.id);
      expect(detail.available).toBe(true);
      expect(Date.parse(detail.expiresAt as string)).toBeGreaterThan(Date.now());
      const res = await http("anna", "GET", `/${fresh.id}/download`);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    });

    it("answers 410 before streaming when the sealed segments are gone from storage", async () => {
      const created = await annasExport();
      await complete(created);
      const key = `tenants/${f.tenantId}/exports/${created.id}/00000001.seg`;
      expect(memory.files.delete(key)).toBe(true);
      const res = await http("anna", "GET", `/${created.id}/download`);
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ type: "urn:restow:problem:export-file-missing" });
      expect(await auditEntries("export.downloaded", created.id)).toHaveLength(0);
    });

    it("refuses a completed export that has no file recorded", async () => {
      const created = await annasExport();
      await owner
        .update(jobs)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(jobs.id, created.jobId));
      await owner
        .update(mailExports)
        .set({ expiresAt: new Date(Date.now() + 3600 * 1000) })
        .where(eq(mailExports.id, created.id));
      expect((await http("anna", "GET", `/${created.id}/download`)).status).toBe(404);
    });

    it("reads a real file through the tenant's storage and key, encrypted at rest", async () => {
      await owner.insert(tenantKeys).values({
        tenantId: f.tenantId,
        keyVersion: 1,
        encryptedDek: wrapDek(kekFromBase64(masterKey), generateDek(1)).toString("base64"),
        kekId: "env:RESTOW_MASTER_KEY",
      });
      const marker = "PLAINTEXT-MARKER-1F3A9C";
      const plain = Buffer.concat([Buffer.from(marker), randomBytes(SEGMENT + 500)]);
      const { segmentStoreFor } = await import("../../lib/segment-store.js");
      const created = await annasExport();
      // Let the real `segmentStoreFor` through: tenant key from the database, local directory.
      segmentOverride.store = null;
      try {
        const real = await segmentStoreFor(appDb, f.tenantId);
        const scope = { tenantId: f.tenantId, kind: "export", id: created.id } as const;
        const written = await real.writeStream(scope, Readable.from([plain]), {
          segmentSize: SEGMENT,
        });
        await owner
          .update(mailExports)
          .set({
            fileName: "real.zip",
            contentType: "application/zip",
            fileSize: written.size,
            segmentSize: written.segmentSize,
            sha256: written.sha256,
            expiresAt: new Date(Date.now() + 3600 * 1000),
          })
          .where(eq(mailExports.id, created.id));
        await owner
          .update(jobs)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(jobs.id, created.jobId));

        const res = await http("anna", "GET", `/${created.id}/download`);
        expect(res.status).toBe(200);
        expect(Buffer.from(await res.arrayBuffer()).equals(plain)).toBe(true);

        const onDisk = await readFile(
          join(storageDir, "tenants", f.tenantId, "exports", created.id, "00000000.seg"),
        );
        expect(onDisk.includes(Buffer.from(marker))).toBe(false);
      } finally {
        segmentOverride.store = store;
      }
    });
  });
});
