/**
 * Postgres-backed tests of the mail file import API (docs/IMPORT.md), through
 * the real routes and middleware: chunked resumable uploads into the encrypted
 * staging area (an in-memory storage target stands in for the tenant's
 * storage), the server-side import folder, import requests (source, imported
 * mailbox, job, queue entry, audit entry in one transaction), the detail
 * view, cancelling, tenant isolation on the RLS-bound application role, and
 * the places that must leave imported mailboxes out of what a tenant protects.
 *
 * The routes run on the provisioned database roles, as in production: the
 * application role that Row Level Security binds and the installation role
 * (src/testing/database-roles.ts). better-auth's session lookup is replaced at
 * its module boundary (same style as features/restore/restore.pg.test.ts).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_imports_test` is recreated there and
 * dropped after, the roles with it). Without it the suite is skipped.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Keyring, type StorageBackend, mailfiles } from "@restow/core";
import {
  type Database,
  auditLog,
  createDb,
  importUploadSegments,
  importUploads,
  itemFailures,
  jobProgress,
  jobs,
  mailImports,
  member,
  organization,
  protectedObjects,
  snapshots,
  sources,
  tenants,
  user,
} from "@restow/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../../problem.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  type ExplorerFixture,
  createExplorerFixture,
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_imports_test";
/** `IMPORT_MAX_STAGING_BYTES` of this suite: room for three files of the largest allowed size. */
const STAGING_LIMIT = 3 * 1024 * 1024;

/** better-auth's session lookup and the tenant's segment store, replaced at their module boundaries. */
const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  storage: null as unknown as StorageBackend,
}));
vi.mock("../../auth.js", () => ({ auth: { api: { getSession: state.getSession } } }));
vi.mock("../../lib/segment-store.js", async () => {
  const core = await import("@restow/core");
  const dek = { version: 1, material: Buffer.alloc(32, 0x5a) };
  return {
    segmentStoreFor: async (_db: unknown, tenantId: string) =>
      new core.mailfiles.SegmentStore({
        storage: state.storage,
        keys: new core.Keyring(tenantId, [dek]),
      }),
  };
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

/** Self-made mail files (packages/core mailfiles/testing builders, not part of its API). */
const builders = await vi.importActual<{
  buildEml: (options: {
    from: string;
    to: string;
    subject: string;
    body: string;
  }) => Buffer;
  buildMbox: (messages: readonly Buffer[]) => Buffer;
  buildZip: (entries: readonly { name: string; data?: string }[]) => Promise<Buffer>;
}>("../../../../../packages/core/src/mailfiles/testing/builders.js");

function eml(subject: string, filler = 200): Buffer {
  return builders.buildEml({
    from: "Ada Example <ada@example.test>",
    to: "bob@example.test",
    subject,
    body: `${subject}\n${"lorem ipsum dolor sit amet ".repeat(filler / 27)}`,
  });
}

/** An MBOX of about 150 KiB: three segments of 64 KiB. */
function bigMbox(): Buffer {
  const messages = Array.from({ length: 150 }, (_, index) => eml(`Message ${index}`, 900));
  return builders.buildMbox(messages);
}

const SMALL_EML = eml("Hello");
const SMALL_MBOX = builders.buildMbox([eml("First"), eml("Second")]);
const PST_BYTES = Buffer.concat([Buffer.from("!BDN"), randomBytes(700)]);
const NOTES_BYTES = Buffer.from("just some notes\nnothing else in here\n");

class MemoryBackend implements StorageBackend {
  readonly files = new Map<string, Buffer>();
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
    const found = this.files.get(key);
    if (!found) {
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
    }
    return Buffer.from(found);
  }
  async getStream(key: string): Promise<Readable> {
    return Readable.from([await this.get(key)]);
  }
  async head(key: string) {
    const found = this.files.get(key);
    return found ? { size: found.length } : null;
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
  keysUnder(prefix: string): string[] {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix));
  }
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

type Who = "adminA" | "memberA" | "adminB" | "provider";

interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code?: string;
  entries?: unknown[];
  missing?: number[];
  [key: string]: unknown;
}

