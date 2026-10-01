/**
 * Postgres-backed, HTTP-level test of the attachment download route: the
 * `tenant` query parameter fallback a plain browser navigation needs (it
 * cannot carry the `X-Restow-Tenant` header the rest of the web UI sends),
 * and the download's response headers (Content-Disposition, nosniff, and
 * the octet-stream override for a browser-renderable attachment type).
 * Every other route of this feature is exercised at the service layer
 * (explorer.pg.test.ts, preview.pg.test.ts); this file only covers what only
 * the real HTTP layer can prove.
 *
 * better-auth's session lookup is replaced at its module boundary, as in
 * stats.pg.test.ts; everything else (the tenant, the protected object, the
 * snapshot, the encrypted message content) is real Postgres and real chunk
 * storage.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_snapshots_routes_test` is recreated there and dropped
 * after). Without it the suite is skipped; see docs/TESTING.md for the
 * Postgres integration-suite convention this follows.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChunkIndex,
  type ChunkLocation,
  type ChunkRecord,
  ChunkWriter,
  Keyring,
  LocalStorageBackend,
  type PackRecord,
  type StorageTargets,
  type TenantKeyring,
} from "@restow/core";
import { type Database, chunks, createDb, manifestObjects, packs } from "@restow/db";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenantTx } from "../../lib/tenant-context.js";
import {
  type ExplorerFixture,
  createExplorerFixture,
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "./testing/explorer-fixture.js";

const DATABASE = "restow_api_snapshots_routes_test";

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

const CRLF = "\r\n";
const eml = (lines: readonly string[]): Buffer => Buffer.from(lines.join(CRLF), "utf8");

/** One ordinary attachment (report.pdf) and one the browser would render (page.html). */
const MAIL_WITH_ATTACHMENTS = eml([
  "From: Anna <anna@contoso.test>",
  "To: Bob <bob@contoso.test>",
  "Subject: Two attachments",
  "Date: Mon, 12 Jan 2026 08:00:00 +0000",
  "Message-ID: <two-attachments@contoso.test>",
  'Content-Type: multipart/mixed; boundary="B1"',
  "",
  "--B1",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "See attached.",
  "",
  "--B1",
  "Content-Type: application/pdf",
  'Content-Disposition: attachment; filename="report.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQK",
  "",
  "--B1",
  "Content-Type: text/html",
  'Content-Disposition: attachment; filename="page.html"',
  "Content-Transfer-Encoding: base64",
  "",
  "PGh0bWw+PC9odG1sPg==",
  "",
  "--B1--",
  "",
]);

/** A writable `ChunkIndex` for seeding real chunk content in this test only. */
class TestChunkIndex implements ChunkIndex {
  constructor(
    private readonly db: Database,
    private readonly tenantId: string,
  ) {}

  async existing(storedIds: readonly string[]): Promise<Set<string>> {
    if (storedIds.length === 0) {
      return new Set();
    }
    const rows = await withTenantTx(this.db, this.tenantId, (tx) =>
      tx
        .select({ storedId: chunks.storedId })
        .from(chunks)
        .where(and(eq(chunks.tenantId, this.tenantId), inArray(chunks.storedId, [...storedIds]))),
    );
    return new Set(rows.map((row) => row.storedId));
  }

  async recordPack(pack: PackRecord, records: readonly ChunkRecord[]): Promise<void> {
    await withTenantTx(this.db, this.tenantId, async (tx) => {
      await tx.insert(packs).values({
        id: pack.id,
        tenantId: this.tenantId,
        path: pack.path,
        sha256: pack.sha256,
        size: pack.size,
      });
      if (records.length > 0) {
        await tx.insert(chunks).values(
          records.map((record) => ({
            tenantId: this.tenantId,
            storedId: record.storedId,
            length: record.length,
            packId: pack.id,
            offsetBytes: record.offset,
          })),
        );
      }
    });
  }

  async locate(): Promise<Map<string, ChunkLocation>> {
    throw new Error("TestChunkIndex is write-only; reads go through the real production path");
  }

  async addReferences(): Promise<void> {}
  async releaseReferences(): Promise<void> {}
}