describe.skipIf(!testDatabaseAdminUrl)(
  "mail file import against Postgres",
  { timeout: 30_000 },
  () => {
    let owner: Database;
    let appDb: Database;
    let roles: TestDatabaseRoles;
    let f: ExplorerFixture;
    let tenantA: string;
    let tenantB: string;
    let tenantC: string;
    let httpApp: Hono;
    let memory: MemoryBackend;
    let importDir: string;
    let slugA: string;
    let slugB: string;
    let slugC: string;
    let tenantFolderA: string;
    let outsideDir: string;
    let scratch: string;
    let userIds: Record<Who, string>;
    // Loaded after the environment is set (config and the shared handles read it on import).
    let service: typeof import("./service.js");
    let appConfig: typeof import("../../config.js").config;

    // -------------------------------------------------------------------------
    // HTTP helpers
    // -------------------------------------------------------------------------

    function signIn(who: Who): void {
      const isProvider = who === "provider";
      state.getSession.mockResolvedValue({
        session: {
          id: `session-${who}`,
          userId: userIds[who],
          activeOrganizationId: null,
          authMethod: "passkey",
          impersonatedBy: null,
        },
        user: {
          id: userIds[who],
          email: `${who}@example.test`,
          name: who,
          role: isProvider ? "admin" : "user",
          banned: false,
          twoFactorEnabled: true,
        },
      });
    }

    interface CallOptions {
      who?: Who;
      tenant?: string;
      json?: unknown;
      body?: Buffer;
      headers?: Record<string, string>;
    }

    async function call(
      method: string,
      path: string,
      options: CallOptions = {},
    ): Promise<Response> {
      signIn(options.who ?? "provider");
      const headers: Record<string, string> = {
        "x-restow-tenant": options.tenant ?? tenantA,
        ...(options.json !== undefined ? { "content-type": "application/json" } : {}),
        ...options.headers,
      };
      const body =
        options.json !== undefined ? JSON.stringify(options.json) : (options.body ?? undefined);
      return httpApp.request(`/imports${path}`, { method, headers, body });
    }

    async function json<T>(response: Response): Promise<T> {
      return (await response.json()) as T;
    }

    interface UploadDto {
      id: string;
      fileName: string;
      size: number;
      segmentSize: number;
      segmentCount: number;
      status: string;
      receivedSegments: number[];
      detectedFormat: string | null;
      refusal: { code: string; message: string } | null;
      expiresAt: string;
    }

    async function createUpload(
      fileName: string,
      size: number,
      options: CallOptions = {},
    ): Promise<UploadDto> {
      const response = await call("POST", "/uploads", { ...options, json: { fileName, size } });
      expect(response.status).toBe(201);
      return json<UploadDto>(response);
    }

    function segmentOf(bytes: Buffer, upload: UploadDto, index: number): Buffer {
      return bytes.subarray(index * upload.segmentSize, (index + 1) * upload.segmentSize);
    }

    function putSegment(
      upload: { id: string },
      index: number,
      bytes: Buffer,
      options: CallOptions & { sha?: string | null; contentType?: string } = {},
    ): Promise<Response> {
      const sha = options.sha === undefined ? sha256(bytes) : options.sha;
      return call("PUT", `/uploads/${upload.id}/segments/${index}`, {
        ...options,
        body: bytes,
        headers: {
          "content-type": options.contentType ?? "application/octet-stream",
          ...(sha === null ? {} : { "x-segment-sha256": sha }),
          ...options.headers,
        },
      });
    }

    /** Create, send every segment, complete. */
    async function uploadWhole(
      fileName: string,
      bytes: Buffer,
      options: CallOptions = {},
    ): Promise<UploadDto> {
      const upload = await createUpload(fileName, bytes.length, options);
      for (let index = 0; index < upload.segmentCount; index++) {
        const response = await putSegment(upload, index, segmentOf(bytes, upload, index), options);
        expect(response.status).toBe(200);
      }
      const done = await call("POST", `/uploads/${upload.id}/complete`, options);
      expect(done.status).toBe(200);
      return json<UploadDto>(done);
    }

    interface CreatedImport {
      id: string;
      jobId: string;
      objectId: string;
      sourceId: string;
    }

    async function requestImport(body: unknown, options: CallOptions = {}): Promise<Response> {
      return call("POST", "", { ...options, json: body });
    }

    async function importOk(body: unknown, options: CallOptions = {}): Promise<CreatedImport> {
      const response = await requestImport(body, options);
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(202);
      return json<CreatedImport>(response);
    }

    async function problem(response: Response, status: number): Promise<Problem> {
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      return json<Problem>(response);
    }

    async function auditActions(tenantId: string, target: string): Promise<string[]> {
      const rows = await owner
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.target, target)))
        .orderBy(asc(auditLog.createdAt));
      return rows.map((row) => row.action);
    }

    /** What the worker would leave behind while and after an import runs. */
    async function simulateWorker(
      created: CreatedImport,
      patch: {
        status: "active" | "completed" | "failed";
        phase?: string;
        live?: Record<string, number>;
        progress?: { total: number; done: number; failed: number; bytes: number };
        errorMessage?: string;
        report?: Record<string, unknown>;
      },
    ): Promise<void> {
      const [job] = await owner.select().from(jobs).where(eq(jobs.id, created.jobId));
      const payload = {
        ...(job?.payload ?? {}),
        ...(patch.phase
          ? { runtime: { phase: patch.phase, phaseSince: new Date().toISOString() } }
          : {}),
        ...(patch.live ? { importLive: patch.live } : {}),
      };
      await owner
        .update(jobs)
        .set({
          status: patch.status,
          payload,
          startedAt: new Date(),
          errorMessage: patch.errorMessage ?? null,
          completedAt: patch.status === "active" ? null : new Date(),
        })
        .where(eq(jobs.id, created.jobId));
      if (patch.progress) {
        await owner
          .insert(jobProgress)
          .values({ tenantId: tenantOf(created), jobId: created.jobId, ...patch.progress })
          .onConflictDoUpdate({ target: jobProgress.jobId, set: patch.progress });
      }
      if (patch.report) {
        await owner
          .update(mailImports)
          .set({ report: patch.report })
          .where(eq(mailImports.id, created.id));
      }
    }

    const tenantByImport = new Map<string, string>();
    function tenantOf(created: CreatedImport): string {
      return tenantByImport.get(created.id) ?? tenantA;
    }

    // -------------------------------------------------------------------------
    // Fixture
    // -------------------------------------------------------------------------

    /** Fill the import folder (needs the tenant slugs). */
    async function populateFolders(): Promise<void> {
      // The server-side import folder: one subdirectory per tenant, named by its slug.
      mkdirSync(tenantFolderA, { recursive: true });
      mkdirSync(join(tenantFolderA, "mail"));
      writeFileSync(join(tenantFolderA, "mail", "a.eml"), SMALL_EML);
      writeFileSync(join(tenantFolderA, "mail", "b.mbox"), SMALL_MBOX);
      writeFileSync(join(tenantFolderA, "mail", "x.pst"), PST_BYTES);
      writeFileSync(join(tenantFolderA, "notes.txt"), NOTES_BYTES);
      mkdirSync(join(tenantFolderA, "MailStore", "2019"), { recursive: true });
      writeFileSync(join(tenantFolderA, "MailStore", "2019", "1.eml"), eml("Old one"));
      writeFileSync(join(tenantFolderA, "MailStore", "2019", "2.eml"), eml("Old two"));
      mkdirSync(join(tenantFolderA, "zips"));
      writeFileSync(
        join(tenantFolderA, "zips", "archive.zip"),
        await builders.buildZip([{ name: "Inbox/one.eml", data: SMALL_EML.toString("latin1") }]),
      );
      symlinkSync(outsideDir, join(tenantFolderA, "link-to-outside"));
      symlinkSync(
        join(outsideDir, "secret.eml"),
        join(tenantFolderA, "mail", "link-to-secret.eml"),
      );
      mkdirSync(join(tenantFolderA, "many"));
      for (let index = 0; index < 2003; index++) {
        writeFileSync(
          join(tenantFolderA, "many", `f${String(index).padStart(4, "0")}.eml`),
          "Subject: x\n\nhi\n",
        );
      }

      // Links inside tenant A's folder that lead to its sibling tenant B and out of the import folder.
      symlinkSync(join(importDir, slugB), join(tenantFolderA, "link-to-b"));
      symlinkSync(
        join(importDir, slugB, "secret-b.eml"),
        join(tenantFolderA, "mail", "link-to-b-file.eml"),
      );
      // Tenant B's own files, and a stray file next to the tenant folders that nobody can reach.
      mkdirSync(join(importDir, slugB, "b-only"), { recursive: true });
      writeFileSync(join(importDir, slugB, "secret-b.eml"), eml("Only for B"));
      writeFileSync(join(importDir, slugB, "b-only", "inbox.eml"), eml("B inbox"));
      writeFileSync(join(importDir, "stray.eml"), SMALL_EML);
    }

    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), "restow-imports-"));
      importDir = join(scratch, "import");
      outsideDir = join(scratch, "outside");
      mkdirSync(importDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "secret.eml"), SMALL_EML);

      const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
      roles = await provisionTestRoles(url);
      // The API's shared handles and configuration read the environment on import.
      process.env.DATABASE_URL = roles.appUrl;
      process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
      process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
      process.env.IMPORT_DIR = importDir;
      process.env.IMPORT_MAX_FILE_BYTES = String(1024 * 1024);
      process.env.IMPORT_MAX_STAGING_BYTES = String(STAGING_LIMIT);
      process.env.IMPORT_SEGMENT_BYTES = "65536";
      process.env.STORAGE_TARGET = "local";
      process.env.STORAGE_LOCAL_PATH = join(scratch, "storage");
      memory = new MemoryBackend();
      state.storage = memory;

      // pg-boss creates its schema as the installation role; the application role enqueues into it.
      const boss = new PgBoss({ connectionString: roles.providerUrl });
      await boss.start();
      // The worker's policy: at most one queued and one active import per imported mailbox.
      await boss.createQueue("import", { name: "import", policy: "stately" });
      await boss.stop({ graceful: false, wait: true });

      owner = createDb(url);
      appDb = createDb(roles.appUrl);
      f = await createExplorerFixture(owner);
      tenantA = f.tenantId;

      const [provider] = await owner.select().from(tenants).where(eq(tenants.id, tenantA));
      const providerId = provider?.providerId as string;
      slugB = `fabrikam-${randomUUID().slice(0, 8)}`;
      slugC = `northwind-${randomUUID().slice(0, 8)}`;
      tenantB = one(
        await owner
          .insert(tenants)
          .values({ providerId, name: "Fabrikam", slug: slugB })
          .returning(),
      ).id;
      tenantC = one(
        await owner
          .insert(tenants)
          .values({ providerId, name: "Northwind", slug: slugC })
          .returning(),
      ).id;

      slugA = provider?.slug as string;
      tenantFolderA = join(importDir, slugA);
      await populateFolders();

      const now = new Date();
      for (const [id, tenantId] of [
        ["org-a", tenantA],
        ["org-b", tenantB],
      ] as const) {
        await owner.insert(organization).values({ id, name: id, slug: id, createdAt: now });
        await owner.update(tenants).set({ organizationId: id }).where(eq(tenants.id, tenantId));
      }
      userIds = {
        adminA: randomUUID(),
        memberA: randomUUID(),
        adminB: randomUUID(),
        provider: randomUUID(),
      };
      for (const [who, id] of Object.entries(userIds)) {
        await owner
          .insert(user)
          .values({ id, name: who, email: `${who}@example.test`, emailVerified: true });
      }
      await owner.insert(member).values([
        {
          id: randomUUID(),
          organizationId: "org-a",
          userId: userIds.adminA,
          role: "admin",
          createdAt: now,
        },
        {
          id: randomUUID(),
          organizationId: "org-a",
          userId: userIds.memberA,
          role: "member",
          createdAt: now,
        },
        {
          id: randomUUID(),
          organizationId: "org-b",
          userId: userIds.adminB,
          role: "admin",
          createdAt: now,
        },
      ]);

      service = await import("./service.js");
      appConfig = (await import("../../config.js")).config;
      const { importsRoutes } = await import("./routes.js");
      httpApp = new Hono();
      httpApp.onError(errorHandler);
      httpApp.notFound(notFoundHandler);
      httpApp.route("/imports", importsRoutes);
    }, 90_000);

    afterAll(async () => {
      const shared = await import("../../db.js");
      await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
      await Promise.all([owner?.$client.end(), appDb?.$client.end()]);
      await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
      await roles?.drop(testDatabaseAdminUrl as string);
      rmSync(scratch, { recursive: true, force: true });
    }, 60_000);

    // -------------------------------------------------------------------------
    // Configuration and the server-side folder
    // -------------------------------------------------------------------------

    describe("configuration", () => {
      it("reports the limits, the formats and the import folder", async () => {
        const response = await call("GET", "/config");
        expect(response.status).toBe(200);
        expect(await json(response)).toEqual({
          uploadEnabled: true,
          maxFileBytes: 1024 * 1024,
          segmentSize: 65536,
          uploadExpiresHours: 48,
          folder: { enabled: true, exists: true, path: join(importDir, slugA) },
          supportedFormats: ["eml", "msg", "mbox", "zip"],
          refusedFormats: ["pst"],
        });
      });

      it("needs the tenant_admin role", async () => {
        expect((await call("GET", "/config", { who: "memberA" })).status).toBe(403);
        expect(
          (
            await call("POST", "/uploads", {
              who: "memberA",
              json: { fileName: "a.eml", size: 10 },
            })
          ).status,
        ).toBe(403);
        expect((await call("GET", "/config", { who: "adminA" })).status).toBe(200);
        // A member of another tenant learns nothing about this one.
        expect((await call("GET", "/config", { who: "adminB", tenant: tenantA })).status).toBe(404);
      });

      it("reports the folder as disabled when the directory is missing", async () => {
        const before = appConfig.imports.dir;
        appConfig.imports.dir = join(scratch, "does-not-exist");
        try {
          const config = await json<{ folder: Record<string, unknown> }>(
            await call("GET", "/config"),
          );
          expect(config.folder).toEqual({
            enabled: false,
            exists: false,
            path: join(scratch, "does-not-exist", slugA),
          });
          const listing = await json<Record<string, unknown>>(await call("GET", "/folder"));
          expect(listing).toMatchObject({
            enabled: false,
            exists: false,
            current: "",
            entries: [],
          });
          const refused = await problem(
            await requestImport({ name: "x", files: [{ origin: "folder", path: "mail/a.eml" }] }),
            422,
          );
          expect(refused.type).toBe("urn:restow:problem:import-folder-unavailable");
        } finally {
          appConfig.imports.dir = before;
        }
      });
    });

    describe("server-side import folder", () => {
      interface Listing {
        enabled: boolean;
        exists: boolean;
        path: string;
        current: string;
        truncated: boolean;
        entries: {
          name: string;
          path: string;
          type: string;
          size: number | null;
          modifiedAt: string;
          format: string | null;
          supported: boolean;
        }[];
      }

      it("lists one level, sniffs files by content and never follows links out of the folder", async () => {
        const listing = await json<Listing>(await call("GET", "/folder"));
        expect(listing).toMatchObject({
          enabled: true,
          exists: true,
          path: join(importDir, slugA),
          current: "",
          truncated: false,
        });
        expect(listing.entries.map((entry) => entry.name)).toEqual([
          "MailStore",
          "mail",
          "many",
          "notes.txt",
          "zips",
        ]);
        const notes = listing.entries.find((entry) => entry.name === "notes.txt");
        expect(notes).toMatchObject({
          type: "file",
          path: "notes.txt",
          size: NOTES_BYTES.length,
          format: "unknown",
          supported: false,
        });
        const directory = listing.entries.find((entry) => entry.name === "MailStore");
        expect(directory).toMatchObject({
          type: "directory",
          size: null,
          format: null,
          supported: true,
        });
        expect(Number.isNaN(Date.parse(notes?.modifiedAt ?? ""))).toBe(false);
      });

      it("judges files by their bytes, not their names", async () => {
        const listing = await json<Listing>(await call("GET", "/folder?path=mail"));
        expect(listing.current).toBe("mail");
        const byName = Object.fromEntries(listing.entries.map((entry) => [entry.name, entry]));
        expect(byName["a.eml"]).toMatchObject({
          format: "eml",
          supported: true,
          path: "mail/a.eml",
        });
        expect(byName["b.mbox"]).toMatchObject({ format: "mbox", supported: true });
        expect(byName["x.pst"]).toMatchObject({ format: "pst", supported: false });
        // A link that points out of the folder is not listed at all.
        expect(byName["link-to-secret.eml"]).toBeUndefined();
        const zips = await json<Listing>(await call("GET", "/folder?path=zips"));
        expect(zips.entries[0]).toMatchObject({
          name: "archive.zip",
          format: "zip",
          supported: true,
        });
      });

      it("refuses paths that leave the folder or do not exist", async () => {
        for (const path of [
          "..",
          "mail/../..",
          "%2e%2e%2f",
          "link-to-outside",
          // A sibling tenant's folder, by path and through a link inside this tenant's folder.
          `../${slugB}`,
          `../${slugB}/b-only`,
          "link-to-b",
          "link-to-b/b-only",
        ]) {
          const refused = await call("GET", `/folder?path=${encodeURIComponent(path)}`);
          expect([404, 422], path).toContain(refused.status);
          const body = await json<Problem>(refused);
          expect(body.type).toMatch(/^urn:restow:problem:import-folder-path-/);
        }
        expect((await call("GET", "/folder?path=nope")).status).toBe(404);
        const notADirectory = await problem(await call("GET", "/folder?path=notes.txt"), 422);
        expect(notADirectory.type).toBe("urn:restow:problem:import-folder-path-invalid");
      });

      it("lists at most 2000 entries of a directory and says so", async () => {
        const listing = await json<Listing>(await call("GET", "/folder?path=many"));
        expect(listing.entries).toHaveLength(2000);
        expect(listing.truncated).toBe(true);
        expect(listing.entries[0]?.name).toBe("f0000.eml");
        expect(listing.entries.every((entry) => entry.format === "eml")).toBe(true);
      });
    });

    describe("a tenant's own import folder", () => {
      interface TenantListing {
        enabled: boolean;
        exists: boolean;
        path: string;
        current: string;
        entries: { name: string; path: string }[];
      }
      const forB = () => ({ who: "adminB" as const, tenant: tenantB });
      const forC = () => ({ who: "provider" as const, tenant: tenantC });

      it("is the subdirectory named by the tenant's slug, and config and listing show it", async () => {
        const config = await json<{ folder: Record<string, unknown> }>(
          await call("GET", "/config", forB()),
        );
        expect(config.folder).toEqual({
          enabled: true,
          exists: true,
          path: join(importDir, slugB),
        });
        const listing = await json<TenantListing>(await call("GET", "/folder", forB()));
        expect(listing).toMatchObject({
          enabled: true,
          exists: true,
          path: join(importDir, slugB),
        });
        // Entry paths are relative to the tenant's folder, and nothing of tenant A or the stray file shows.
        expect(listing.entries.map((entry) => entry.path)).toEqual(["b-only", "secret-b.eml"]);
        const nested = await json<TenantListing>(await call("GET", "/folder?path=b-only", forB()));
        expect(nested.current).toBe("b-only");
        expect(nested.entries.map((entry) => entry.path)).toEqual(["b-only/inbox.eml"]);
      });

      it("keeps tenant A's files out of reach of tenant B, by any spelling", async () => {
        expect((await call("GET", "/folder?path=mail", forB())).status).toBe(404);
        for (const path of [`../${slugA}/mail`, `../${slugA}`]) {
          const refused = await problem(
            await call("GET", `/folder?path=${encodeURIComponent(path)}`, forB()),
            422,
          );
          expect(refused.type).toBe("urn:restow:problem:import-folder-path-invalid");
        }
        for (const [path, status, type] of [
          ["mail/a.eml", 422, "urn:restow:problem:import-folder-path-unknown"],
          // The stored form (with the slug prefix) is not a way in either.
          [`${slugA}/mail/a.eml`, 422, "urn:restow:problem:import-folder-path-unknown"],
          [`../${slugA}/mail/a.eml`, 422, "urn:restow:problem:import-folder-path-invalid"],
          [`../${slugA}/MailStore`, 422, "urn:restow:problem:import-folder-path-invalid"],
        ] as const) {
          const refused = await problem(
            await requestImport({ name: "Not mine", files: [{ origin: "folder", path }] }, forB()),
            status,
          );
          expect(refused.type, path).toBe(type);
        }
        const none = await owner
          .select()
          .from(mailImports)
          .where(eq(mailImports.tenantId, tenantB));
        expect(none).toEqual([]);
      });

      it("keeps tenant B's files out of reach of tenant A, also through links inside A's folder", async () => {
        for (const path of [
          `../${slugB}/secret-b.eml`,
          "link-to-b/secret-b.eml",
          "link-to-b",
          "mail/link-to-b-file.eml",
        ]) {
          const refused = await problem(
            await requestImport({ name: "Not mine", files: [{ origin: "folder", path }] }),
            422,
          );
          expect(refused.type, path).toBe("urn:restow:problem:import-folder-path-invalid");
        }
        // The links are not even listed.
        const listing = await json<TenantListing>(await call("GET", "/folder"));
        expect(listing.entries.map((entry) => entry.name)).not.toContain("link-to-b");
        const mail = await json<TenantListing>(await call("GET", "/folder?path=mail"));
        expect(mail.entries.map((entry) => entry.name)).not.toContain("link-to-b-file.eml");
      });

      it("stores folder paths below the tenant's slug and shows them relative to it again", async () => {
        const created = await importOk(
          {
            name: "B's own mail",
            files: [
              { origin: "folder", path: "secret-b.eml" },
              { origin: "folder", path: "b-only" },
            ],
          },
          forB(),
        );
        const [row] = await owner.select().from(mailImports).where(eq(mailImports.id, created.id));
        expect(row?.files.map((file) => file.path)).toEqual([
          `${slugB}/secret-b.eml`,
          `${slugB}/b-only`,
        ]);
        const detail = await json<{ files: { path: string }[] }>(
          await call("GET", `/${created.id}`, forB()),
        );
        expect(detail.files.map((file) => file.path)).toEqual(["secret-b.eml", "b-only"]);
        const [entry] = await owner
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.action, "import.requested"), eq(auditLog.target, created.id)));
        expect(entry?.details).toMatchObject({
          files: [{ path: `${slugB}/secret-b.eml` }, { path: `${slugB}/b-only` }],
        });
      });

      it("takes the whole tenant folder as one selection, stored as '<slug>/'", async () => {
        const created = await importOk(
          { name: "Everything in B's folder", files: [{ origin: "folder", path: "" }] },
          { who: "provider", tenant: tenantB },
        );
        // B still has an import into another mailbox only; this one is new.
        const [row] = await owner.select().from(mailImports).where(eq(mailImports.id, created.id));
        expect(row?.files).toEqual([
          { origin: "folder", kind: "directory", path: `${slugB}/`, size: 0, format: null },
        ]);
        const detail = await json<{ files: { path: string }[] }>(
          await call("GET", `/${created.id}`, forB()),
        );
        expect(detail.files[0]?.path).toBe("");
      });

      it("reports a tenant without a folder as such: empty listing, no import from it", async () => {
        const config = await json<{ folder: Record<string, unknown> }>(
          await call("GET", "/config", forC()),
        );
        expect(config.folder).toEqual({
          enabled: true,
          exists: false,
          path: join(importDir, slugC),
        });
        expect(await json(await call("GET", "/folder", forC()))).toEqual({
          enabled: true,
          exists: false,
          path: join(importDir, slugC),
          current: "",
          entries: [],
          truncated: false,
        });
        const refused = await problem(
          await requestImport(
            { name: "Nothing there", files: [{ origin: "folder", path: "a.eml" }] },
            forC(),
          ),
          422,
        );
        expect(refused.type).toBe("urn:restow:problem:import-folder-unavailable");
        expect(refused.detail).toContain("Create it inside the import folder");
      });

      it("does not accept a tenant folder that is a link to another tenant's folder", async () => {
        const link = join(importDir, slugC);
        symlinkSync(join(importDir, slugB), link);
        try {
          const config = await json<{ folder: { exists: boolean } }>(
            await call("GET", "/config", forC()),
          );
          expect(config.folder.exists).toBe(false);
          expect(await json(await call("GET", "/folder", forC()))).toMatchObject({
            exists: false,
            entries: [],
          });
          const refused = await problem(
            await requestImport(
              { name: "Borrowed", files: [{ origin: "folder", path: "secret-b.eml" }] },
              forC(),
            ),
            422,
          );
          expect(refused.type).toBe("urn:restow:problem:import-folder-unavailable");
        } finally {
          rmSync(link, { force: true });
        }
      });
    });

    // -------------------------------------------------------------------------
    // Uploads
    // -------------------------------------------------------------------------

    describe("uploads", () => {
      it("creates an upload and audits it", async () => {
        const upload = await createUpload("archive.mbox", 150_000);
        expect(upload).toMatchObject({
          fileName: "archive.mbox",
          size: 150_000,
          segmentSize: 65536,
          segmentCount: 3,
          status: "uploading",
          receivedSegments: [],
          detectedFormat: null,
          refusal: null,
        });
        const expires = Date.parse(upload.expiresAt) - Date.now();
        expect(expires).toBeGreaterThan(47 * 3_600_000);
        expect(expires).toBeLessThanOrEqual(48 * 3_600_000);
        expect(await auditActions(tenantA, upload.id)).toEqual(["import.upload.created"]);
        const [entry] = await owner.select().from(auditLog).where(eq(auditLog.target, upload.id));
        expect(entry).toMatchObject({
          targetType: "import_upload",
          details: { fileName: "archive.mbox", size: 150_000, segmentCount: 3 },
        });
      });

      it("refuses an empty file, a bad name and a file over the limit", async () => {
        expect(
          (await call("POST", "/uploads", { json: { fileName: "a.eml", size: 0 } })).status,
        ).toBe(422);
        for (const fileName of ["", "../a.eml", "dir/a.eml", "a\u0000.eml"]) {
          expect(
            (await call("POST", "/uploads", { json: { fileName, size: 10 } })).status,
            fileName,
          ).toBe(422);
        }
        const tooLarge = await problem(
          await call("POST", "/uploads", { json: { fileName: "big.zip", size: 1024 * 1024 + 1 } }),
          413,
        );
        expect(tooLarge.type).toBe("urn:restow:problem:import-file-too-large");
        expect(tooLarge.maxFileBytes).toBe(1024 * 1024);
      });

      it("takes the segments in any order, resumes and accepts a retry of an index", async () => {
        const bytes = bigMbox();
        expect(bytes.length).toBeGreaterThan(2 * 65536);
        const upload = await createUpload("big.mbox", bytes.length);
        expect(upload.segmentCount).toBe(3);

        const second = await putSegment(upload, 2, segmentOf(bytes, upload, 2));
        expect(second.status).toBe(200);
        expect(await json(second)).toEqual({
          index: 2,
          size: bytes.length - 2 * 65536,
          sha256: sha256(segmentOf(bytes, upload, 2)),
          receivedCount: 1,
        });
        expect((await putSegment(upload, 0, segmentOf(bytes, upload, 0))).status).toBe(200);
        // The same index again replaces it and does not count twice.
        const retry = await json<{ receivedCount: number }>(
          await putSegment(upload, 0, segmentOf(bytes, upload, 0)),
        );
        expect(retry.receivedCount).toBe(2);

        // A resume asks which segments are there.
        const resumed = await json<UploadDto>(await call("GET", `/uploads/${upload.id}`));
        expect(resumed.receivedSegments).toEqual([0, 2]);
        expect(resumed.status).toBe("uploading");
        const listed = await json<{ items: UploadDto[] }>(await call("GET", "/uploads"));
        expect(listed.items.find((item) => item.id === upload.id)?.receivedSegments).toEqual([
          0, 2,
        ]);

        // Completing with a gap lists what is missing.
        const gap = await problem(await call("POST", `/uploads/${upload.id}/complete`), 409);
        expect(gap.type).toBe("urn:restow:problem:import-segments-missing");
        expect(gap.missing).toEqual([1]);

        expect((await putSegment(upload, 1, segmentOf(bytes, upload, 1))).status).toBe(200);
        const done = await json<UploadDto>(await call("POST", `/uploads/${upload.id}/complete`));
        expect(done).toMatchObject({
          status: "ready",
          detectedFormat: "mbox",
          refusal: null,
          receivedSegments: [0, 1, 2],
        });
        // Completing again answers the same.
        expect(await json(await call("POST", `/uploads/${upload.id}/complete`))).toEqual(done);

        // The staged segments are sealed, and reading them back yields exactly the file.
        const prefix = `tenants/${tenantA}/staging/${upload.id}/`;
        const keys = memory.keysUnder(prefix);
        expect(keys).toHaveLength(3);
        for (const key of keys) {
          expect(memory.files.get(key)?.includes(Buffer.from("Message 5"))).toBe(false);
        }
        const { segmentStoreFor } = await import("../../lib/segment-store.js");
        const store = await segmentStoreFor(appDb, tenantA);
        const chunks: Buffer[] = [];
        for await (const part of store.readStream(
          { tenantId: tenantA, kind: "staging", id: upload.id },
          { size: bytes.length, segmentSize: 65536 },
        )) {
          chunks.push(part as Buffer);
        }
        expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
        expect(await auditActions(tenantA, upload.id)).toEqual([
          "import.upload.created",
          "import.upload.completed",
        ]);
      });

      it("checks the size of every segment, early and while reading", async () => {
        const upload = await createUpload("a.eml", 100_000);
        const full = randomBytes(65536);
        // Declared too large: refused before a byte is read.
        const declared = await problem(
          await putSegment(upload, 0, full, { headers: { "content-length": "999999" } }),
          413,
        );
        expect(declared.type).toBe("urn:restow:problem:import-segment-too-large");
        // Larger than the segment without a declared length: cut off while reading.
        const streamed = await problem(await putSegment(upload, 0, randomBytes(65536 + 5000)), 413);
        expect(streamed.type).toBe("urn:restow:problem:import-segment-too-large");
        // Too small (the first segment must be full, the last one carries the remainder).
        const small = await problem(await putSegment(upload, 0, randomBytes(1000)), 422);
        expect(small.type).toBe("urn:restow:problem:import-segment-size-mismatch");
        const lastTooBig = await problem(await putSegment(upload, 1, full), 413);
        expect(lastTooBig.type).toBe("urn:restow:problem:import-segment-too-large");
        const outOfRange = await problem(await putSegment(upload, 2, full), 422);
        expect(outOfRange.type).toBe("urn:restow:problem:import-segment-out-of-range");
        // Nothing was stored or recorded.
        expect(memory.keysUnder(`tenants/${tenantA}/staging/${upload.id}/`)).toEqual([]);
        const dto = await json<UploadDto>(await call("GET", `/uploads/${upload.id}`));
        expect(dto.receivedSegments).toEqual([]);
      });

      it("verifies X-Segment-Sha256 when it is sent", async () => {
        const upload = await createUpload("a.eml", 1000);
        const bytes = randomBytes(1000);
        const wrong = await problem(
          await putSegment(upload, 0, bytes, { sha: sha256(randomBytes(4)) }),
          422,
        );
        expect(wrong.type).toBe("urn:restow:problem:import-segment-corrupt");
        expect((await putSegment(upload, 0, bytes, { sha: "not-a-hash" })).status).toBe(422);
        expect(
          (await json<UploadDto>(await call("GET", `/uploads/${upload.id}`))).receivedSegments,
        ).toEqual([]);
        // Uppercase hex is fine, and the header is optional.
        expect(
          (await putSegment(upload, 0, bytes, { sha: sha256(bytes).toUpperCase() })).status,
        ).toBe(200);
        expect((await putSegment(upload, 0, bytes, { sha: null })).status).toBe(200);
      });

      it("takes raw bytes only on the segment route, and only from the app itself", async () => {
        const upload = await createUpload("a.eml", 100);
        const bytes = randomBytes(100);
        const text = await problem(
          await putSegment(upload, 0, bytes, { contentType: "text/plain" }),
          415,
        );
        expect(text.type).toBe("urn:restow:problem:unsupported-media-type");
        const crossSite = await problem(
          await putSegment(upload, 0, bytes, { headers: { "sec-fetch-site": "cross-site" } }),
          403,
        );
        expect(crossSite.type).toBe("urn:restow:problem:cross-site-request");
        // Every other route still wants JSON.
        const other = await call("POST", "/uploads", {
          headers: { "content-type": "application/octet-stream", "content-length": "5" },
          body: Buffer.from("hello"),
        });
        expect(other.status).toBe(415);
        expect(
          (await putSegment(upload, 0, bytes, { headers: { "sec-fetch-site": "same-origin" } }))
            .status,
        ).toBe(200);
      });

      it("recognises a PST or an unknown file at completion and keeps it as ready with the reason", async () => {
        const pst = await uploadWhole("mailbox.pst", PST_BYTES);
        expect(pst).toMatchObject({ status: "ready", detectedFormat: "pst" });
        expect(pst.refusal).toEqual({
          code: "pst_not_supported",
          message:
            "PST and OST import is planned for a later release. Export the mailbox from Outlook as .msg or .eml files (or convert it to MBOX) and import those.",
        });
        const notes = await uploadWhole("notes.eml", NOTES_BYTES);
        expect(notes).toMatchObject({ status: "ready", detectedFormat: "unknown" });
        expect(notes.refusal).toEqual({
          code: "unrecognised",
          message: "The file is not a recognised mail file (EML, MSG, MBOX or ZIP).",
        });
        const good = await uploadWhole("a.eml", SMALL_EML);
        expect(good).toMatchObject({ detectedFormat: "eml", refusal: null });
      });

      it("cancels an upload, deletes its segments and ends further uploads to it", async () => {
        const bytes = bigMbox();
        const upload = await createUpload("big.mbox", bytes.length);
        await putSegment(upload, 0, segmentOf(bytes, upload, 0));
        const prefix = `tenants/${tenantA}/staging/${upload.id}/`;
        expect(memory.keysUnder(prefix)).toHaveLength(1);

        expect((await call("DELETE", `/uploads/${upload.id}`)).status).toBe(204);
        expect(memory.keysUnder(prefix)).toEqual([]);
        const dto = await json<UploadDto>(await call("GET", `/uploads/${upload.id}`));
        expect(dto).toMatchObject({ status: "cancelled", receivedSegments: [] });
        const rows = await owner
          .select()
          .from(importUploadSegments)
          .where(eq(importUploadSegments.uploadId, upload.id));
        expect(rows).toEqual([]);
        expect(await auditActions(tenantA, upload.id)).toEqual([
          "import.upload.created",
          "import.upload.cancelled",
        ]);

        const late = await problem(await putSegment(upload, 1, segmentOf(bytes, upload, 1)), 409);
        expect(late.type).toBe("urn:restow:problem:import-upload-not-open");
        expect(memory.keysUnder(prefix)).toEqual([]);
        // Cancelling again is harmless and not audited twice.
        expect((await call("DELETE", `/uploads/${upload.id}`)).status).toBe(204);
        expect(await auditActions(tenantA, upload.id)).toHaveLength(2);
        const listed = await json<{ items: UploadDto[] }>(await call("GET", "/uploads"));
        expect(listed.items.some((item) => item.id === upload.id)).toBe(false);
      });

      it("does not accept segments for a finished upload", async () => {
        const done = await uploadWhole("a.eml", SMALL_EML);
        const late = await problem(await putSegment(done, 0, SMALL_EML), 409);
        expect(late.type).toBe("urn:restow:problem:import-upload-not-open");
      });

      it("lets an unused upload expire: not listable, not usable, not counted", async () => {
        const upload = await createUpload("late.eml", 100);
        await owner
          .update(importUploads)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(importUploads.id, upload.id));
        const dto = await json<UploadDto>(await call("GET", `/uploads/${upload.id}`));
        expect(dto.status).toBe("expired");
        const listed = await json<{ items: UploadDto[] }>(await call("GET", "/uploads"));
        expect(listed.items.some((item) => item.id === upload.id)).toBe(false);
        const put = await problem(await putSegment(upload, 0, randomBytes(100)), 410);
        expect(put.type).toBe("urn:restow:problem:import-upload-expired");
        expect((await call("POST", `/uploads/${upload.id}/complete`)).status).toBe(410);
        const refused = await problem(
          await requestImport({
            name: "Expired",
            files: [{ origin: "upload", uploadId: upload.id }],
          }),
          422,
        );
        expect(refused.code).toBe("not_ready");
        // It can still be cancelled to remove what is left.
        expect((await call("DELETE", `/uploads/${upload.id}`)).status).toBe(204);
      });

      it("caps the bytes of the staging area of a tenant", async () => {
        const ids: string[] = [];
        for (let index = 0; index < 3; index++) {
          ids.push(
            (await createUpload(`big${index}.mbox`, STAGING_LIMIT / 3, { tenant: tenantC })).id,
          );
        }
        const refused = await problem(
          await call("POST", "/uploads", {
            tenant: tenantC,
            json: { fileName: "one-byte-too-many.eml", size: 1 },
          }),
          422,
        );
        expect(refused.type).toBe("urn:restow:problem:import-staging-full");
        expect(refused).toMatchObject({
          stagedBytes: STAGING_LIMIT,
          limitBytes: STAGING_LIMIT,
          size: 1,
        });
        // Cancelling an upload frees its share, an expired one does not count either.
        expect((await call("DELETE", `/uploads/${ids[0]}`, { tenant: tenantC })).status).toBe(204);
        await createUpload("fits-again.eml", STAGING_LIMIT / 3, { tenant: tenantC });
        await problem(
          await call("POST", "/uploads", {
            tenant: tenantC,
            json: { fileName: "too-big.eml", size: 2 },
          }),
          422,
        );
        await owner
          .update(importUploads)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(importUploads.id, ids[1] as string));
        await createUpload("fits-too.eml", STAGING_LIMIT / 3, { tenant: tenantC });
        // Other tenants have a staging area of their own.
        await createUpload("elsewhere.eml", 10, { tenant: tenantA });
        await owner.delete(importUploads).where(eq(importUploads.tenantId, tenantC));
      });

      it("caps the open uploads of a tenant", async () => {
        const ids: string[] = [];
        for (let index = 0; index < 20; index++) {
          ids.push((await createUpload(`f${index}.eml`, 10, { tenant: tenantC })).id);
        }
        const refused = await problem(
          await call("POST", "/uploads", {
            tenant: tenantC,
            json: { fileName: "one-too-many.eml", size: 10 },
          }),
          429,
        );
        expect(refused.type).toBe("urn:restow:problem:import-too-many-uploads");
        expect(refused).toMatchObject({ limit: 20, open: 20 });
        // Cancelling one makes room; an expired one does not count.
        expect((await call("DELETE", `/uploads/${ids[0]}`, { tenant: tenantC })).status).toBe(204);
        await createUpload("fits-again.eml", 10, { tenant: tenantC });
        await owner
          .update(importUploads)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(importUploads.id, ids[1] as string));
        await createUpload("fits-too.eml", 10, { tenant: tenantC });
        // Other tenants are not affected.
        await createUpload("elsewhere.eml", 10, { tenant: tenantA });
        // Clean up so tenant C is empty again.
        await owner.delete(importUploads).where(eq(importUploads.tenantId, tenantC));
      });
    });

    // -------------------------------------------------------------------------
    // Tenant isolation
    // -------------------------------------------------------------------------

    describe("tenant isolation", () => {
      it("keeps uploads of one tenant invisible and untouchable for another", async () => {
        const mine = await uploadWhole("mine.mbox", SMALL_MBOX, { who: "adminA", tenant: tenantA });
        const asB = { who: "adminB", tenant: tenantB } as const;
        expect((await call("GET", `/uploads/${mine.id}`, asB)).status).toBe(404);
        expect((await putSegment(mine, 0, SMALL_MBOX, asB)).status).toBe(404);
        expect((await call("POST", `/uploads/${mine.id}/complete`, asB)).status).toBe(404);
        expect((await call("DELETE", `/uploads/${mine.id}`, asB)).status).toBe(404);
        const listedB = await json<{ items: UploadDto[] }>(await call("GET", "/uploads", asB));
        expect(listedB.items.some((item) => item.id === mine.id)).toBe(false);
        // Naming the id under the wrong tenant header is the same as not knowing it.
        expect(
          (await call("GET", `/uploads/${mine.id}`, { who: "provider", tenant: tenantB })).status,
        ).toBe(404);
        // Untouched for the owner.
        const still = await json<UploadDto>(
          await call("GET", `/uploads/${mine.id}`, { who: "adminA" }),
        );
        expect(still.status).toBe("ready");
        expect(memory.keysUnder(`tenants/${tenantA}/staging/${mine.id}/`)).toHaveLength(1);

        // Another tenant's upload cannot be imported either.
        const unknown = await problem(
          await requestImport(
            { name: "Stolen", files: [{ origin: "upload", uploadId: mine.id }] },
            asB,
          ),
          422,
        );
        expect(unknown.type).toBe("urn:restow:problem:import-upload-unknown");
      });

      it("keeps imports of one tenant invisible for another", async () => {
        const upload = await uploadWhole("a.eml", SMALL_EML, { tenant: tenantA });
        const created = await importOk(
          { name: "Tenant A mail", files: [{ origin: "upload", uploadId: upload.id }] },
          { who: "adminA" },
        );
        const asB = { who: "adminB", tenant: tenantB } as const;
        expect((await call("GET", `/${created.id}`, asB)).status).toBe(404);
        expect((await call("POST", `/${created.id}/cancel`, asB)).status).toBe(404);
        const listedB = await json<{ items: { id: string }[] }>(await call("GET", "", asB));
        expect(listedB.items.some((item) => item.id === created.id)).toBe(false);
        const listedA = await json<{ items: { id: string }[] }>(
          await call("GET", "", { who: "adminA" }),
        );
        expect(listedA.items.some((item) => item.id === created.id)).toBe(true);
        // Adding files to another tenant's imported mailbox is not possible.
        const other = await uploadWhole("b.eml", SMALL_EML, asB);
        const missing = await problem(
          await requestImport(
            { objectId: created.objectId, files: [{ origin: "upload", uploadId: other.id }] },
            asB,
          ),
          404,
        );
        expect(missing.title).toBe("Imported mailbox not found");
      });

      it("is enforced by Row Level Security on the application role, not only by the queries", async () => {
        const { withTenantTx } = await import("../../lib/tenant-context.js");
        const seenByB = await withTenantTx(appDb, tenantB, (tx) => tx.select().from(importUploads));
        expect(seenByB.every((row) => row.tenantId === tenantB)).toBe(true);
        const importsSeenByB = await withTenantTx(appDb, tenantB, (tx) =>
          tx.select().from(mailImports),
        );
        expect(importsSeenByB.every((row) => row.tenantId === tenantB)).toBe(true);
        const [foreign] = await owner
          .select()
          .from(importUploads)
          .where(eq(importUploads.tenantId, tenantA))
          .limit(1);
        expect(foreign).toBeDefined();
        const readByB = await withTenantTx(appDb, tenantB, (tx) =>
          tx
            .select()
            .from(importUploads)
            .where(eq(importUploads.id, foreign?.id as string)),
        );
        expect(readByB).toEqual([]);
        // Writing a row for another tenant is refused by the policy itself.
        await expect(
          withTenantTx(appDb, tenantB, (tx) =>
            tx.insert(importUploads).values({
              tenantId: tenantA,
              fileName: "planted.eml",
              size: 1,
              segmentSize: 65536,
              segmentCount: 1,
              expiresAt: new Date(Date.now() + 60_000),
            }),
          ),
        ).rejects.toThrow();
      });
    });

    // -------------------------------------------------------------------------
    // Import requests
    // -------------------------------------------------------------------------

    describe("import requests", () => {
      let firstImport: CreatedImport;

      it("creates the import source, the imported mailbox, the job, the queue entry and the audit entry together", async () => {
        const upload = await uploadWhole("Old mail.mbox", bigMbox(), { who: "adminA" });
        firstImport = await importOk(
          {
            name: "Old mail 2019",
            files: [{ origin: "upload", uploadId: upload.id }],
            archive: true,
          },
          { who: "adminA" },
        );
        tenantByImport.set(firstImport.id, tenantA);

        const [source] = await owner
          .select()
          .from(sources)
          .where(eq(sources.id, firstImport.sourceId));
        expect(source).toMatchObject({
          tenantId: tenantA,
          kind: "import",
          name: "Imported mail files",
          status: "active",
          host: null,
          port: null,
          username: null,
          secretRef: null,
        });
        const [object] = await owner
          .select()
          .from(protectedObjects)
          .where(eq(protectedObjects.id, firstImport.objectId));
        expect(object).toMatchObject({
          tenantId: tenantA,
          sourceId: firstImport.sourceId,
          kind: "imap",
          origin: "manual",
          status: "active",
          externalId: `import-${firstImport.objectId}`,
          displayName: "Old mail 2019",
        });
        const [job] = await owner.select().from(jobs).where(eq(jobs.id, firstImport.jobId));
        const payload = {
          jobId: firstImport.jobId,
          tenantId: tenantA,
          importId: firstImport.id,
          protectedObjectId: firstImport.objectId,
        };
        expect(job).toMatchObject({
          queue: "import",
          status: "queued",
          protectedObjectId: firstImport.objectId,
          payload,
        });
        expect(job?.pgBossJobId).toBeTruthy();
        const [row] = await owner
          .select()
          .from(mailImports)
          .where(eq(mailImports.id, firstImport.id));
        expect(row).toMatchObject({
          tenantId: tenantA,
          sourceId: firstImport.sourceId,
          protectedObjectId: firstImport.objectId,
          jobId: firstImport.jobId,
          name: "Old mail 2019",
          options: { archive: true },
          createdBy: userIds.adminA,
          report: null,
        });
        expect(row?.files).toEqual([
          {
            origin: "upload",
            uploadId: upload.id,
            kind: "file",
            path: "Old mail.mbox",
            size: upload.size,
            format: "mbox",
          },
        ]);
        const queued = await owner.execute<{ name: string; priority: number; data: unknown }>(
          sql`SELECT name, priority, data FROM pgboss.job WHERE id = ${job?.pgBossJobId}::uuid`,
        );
        expect(queued.rows[0]).toEqual({ name: "import", priority: 50, data: payload });
        const [consumed] = await owner
          .select()
          .from(importUploads)
          .where(eq(importUploads.id, upload.id));
        expect(consumed).toMatchObject({ status: "consumed", importId: firstImport.id });

        // The staged file of an import that has not ended counts against the staging limit,
        // once the import ended (the worker deleted the segments) it does not.
        const staged = () => service.stagedBytesInUse(owner, tenantA, new Date());
        const whileQueued = await staged();
        await owner.update(jobs).set({ status: "completed" }).where(eq(jobs.id, firstImport.jobId));
        expect(whileQueued - (await staged())).toBe(upload.size);
        await owner.update(jobs).set({ status: "queued" }).where(eq(jobs.id, firstImport.jobId));

        expect(await auditActions(tenantA, firstImport.id)).toEqual(["import.requested"]);
        const [entry] = await owner
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.action, "import.requested"), eq(auditLog.target, firstImport.id)));
        expect(entry).toMatchObject({
          tenantId: tenantA,
          actorUserId: userIds.adminA,
          targetType: "mail_import",
          details: {
            jobId: firstImport.jobId,
            protectedObjectId: firstImport.objectId,
            name: "Old mail 2019",
            newMailbox: true,
            archive: true,
            fileCount: 1,
            files: [{ origin: "upload", kind: "file", path: "Old mail.mbox", format: "mbox" }],
          },
        });
        // The source's creation is audited too.
        expect(await auditActions(tenantA, firstImport.sourceId)).toEqual(["source.created"]);
      });

      it("refuses a second mailbox with the same name and files that cannot be read", async () => {
        const upload = await uploadWhole("more.eml", SMALL_EML);
        const taken = await problem(
          await requestImport({
            name: "old MAIL 2019",
            files: [{ origin: "upload", uploadId: upload.id }],
          }),
          409,
        );
        expect(taken.type).toBe("urn:restow:problem:import-name-taken");

        // A PST is refused with its reason, an unrecognised file too, an unfinished upload as not ready.
        const pst = await uploadWhole("box.pst", PST_BYTES);
        const notes = await uploadWhole("notes.eml", NOTES_BYTES);
        const pending = await createUpload("pending.eml", 10);
        const refusedPst = await problem(
          await requestImport({ name: "Outlook", files: [{ origin: "upload", uploadId: pst.id }] }),
          422,
        );
        expect(refusedPst.type).toBe("urn:restow:problem:import-format-not-supported");
        expect(refusedPst.code).toBe("pst_not_supported");
        expect(refusedPst.detail).toContain("PST and OST import is planned for a later release");
        const refusedNotes = await problem(
          await requestImport({ name: "Notes", files: [{ origin: "upload", uploadId: notes.id }] }),
          422,
        );
        expect(refusedNotes.code).toBe("unrecognised");
        const refusedPending = await problem(
          await requestImport({
            name: "Pending",
            files: [{ origin: "upload", uploadId: pending.id }],
          }),
          422,
        );
        expect(refusedPending.type).toBe("urn:restow:problem:import-format-not-supported");
        expect(refusedPending.code).toBe("not_ready");
        // One bad file refuses the whole request: nothing was created.
        const mixed = await problem(
          await requestImport({
            name: "Mixed",
            files: [
              { origin: "upload", uploadId: upload.id },
              { origin: "upload", uploadId: pst.id },
            ],
          }),
          422,
        );
        expect(mixed.code).toBe("pst_not_supported");
        const mailboxes = await owner
          .select()
          .from(protectedObjects)
          .where(eq(protectedObjects.displayName, "Mixed"));
        expect(mailboxes).toEqual([]);
        const [stillReady] = await owner
          .select()
          .from(importUploads)
          .where(eq(importUploads.id, upload.id));
        expect(stillReady?.status).toBe("ready");
      });

      it("validates the request shape", async () => {
        const upload = await uploadWhole("v.eml", SMALL_EML);
        const entry = { origin: "upload", uploadId: upload.id };
        expect((await requestImport({ files: [entry] })).status).toBe(422);
        expect(
          (await requestImport({ name: "x", objectId: firstImport.objectId, files: [entry] }))
            .status,
        ).toBe(422);
        expect((await requestImport({ name: "x", files: [] })).status).toBe(422);
        expect((await requestImport({ name: "x", files: [entry, entry] })).status).toBe(422);
        expect((await requestImport({ name: "", files: [entry] })).status).toBe(422);
        expect((await requestImport({ name: "x".repeat(121), files: [entry] })).status).toBe(422);
        expect(
          (await requestImport({ name: "x", files: [{ origin: "url", path: "http://x" }] })).status,
        ).toBe(422);
      });

      it("takes files and directories of the import folder", async () => {
        const created = await importOk({
          name: "From the server folder",
          files: [
            { origin: "folder", path: "mail/a.eml" },
            { origin: "folder", path: "/zips//archive.zip" },
            { origin: "folder", path: "MailStore" },
          ],
        });
        const [row] = await owner.select().from(mailImports).where(eq(mailImports.id, created.id));
        expect(row?.files).toEqual([
          {
            origin: "folder",
            kind: "file",
            path: `${slugA}/mail/a.eml`,
            size: SMALL_EML.length,
            format: "eml",
          },
          {
            origin: "folder",
            kind: "file",
            path: `${slugA}/zips/archive.zip`,
            size: expect.any(Number),
            format: "zip",
          },
          {
            origin: "folder",
            kind: "directory",
            path: `${slugA}/MailStore`,
            size: 0,
            format: null,
          },
        ]);
        expect(row?.options).toEqual({ archive: false });
        // The detail shows them relative to the tenant's folder, as the browser lists them.
        const detail = await json<{ files: { path: string }[] }>(
          await call("GET", `/${created.id}`),
        );
        expect(detail.files.map((file) => file.path)).toEqual([
          "mail/a.eml",
          "zips/archive.zip",
          "MailStore",
        ]);
        // Free the mailbox for the next test.
        await owner.update(jobs).set({ status: "completed" }).where(eq(jobs.id, created.jobId));
      });

      it("refuses folder entries that are not there, leave the folder or cannot be imported", async () => {
        const cases: [string, string][] = [
          ["nope/x.eml", "urn:restow:problem:import-folder-path-unknown"],
          ["../outside/secret.eml", "urn:restow:problem:import-folder-path-invalid"],
          ["link-to-outside/secret.eml", "urn:restow:problem:import-folder-path-invalid"],
          ["mail/link-to-secret.eml", "urn:restow:problem:import-folder-path-invalid"],
        ];
        for (const [path, type] of cases) {
          const body = await problem(
            await requestImport({ name: "Bad path", files: [{ origin: "folder", path }] }),
            422,
          );
          expect(body.type, path).toBe(type);
        }
        const pst = await problem(
          await requestImport({ name: "Bad", files: [{ origin: "folder", path: "mail/x.pst" }] }),
          422,
        );
        expect(pst.type).toBe("urn:restow:problem:import-format-not-supported");
        expect(pst.code).toBe("pst_not_supported");
        const notes = await problem(
          await requestImport({ name: "Bad", files: [{ origin: "folder", path: "notes.txt" }] }),
          422,
        );
        expect(notes.code).toBe("unrecognised");
        const overlap = await problem(
          await requestImport({
            name: "Overlap",
            files: [
              { origin: "folder", path: "MailStore" },
              { origin: "folder", path: "MailStore/2019/1.eml" },
            ],
          }),
          422,
        );
        expect(overlap.type).toBe("urn:restow:problem:import-files-overlap");
      });

      it("adds files to an existing imported mailbox: one import waits per mailbox, another may follow a running one", async () => {
        const upload = await uploadWhole("next.eml", SMALL_EML);
        const body = {
          objectId: firstImport.objectId,
          files: [{ origin: "upload", uploadId: upload.id }],
        };
        // The first import has not started: a second one would wait behind nothing and collide.
        const waiting = await problem(await requestImport(body), 409);
        expect(waiting.type).toBe("urn:restow:problem:import-already-queued");
        expect(waiting.detail).toBe(
          "An import into this mailbox is already waiting. It starts when the running one has finished.",
        );

        // The queue says the same when the database row has moved on but the queue entry still waits:
        // the request is rolled back completely.
        await owner.update(jobs).set({ status: "active" }).where(eq(jobs.id, firstImport.jobId));
        const before = await owner
          .select()
          .from(mailImports)
          .where(eq(mailImports.tenantId, tenantA));
        const queueRefused = await problem(await requestImport(body), 409);
        expect(queueRefused.type).toBe("urn:restow:problem:import-already-queued");
        const after = await owner
          .select()
          .from(mailImports)
          .where(eq(mailImports.tenantId, tenantA));
        expect(after).toHaveLength(before.length);
        const [untouched] = await owner
          .select()
          .from(importUploads)
          .where(eq(importUploads.id, upload.id));
        expect(untouched?.status).toBe("ready");
        const [firstJob] = await owner.select().from(jobs).where(eq(jobs.id, firstImport.jobId));

        // Once the first import really runs, a second one may queue behind it.
        await owner.execute(
          sql`UPDATE pgboss.job SET state = 'active', started_on = now() WHERE id = ${firstJob?.pgBossJobId}::uuid`,
        );
        const second = await importOk(body);
        expect(second.objectId).toBe(firstImport.objectId);
        expect(second.sourceId).toBe(firstImport.sourceId);
        expect(second.id).not.toBe(firstImport.id);
        const importSources = await owner
          .select()
          .from(sources)
          .where(and(eq(sources.tenantId, tenantA), eq(sources.kind, "import")));
        expect(importSources).toHaveLength(1);
        const [row] = await owner.select().from(mailImports).where(eq(mailImports.id, second.id));
        expect(row?.name).toBe("Old mail 2019");
        const [entry] = await owner
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.action, "import.requested"), eq(auditLog.target, second.id)));
        expect(entry?.details).toMatchObject({
          newMailbox: false,
          protectedObjectId: firstImport.objectId,
        });
        // The second one waits now: a third is refused.
        const third = await uploadWhole("third.eml", SMALL_EML);
        const thirdBody = {
          objectId: firstImport.objectId,
          files: [{ origin: "upload", uploadId: third.id }],
        };
        expect((await problem(await requestImport(thirdBody), 409)).type).toBe(
          "urn:restow:problem:import-already-queued",
        );
        await owner.update(jobs).set({ status: "completed" }).where(eq(jobs.id, second.jobId));
        await owner.update(jobs).set({ status: "completed" }).where(eq(jobs.id, firstImport.jobId));
      });

      it("adds only to imported mailboxes", async () => {
        const upload = await uploadWhole("x.eml", SMALL_EML);
        const files = [{ origin: "upload", uploadId: upload.id }];
        const notImported = await problem(
          await requestImport({ objectId: f.annaMailbox, files }),
          422,
        );
        expect(notImported.type).toBe("urn:restow:problem:import-object-not-imported");
        const imap = await problem(await requestImport({ objectId: f.imapAccount, files }), 422);
        expect(imap.type).toBe("urn:restow:problem:import-object-not-imported");
        expect((await requestImport({ objectId: randomUUID(), files })).status).toBe(404);
      });

      it("does not let one upload be used twice", async () => {
        const upload = await uploadWhole("once.eml", SMALL_EML);
        const files = [{ origin: "upload", uploadId: upload.id }];
        await importOk({ name: "Used once", files });
        const again = await problem(await requestImport({ name: "Used twice", files }), 422);
        expect(again.type).toBe("urn:restow:problem:import-format-not-supported");
        expect(again.code).toBe("not_ready");
        // A consumed upload cannot be cancelled either: the import owns it.
        const cancel = await problem(await call("DELETE", `/uploads/${upload.id}`), 409);
        expect(cancel.type).toBe("urn:restow:problem:import-upload-in-use");
      });
    });

    // -------------------------------------------------------------------------
    // Reading, progress and cancelling
    // -------------------------------------------------------------------------

    describe("import detail and cancel", () => {
      interface Summary {
        id: string;
        name: string;
        objectId: string;
        sourceId: string;
        jobId: string | null;
        status: string;
        fileCount: number;
        archive: boolean;
        createdAt: string;
        completedAt: string | null;
        messages: number | null;
        failed: number | null;
        live: Record<string, number> | null;
      }
      interface Detail extends Summary {
        files: {
          origin: string;
          kind: string;
          path: string;
          size: number;
          format: string | null;
        }[];
        startedAt: string | null;
        errorMessage: string | null;
        actor: { userId: string | null; name: string | null; email: string | null };
        progress: {
          total: number;
          done: number;
          failed: number;
          bytes: number;
          etaSeconds: number | null;
        } | null;
        phase: string | null;
        report: {
          version: number;
          snapshotId: string | null;
          totals: Record<string, number>;
        } | null;
        failures: { itemRef: string; reason: string; attempts: number }[];
      }

      async function freshImport(
        name: string,
      ): Promise<{ created: CreatedImport; uploadId: string }> {
        const upload = await uploadWhole(`${name}.mbox`, SMALL_MBOX, { who: "adminA" });
        const created = await importOk(
          { name, files: [{ origin: "upload", uploadId: upload.id }] },
          { who: "adminA" },
        );
        tenantByImport.set(created.id, tenantA);
        return { created, uploadId: upload.id };
      }

      it("shows a queued import", async () => {
        const { created } = await freshImport("Detail queued");
        const detail = await json<Detail>(await call("GET", `/${created.id}`, { who: "adminA" }));
        expect(detail).toMatchObject({
          id: created.id,
          name: "Detail queued",
          objectId: created.objectId,
          sourceId: created.sourceId,
          jobId: created.jobId,
          status: "queued",
          fileCount: 1,
          archive: false,
          completedAt: null,
          messages: null,
          failed: null,
          live: null,
          startedAt: null,
          errorMessage: null,
          progress: null,
          phase: null,
          report: null,
          failures: [],
          actor: { userId: userIds.adminA, name: "adminA", email: "adminA@example.test" },
        });
        expect(detail.files).toEqual([
          {
            origin: "upload",
            kind: "file",
            path: "Detail queued.mbox",
            size: SMALL_MBOX.length,
            format: "mbox",
          },
        ]);
      });

      it("joins the running job: progress, phase, live counters and the failures so far", async () => {
        const { created } = await freshImport("Detail running");
        await simulateWorker(created, {
          status: "active",
          phase: "import",
          live: { messages: 12, duplicates: 1, skipped: 2, failed: 3, unitsDone: 1, unitsTotal: 4 },
          progress: { total: 1000, done: 250, failed: 3, bytes: 4096 },
        });
        await owner.insert(itemFailures).values([
          {
            tenantId: tenantA,
            jobId: created.jobId,
            itemRef: "a.mbox#3",
            reason: "unreadable",
            attempts: 1,
          },
          {
            tenantId: tenantA,
            jobId: created.jobId,
            itemRef: "a.mbox#9",
            reason: "too large",
            attempts: 1,
          },
        ]);
        const detail = await json<Detail>(await call("GET", `/${created.id}`, { who: "adminA" }));
        expect(detail).toMatchObject({
          status: "active",
          phase: "import",
          progress: { total: 1000, done: 250, failed: 3, bytes: 4096, etaSeconds: null },
          messages: 12,
          failed: 3,
          live: { messages: 12, duplicates: 1, skipped: 2, failed: 3, filesDone: 1, filesTotal: 4 },
        });
        expect(detail.startedAt).not.toBeNull();
        expect(detail.failures.map((failure) => failure.itemRef).sort()).toEqual([
          "a.mbox#3",
          "a.mbox#9",
        ]);
        const summary = (
          await json<{ items: Summary[] }>(await call("GET", "", { who: "adminA" }))
        ).items.find((item) => item.id === created.id);
        expect(summary?.live).toMatchObject({ messages: 12 });
        expect(summary).not.toHaveProperty("files");
      });

      it("takes the numbers from the report once the import finished, and shows a report of a failed run", async () => {
        const report = {
          version: 1,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          snapshotId: randomUUID(),
          totals: { files: 1, messages: 40, failed: 2, duplicates: 1, skipped: 0, folders: 1 },
          files: [],
          items: [],
          itemsOmitted: 0,
          archive: null,
          notes: [],
        };
        const done = await freshImport("Detail done");
        await simulateWorker(done.created, {
          status: "completed",
          phase: "archive",
          live: { messages: 39, duplicates: 0, skipped: 0, failed: 2, unitsDone: 1, unitsTotal: 1 },
          progress: { total: 1000, done: 1000, failed: 2, bytes: 9000 },
          report,
        });
        const detail = await json<Detail>(
          await call("GET", `/${done.created.id}`, { who: "adminA" }),
        );
        expect(detail).toMatchObject({
          status: "completed",
          messages: 40,
          failed: 2,
          phase: null,
          live: { messages: 39 },
        });
        expect(detail.completedAt).not.toBeNull();
        expect(detail.report?.totals.messages).toBe(40);
        expect(detail.report?.snapshotId).toBe(report.snapshotId);

        const failed = await freshImport("Detail failed");
        await simulateWorker(failed.created, {
          status: "failed",
          errorMessage: "Nothing readable in the selected files",
          report: {
            ...report,
            snapshotId: null,
            totals: { ...report.totals, messages: 0, failed: 1 },
          },
        });
        const failedDetail = await json<Detail>(
          await call("GET", `/${failed.created.id}`, { who: "adminA" }),
        );
        expect(failedDetail).toMatchObject({
          status: "failed",
          errorMessage: "Nothing readable in the selected files",
          messages: 0,
          failed: 1,
        });
        expect(failedDetail.report?.snapshotId).toBeNull();
      });

      it("lists the newest imports first and at most 50", async () => {
        const listed = await json<{ items: Summary[] }>(await call("GET", "", { who: "adminA" }));
        expect(listed.items.length).toBeGreaterThan(3);
        const times = listed.items.map((item) => Date.parse(item.createdAt));
        expect([...times].sort((a, b) => b - a)).toEqual(times);
        expect((await call("GET", "?limit=2")).status).toBe(200);
        expect(
          (await json<{ items: Summary[] }>(await call("GET", "?limit=2"))).items,
        ).toHaveLength(2);
        expect((await call("GET", "?limit=51")).status).toBe(422);
        expect((await call("GET", "/not-a-uuid")).status).toBe(422);
        expect((await call("GET", `/${randomUUID()}`)).status).toBe(404);
      });

      it("cancels a queued import: the job never starts, the staged files go, the queue entry is cancelled", async () => {
        const { created, uploadId } = await freshImport("Cancel me");
        const [job] = await owner.select().from(jobs).where(eq(jobs.id, created.jobId));
        expect(memory.keysUnder(`tenants/${tenantA}/staging/${uploadId}/`)).toHaveLength(1);

        const response = await call("POST", `/${created.id}/cancel`, { who: "adminA" });
        expect(response.status).toBe(200);
        const detail = await json<Detail>(response);
        expect(detail.status).toBe("cancelled");
        expect(detail.completedAt).not.toBeNull();
        const [after] = await owner.select().from(jobs).where(eq(jobs.id, created.jobId));
        expect(after?.status).toBe("cancelled");
        expect(memory.keysUnder(`tenants/${tenantA}/staging/${uploadId}/`)).toEqual([]);
        const queued = await owner.execute<{ state: string }>(
          sql`SELECT state FROM pgboss.job WHERE id = ${job?.pgBossJobId}::uuid`,
        );
        expect(queued.rows[0]?.state).toBe("cancelled");
        expect(await auditActions(tenantA, created.id)).toEqual([
          "import.requested",
          "import.cancelled",
        ]);
        const [entry] = await owner
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.action, "import.cancelled"), eq(auditLog.target, created.id)));
        expect(entry).toMatchObject({
          targetType: "mail_import",
          details: { previousStatus: "queued" },
        });

        // Only queued or running imports can be cancelled.
        const again = await problem(
          await call("POST", `/${created.id}/cancel`, { who: "adminA" }),
          409,
        );
        expect(again.title).toBe("Import not cancellable");
      });

      it("cancels a running import but leaves the staged files to the worker", async () => {
        const { created, uploadId } = await freshImport("Cancel running");
        await simulateWorker(created, { status: "active", phase: "import" });
        const detail = await json<Detail>(
          await call("POST", `/${created.id}/cancel`, { who: "adminA" }),
        );
        expect(detail.status).toBe("cancelled");
        expect(memory.keysUnder(`tenants/${tenantA}/staging/${uploadId}/`)).toHaveLength(1);
        const [entry] = await owner
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.action, "import.cancelled"), eq(auditLog.target, created.id)));
        expect(entry?.details).toMatchObject({ previousStatus: "active" });
      });
    });

    // -------------------------------------------------------------------------
    // Imported mailboxes are not what a tenant protects
    // -------------------------------------------------------------------------

    describe("exclusions", () => {
      /** Tenant C holds nothing but an imported mailbox with a finished snapshot. */
      let importedObject: string;
      let importSource: string;
      let importedSnapshot: string;

      beforeAll(async () => {
        importSource = one(
          await owner
            .insert(sources)
            .values({
              tenantId: tenantC,
              kind: "import",
              name: "Imported mail files",
              status: "active",
            })
            .returning(),
        ).id;
        importedObject = one(
          await owner
            .insert(protectedObjects)
            .values({
              tenantId: tenantC,
              sourceId: importSource,
              kind: "imap",
              origin: "manual",
              status: "active",
              externalId: "import-c1",
              displayName: "Old mail",
              activeSince: new Date(Date.now() - 10 * 86_400_000),
              createdAt: new Date(Date.now() - 10 * 86_400_000),
            })
            .returning(),
        ).id;
        importedSnapshot = one(
          await owner
            .insert(snapshots)
            .values({
              tenantId: tenantC,
              protectedObjectId: importedObject,
              sequence: 1,
              startedAt: new Date(Date.now() - 86_400_000),
              completedAt: new Date(Date.now() - 86_400_000),
              manifestPath: `tenants/${tenantC}/manifests/${randomUUID()}`,
              itemCount: 50,
              byteSize: 123_456,
            })
            .returning(),
        ).id;
      });

      it("lists the import source with its imported mailboxes and no connection details", async () => {
        const { listSources, getSource } = await import("../sources/service.js");
        const items = await listSources(appDb, tenantC);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          id: importSource,
          kind: "import",
          name: "Imported mail files",
          status: "active",
          importedMailboxes: 1,
          imap: null,
          m365: null,
        });
        expect(await getSource(appDb, tenantC, importSource)).toMatchObject({
          importedMailboxes: 1,
        });
        // Other sources carry no count.
        const others = await listSources(appDb, tenantA);
        expect(
          others.every((item) => item.importedMailboxes === null || item.kind === "import"),
        ).toBe(true);
        expect(others.find((item) => item.kind === "m365")?.importedMailboxes).toBeNull();
      });

      it("refuses to edit, probe, verify or consent an import source, with a clear problem", async () => {
        const sourcesService = await import("../sources/service.js");
        const actor = {
          id: userIds.provider,
          email: "provider@example.test",
          ip: null,
          isProviderAdmin: true,
        };
        const rejected = async (run: () => Promise<unknown>) => {
          const error = (await run().catch((caught) => caught)) as {
            status?: number;
            type?: string;
          };
          expect(error.status).toBe(409);
          expect(error.type).toBe("urn:restow:problem:source-kind-mismatch");
        };
        await rejected(() =>
          sourcesService.updateSource(appDb, tenantC, importSource, { name: "Renamed" }, actor),
        );
        await rejected(() =>
          sourcesService.updateSource(appDb, tenantC, importSource, { status: "disabled" }, actor),
        );
        await rejected(() => sourcesService.testSource(appDb, tenantC, importSource, actor));
        await rejected(() => sourcesService.verifySource(appDb, tenantC, importSource, actor));
        await rejected(() =>
          sourcesService.createConsentLink(appDb, tenantC, importSource, actor, {
            observedOrigin: null,
          }),
        );
        await rejected(() =>
          sourcesService.testImapConnection(
            appDb,
            tenantC,
            {
              host: "imap.example.test",
              port: 993,
              security: "tls",
              username: "u",
              sourceId: importSource,
            },
            actor,
          ),
        );
      });

      it("keeps an import source with imported data (409) and deletes one without", async () => {
        const { deleteSource } = await import("../sources/service.js");
        const actor = {
          id: userIds.provider,
          email: "provider@example.test",
          ip: null,
          isProviderAdmin: true,
        };
        const blocked = (await deleteSource(appDb, tenantC, importSource, actor).catch(
          (caught) => caught,
        )) as {
          status: number;
          type: string;
          extensions: { importedMailboxes: number; retained: { snapshots: number } };
        };
        expect(blocked.status).toBe(409);
        expect(blocked.type).toBe("urn:restow:problem:source-has-data");
        expect(blocked.extensions).toMatchObject({
          importedMailboxes: 1,
          retained: { snapshots: 1 },
        });

        // A source whose imports never produced data goes, and takes its empty mailboxes with it.
        const emptySource = one(
          await owner
            .insert(sources)
            .values({
              tenantId: tenantB,
              kind: "import",
              name: "Empty import source",
              status: "active",
            })
            .returning(),
        ).id;
        const emptyObject = one(
          await owner
            .insert(protectedObjects)
            .values({
              tenantId: tenantB,
              sourceId: emptySource,
              kind: "imap",
              origin: "manual",
              externalId: "import-empty",
              displayName: "Nothing readable",
            })
            .returning(),
        ).id;
        await deleteSource(appDb, tenantB, emptySource, actor);
        expect(await owner.select().from(sources).where(eq(sources.id, emptySource))).toEqual([]);
        expect(
          await owner.select().from(protectedObjects).where(eq(protectedObjects.id, emptyObject)),
        ).toEqual([]);
        const [entry] = await owner
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.action, "source.deleted"), eq(auditLog.target, emptySource)));
        expect(entry?.details).toMatchObject({ kind: "import", importedMailboxes: 1 });
      });

      it("is never 'not protected', 'overdue' or 'never verified'", async () => {
        const { readinessOverview } = await import("../verify/service.js");
        const overview = await readinessOverview(appDb, tenantC, new Date());
        expect(overview.objects).toEqual([]);
        expect(overview.summary).toMatchObject({
          total: 0,
          noBackup: 0,
          overdue: 0,
          unverified: 0,
        });
        // The same tenant-A overview still lists its protected objects.
        const withObjects = await readinessOverview(appDb, tenantA, new Date());
        expect(withObjects.objects.length).toBeGreaterThan(0);
        expect(withObjects.objects.some((entry) => entry.object.id === importedObject)).toBe(false);
      });

      it("cannot be checked", async () => {
        const { runVerify } = await import("../verify/service.js");
        const actor = { userId: userIds.provider, email: "provider@example.test", ip: null };
        const all = await runVerify(appDb, tenantC, { kind: "verify" }, actor);
        expect(all).toMatchObject({ queued: [], skipped: [] });
        const one = (await runVerify(
          appDb,
          tenantC,
          { kind: "verify", protectedObjectId: importedObject },
          actor,
        ).catch((caught) => caught)) as { status: number; type: string };
        expect(one.status).toBe(409);
        expect(one.type).toBe("urn:restow:problem:imported-mailbox");
      });

      it("gets no schedule of its own", async () => {
        const { createSchedule } = await import("../schedules/service.js");
        const actor = { userId: userIds.provider, label: "provider@example.test", ip: null };
        const refused = (await createSchedule(
          appDb,
          tenantC,
          {
            kind: "backup",
            protectedObjectId: importedObject,
            intervalMinutes: 60,
            timezone: "UTC",
            enabled: true,
          } as never,
          actor,
          new Date(),
        ).catch((caught) => caught)) as { status: number; extensions?: { issues?: unknown } };
        expect(refused.status).toBe(422);
      });

      it("is not counted on the dashboard, in the integration status or the usage figures", async () => {
        const { loadTenantSummary } = await import("../../routes/v1/status.js");
        const summary = await loadTenantSummary(appDb, tenantC, new Date());
        expect(summary.objects).toMatchObject({ active: 0, excluded: 0, orphaned: 0 });
        // An import is not a backup: it is not "the last successful backup".
        expect(summary.lastSuccess).toEqual({
          mail: null,
          onedrive: null,
          imap: null,
          archive: null,
        });
        expect(summary.storage.logicalBytes).toBe(0);
        expect(summary.readiness).toMatchObject({
          total: 0,
          noBackup: 0,
          unverified: 0,
          overdue: 0,
        });

        const { loadTenantFacts } = await import("../dashboard/queries.js");
        const facts = await loadTenantFacts(appDb, tenantC, {
          STORAGE_TARGET: "local",
          STORAGE_LOCAL_PATH: "/x",
        });
        expect(facts.kinds).toEqual({ mailbox: 0, onedrive: 0, imap: 0 });
        expect(facts.setup).toMatchObject({
          sources: { active: 0, error: 0, pending: 0 },
          activeObjects: 0,
          completedSnapshots: 0,
        });
        // ... while the snapshot still counts for retention, which does apply to imports.
        expect(facts.retention.snapshots.active).toBe(1);

        const { countTenantMailboxes } = await import("../usage/service.js");
        const { withTenantTx } = await import("../../lib/tenant-context.js");
        expect(await withTenantTx(appDb, tenantC, (tx) => countTenantMailboxes(tx, tenantC))).toBe(
          0,
        );
        expect(
          await withTenantTx(appDb, tenantA, (tx) => countTenantMailboxes(tx, tenantA)),
        ).toBeGreaterThan(0);
      });

      it("is not counted in the statistics and the storage figures of protected data", async () => {
        const { collectTenantFacts } = await import("../stats/collect.js");
        const { resolvePeriod } = await import("../stats/period.js");
        const { withTenantTx } = await import("../../lib/tenant-context.js");
        const period = resolvePeriod({}, new Date());
        const stats = await withTenantTx(appDb, tenantC, (tx) =>
          collectTenantFacts(tx, { id: tenantC, name: "Northwind" }, period),
        );
        expect(stats.protectedObjectCount).toBe(0);
        expect(stats.objects).toEqual([]);
        expect(stats.hasBackups).toBe(false);
        expect(stats.largestSnapshots).toEqual([]);
        expect(stats.levels.end.logicalBytes).toBe(0);

        const { storageUsage } = await import("../storage/service.js");
        const usage = await storageUsage(appDb, tenantC);
        expect(usage.logicalBytes).toBe(0);
        expect(usage.protectedObjectCount).toBe(0);
        // The imported data does take room in the store: retained history counts it.
        expect(usage.retainedLogicalBytes).toBe(123_456);
        expect(usage.snapshotCount).toBe(1);
      });

      it("stays out of the directory, but is a source for restore, preview and download", async () => {
        const { listSources: directorySources, listObjects: directoryObjects } = await import(
          "../directory/service.js"
        );
        const listed = await directorySources(appDb, tenantC);
        expect(listed).toEqual([]);
        const { objectsQuerySchema } = await import("../directory/schemas.js");
        const objects = await directoryObjects(appDb, tenantC, objectsQuerySchema.parse({}));
        expect(objects.items).toEqual([]);
        expect(objects.total).toBe(0);

        const { listObjects } = await import("../snapshots/service.js");
        const explorer = await listObjects(
          appDb,
          tenantC,
          { role: "tenant_admin", userId: userIds.provider, email: "provider@example.test" },
          { include: "withBackup" },
        );
        expect(explorer).toHaveLength(1);
        expect(explorer[0]).toMatchObject({
          id: importedObject,
          sourceKind: "import",
          kind: "imap",
        });
        expect(importedSnapshot).toBeTruthy();
      });
    });
  },
);