describe.skipIf(!testDatabaseAdminUrl)("snapshot routes against Postgres", () => {
  let db: Database;
  let f: ExplorerFixture;
  let app: Hono;
  let storageDir: string;
  let entryId: string;
  let attachmentId: string;
  let htmlAttachmentId: string;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    process.env.DATABASE_URL = url;
    // `resolveTenantAccess` (middleware/session.ts) loads the tenant on the
    // installation pool (`providerDb`); this suite runs on the superuser
    // connection for both, as preview.pg.test.ts does for `db`.
    process.env.DATABASE_PROVIDER_URL = url;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.STORAGE_TARGET = "local";
    storageDir = await mkdtemp(join(tmpdir(), "restow-snapshots-routes-test-"));
    process.env.STORAGE_LOCAL_PATH = storageDir;

    db = createDb(url);
    f = await createExplorerFixture(db);

    const secretsLib = await import("../../lib/secrets.js");
    await withTenantTx(db, f.tenantId, (tx) => secretsLib.createTenantKey(tx, f.tenantId));
    const dek = await withTenantTx(db, f.tenantId, (tx) =>
      secretsLib.loadTenantDek(tx, f.tenantId),
    );
    const keys: TenantKeyring = new Keyring(f.tenantId, [dek]);

    const storage: StorageTargets = { primary: new LocalStorageBackend(storageDir), copies: [] };
    const writer = new ChunkWriter({
      tenantId: f.tenantId,
      storage,
      keys,
      index: new TestChunkIndex(db, f.tenantId),
    });
    const written = await writer.write(MAIL_WITH_ATTACHMENTS);
    await writer.close();

    entryId = randomUUID();
    await db.insert(manifestObjects).values({
      id: entryId,
      tenantId: f.tenantId,
      snapshotId: f.mailbox.second,
      protectedObjectId: f.annaMailbox,
      kind: "mail",
      path: "mail/Inbox/TwoAttachments.llll.eml",
      name: "TwoAttachments.llll.eml",
      parentPath: "mail/Inbox",
      size: written.size,
      chunkRefs: written.chunks,
    });

    const { snapshotsRoutes } = await import("./routes.js");
    const { errorHandler, notFoundHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.notFound(notFoundHandler);
    app.route("/api/v1/snapshots", snapshotsRoutes);

    // A provider admin needs neither an organization membership nor the
    // fixture's own tenant-scoped Viewer objects to reach any tenant.
    sessions.set("provider-admin", {
      user: {
        id: randomUUID(),
        email: "ops@provider.test",
        name: "Ops",
        role: "admin",
        banned: false,
        twoFactorEnabled: false,
      },
      session: {
        id: randomUUID(),
        userId: randomUUID(),
        authMethod: "passkey",
        activeOrganizationId: null,
      },
    });

    const preview = (await import("./service.js")).previewMailEntry;
    const previewed = await preview(
      db,
      f.tenantId,
      { role: "tenant_admin", userId: null, email: "ops@provider.test", ip: "198.51.100.11" },
      f.mailbox.second,
      entryId,
    );
    if (!previewed.previewable) throw new Error("expected the fixture message to preview");
    attachmentId = previewed.attachments.find((a) => a.filename === "report.pdf")?.id as string;
    htmlAttachmentId = previewed.attachments.find((a) => a.filename === "page.html")?.id as string;
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await rm(storageDir, { recursive: true, force: true });
  });

  const attachmentPath = (id: string) =>
    `/api/v1/snapshots/${f.mailbox.second}/entries/${entryId}/attachments/${id}`;

  it("resolves the tenant from the ?tenant= query parameter when the header is absent (a plain navigation cannot send it)", async () => {
    const res = await app.request(`${attachmentPath(attachmentId)}?tenant=${f.tenantId}`, {
      headers: { "x-test-user": "provider-admin" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain('filename="report.pdf"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("%PDF-1.4\n");
  });

  it("without the header or the query parameter, refuses the request instead of guessing a tenant", async () => {
    const res = await app.request(attachmentPath(attachmentId), {
      headers: { "x-test-user": "provider-admin" },
    });
    expect(res.status).toBe(400);
  });

  it("forces application/octet-stream for a browser-renderable attachment type (html)", async () => {
    const res = await app.request(`${attachmentPath(htmlAttachmentId)}?tenant=${f.tenantId}`, {
      headers: { "x-test-user": "provider-admin" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain('filename="page.html"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("still accepts the X-Restow-Tenant header, as every other route does", async () => {
    const res = await app.request(attachmentPath(attachmentId), {
      headers: { "x-test-user": "provider-admin", "x-restow-tenant": f.tenantId },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="report.pdf"');
  });
});
