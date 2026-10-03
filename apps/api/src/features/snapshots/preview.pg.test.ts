/**
 * Postgres-backed tests of the mail preview and attachment download: real
 * encrypted content decrypted, parsed and sanitised end to end, the
 * metadata-only shortcuts (protection flag, oversized-format, size cap) that
 * never touch storage, protection detected from an old restore point that
 * carries no flag, the audit entry each read writes, self-service scoping,
 * `objects?include=all`, and the tree's sort parameter / natural name order.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_preview_test` is recreated there and dropped after).
 * Without it the suite is skipped; see docs/TESTING.md for the Postgres
 * integration-suite convention this follows.
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
  InstallationDefaultResolver,
  Keyring,
  LocalStorageBackend,
  type PackRecord,
  type StorageTargets,
  type TenantKeyring,
} from "@restow/core";
import {
  type Database,
  auditLog,
  chunks,
  createDb,
  manifestObjects,
  packs,
  protectedObjects,
} from "@restow/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../lib/tenant-context.js";
import type { Viewer } from "./access.js";
import { MAX_SANITIZED_HTML_CHARS, PREVIEW_SIZE_CAP_BYTES } from "./preview.js";
import { attachmentParamSchema, listObjectsQuerySchema, treeQuerySchema } from "./schemas.js";
import {
  type ExplorerFixture,
  createExplorerFixture,
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "./testing/explorer-fixture.js";

const DATABASE = "restow_api_preview_test";
const CLIENT_IP = "198.51.100.9";

type Service = typeof import("./service.js");
type SecretsLib = typeof import("../../lib/secrets.js");

const CRLF = "\r\n";
const eml = (lines: readonly string[]): Buffer => Buffer.from(lines.join(CRLF), "utf8");

const HTML_MAIL = eml([
  "From: Anna <anna@contoso.test>",
  "To: Bob <bob@contoso.test>",
  "Subject: Board deck",
  "Date: Mon, 12 Jan 2026 08:00:00 +0000",
  "Message-ID: <board@contoso.test>",
  'Content-Type: multipart/related; boundary="B1"',
  "",
  "--B1",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<html><body><script>alert(1)</script><p onclick="x()">Hi</p>' +
    '<img src="http://tracker.example.com/pixel.gif"><img src="cid:logo1"></body></html>',
  "",
  "--B1",
  "Content-Type: image/png",
  "Content-Transfer-Encoding: base64",
  "Content-ID: <logo1>",
  "",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "",
  "--B1",
  "Content-Type: application/pdf",
  'Content-Disposition: attachment; filename="board.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQK",
  "",
  "--B1--",
  "",
]);

const RPMSG_MAIL_NO_FLAG = eml([
  "From: Anna <anna@contoso.test>",
  "To: Bob <bob@contoso.test>",
  "Subject: Confidential",
  "Date: Tue, 13 Jan 2026 08:00:00 +0000",
  "Message-ID: <confidential@contoso.test>",
  'Content-Type: multipart/mixed; boundary="B2"',
  "",
  "--B2",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Protected message, open message.rpmsg.",
  "",
  "--B2",
  "Content-Type: application/x-microsoft-rpmsg-message",
  'Content-Disposition: attachment; filename="message.rpmsg"',
  "Content-Transfer-Encoding: base64",
  "",
  "UkNQTVNHUkNQTVNH",
  "",
  "--B2--",
  "",
]);

/** A writable `ChunkIndex` for seeding real chunk content in these tests only. */
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

describe.skipIf(!testDatabaseAdminUrl)("mail preview against Postgres", () => {
  let db: Database;
  let f: ExplorerFixture;
  let service: Service;
  let secretsLib: SecretsLib;
  let keys: TenantKeyring;
  let storageDir: string;

  const reader = (viewer: Viewer) => ({ ...viewer, ip: CLIENT_IP });

  /** Chunk, encrypt and pack real bytes into this tenant's storage and index. */
  async function storeContent(bytes: Buffer): Promise<{ chunkRefs: string[]; size: number }> {
    const storage: StorageTargets = { primary: new LocalStorageBackend(storageDir), copies: [] };
    const writer = new ChunkWriter({
      tenantId: f.tenantId,
      storage,
      keys,
      index: new TestChunkIndex(db, f.tenantId),
    });
    const written = await writer.write(bytes);
    await writer.close();
    return { chunkRefs: written.chunks, size: written.size };
  }

  async function insertMailEntry(input: {
    snapshotId: string;
    protectedObjectId: string;
    path: string;
    metadata?: Record<string, unknown>;
    content?: Buffer;
    size?: number;
  }): Promise<string> {
    const stored = input.content ? await storeContent(input.content) : null;
    const id = randomUUID();
    const slash = input.path.lastIndexOf("/");
    await db.insert(manifestObjects).values({
      id,
      tenantId: f.tenantId,
      snapshotId: input.snapshotId,
      protectedObjectId: input.protectedObjectId,
      kind: "mail",
      path: input.path,
      name: slash < 0 ? input.path : input.path.slice(slash + 1),
      parentPath: slash < 0 ? "" : input.path.slice(0, slash),
      size: input.size ?? stored?.size ?? 0,
      chunkRefs: stored?.chunkRefs ?? null,
      metadata: input.metadata ?? null,
    });
    return id;
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    process.env.DATABASE_URL = url;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.STORAGE_TARGET = "local";
    storageDir = await mkdtemp(join(tmpdir(), "restow-preview-test-"));
    process.env.STORAGE_LOCAL_PATH = storageDir;

    db = createDb(url);
    f = await createExplorerFixture(db);

    secretsLib = await import("../../lib/secrets.js");
    // The installation default comes from the environment this suite sets (STORAGE_*), uncached,
    // not from the installation pool of a configured server (lib/installation-default.ts).
    (await import("../../lib/installation-default.js")).setInstallationDefaultResolver(
      new InstallationDefaultResolver({ ttlMs: 0 }),
    );
    await withTenantTx(db, f.tenantId, (tx) => secretsLib.createTenantKey(tx, f.tenantId));
    const dek = await withTenantTx(db, f.tenantId, (tx) =>
      secretsLib.loadTenantDek(tx, f.tenantId),
    );
    keys = new Keyring(f.tenantId, [dek]);

    service = await import("./service.js");
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await shared.db.$client.end();
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await rm(storageDir, { recursive: true, force: true });
  });

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

  describe("previewMailEntry", () => {
    it("decrypts, parses and sanitises a real message, and audits the read", async () => {
      const entryId = await insertMailEntry({
        snapshotId: f.mailbox.second,
        protectedObjectId: f.annaMailbox,
        path: "mail/Inbox/Board.zzzz.eml",
        content: HTML_MAIL,
        metadata: { subject: "Board deck", from: "anna@contoso.test" },
      });

      const preview = await service.previewMailEntry(
        db,
        f.tenantId,
        reader(f.admin),
        f.mailbox.second,
        entryId,
      );
      expect(preview.previewable).toBe(true);
      if (!preview.previewable) throw new Error("expected previewable");
      expect(preview.headers.subject).toBe("Board deck");
      expect(preview.body.kind).toBe("html");
      expect(preview.body.content).not.toMatch(/<script|onclick/i);
      expect(preview.body.content).not.toContain("tracker.example.com");
      expect(preview.body.content).toContain("data:image/png;base64,");
      expect(preview.attachments.map((a) => a.filename)).toContain("board.pdf");

      const entry = await entriesBy(f.admin, service.SNAPSHOT_AUDIT_ACTIONS.mailPreviewed, entryId);
      expect(entry[0]).toMatchObject({
        targetType: "manifest_object",
        onBehalfOf: "anna@contoso.test",
        ip: CLIENT_IP,
      });
      expect(entry[0]?.details).toMatchObject({ previewable: true, snapshotId: f.mailbox.second });
    });

    describe("a hostile message (these stalled the API: 8.7 s for 4 MB, 25 s for 1.5 MB)", () => {
      const QP_BOMB = eml([
        "From: Mallory <mallory@example.test>",
        "Subject: slow",
        "Content-Type: text/plain",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        // 14.4 MB, under PREVIEW_SIZE_CAP_BYTES: mailparser 3.9.31 decodes it in linear time, still
        // well over the 400 ms (text: 200 ms) the tests below allow.
        "=\r\n=3D".repeat(2_400_000),
      ]);
      /**
       * An HTML body longer than the preview formats (MAX_SANITIZED_HTML_CHARS), shorter than the
       * message size it opens at all (PREVIEW_SIZE_CAP_BYTES). The formatted view is over its limit
       * by construction: the preview shows the text and says so, whatever the speed of the machine
       * (nested markup that is slow to sanitise would depend on it; the retry that follows such a
       * timeout is covered with explicit budgets in preview-isolated.test.ts).
       */
      const LONG_HTML = eml([
        "From: Mallory <mallory@example.test>",
        "Subject: long",
        "Content-Type: text/html",
        "",
        `<p>words here</p><p>${"filler ".repeat(Math.ceil(MAX_SANITIZED_HTML_CHARS / 7) + 1000)}</p>`,
      ]);
      let previewConfig: { timeoutMs: number };
      let savedTimeout: number;

      beforeAll(async () => {
        previewConfig = (await import("../../config.js")).config.preview;
        savedTimeout = previewConfig.timeoutMs;
      });
      afterEach(() => {
        previewConfig.timeoutMs = savedTimeout;
      });

      async function warm() {
        const entryId = await insertMailEntry({
          snapshotId: f.mailbox.second,
          protectedObjectId: f.annaMailbox,
          path: `mail/Inbox/Warm.${randomUUID().slice(0, 8)}.eml`,
          content: HTML_MAIL,
        });
        await service.previewMailEntry(db, f.tenantId, reader(f.admin), f.mailbox.second, entryId);
      }

      it("shows the text of a message whose formatted view runs over the limit, and says so in the audit entry", async () => {
        await warm();
        // Both limits are about what the message is, not how fast the machine is. The time limit
        // is generous: a slow runner may take long to start the process this size gets, and the
        // message must not fail on it (it would still end as the text, through the retry).
        previewConfig.timeoutMs = 30_000;
        expect(LONG_HTML.length).toBeGreaterThan(MAX_SANITIZED_HTML_CHARS);
        expect(LONG_HTML.length).toBeLessThan(PREVIEW_SIZE_CAP_BYTES);
        const entryId = await insertMailEntry({
          snapshotId: f.mailbox.second,
          protectedObjectId: f.annaMailbox,
          path: "mail/Inbox/Long.aaaa.eml",
          content: LONG_HTML,
          metadata: { subject: "long" },
        });
        const preview = await service.previewMailEntry(
          db,
          f.tenantId,
          reader(f.admin),
          f.mailbox.second,
          entryId,
        );
        // Only what is asserted: the text is as long as the message, a failure must not print it.
        expect({
          previewable: preview.previewable,
          simplified: preview.previewable ? preview.simplified : undefined,
          bodyKind: preview.previewable ? preview.body.kind : undefined,
          showsText: preview.previewable && preview.body.content.includes("words here"),
          hasMarkup: preview.previewable && preview.body.content.includes("<"),
        }).toEqual({
          previewable: true,
          simplified: true,
          bodyKind: "text",
          showsText: true,
          hasMarkup: false,
        });
        const entry = await entriesBy(
          f.admin,
          service.SNAPSHOT_AUDIT_ACTIONS.mailPreviewed,
          entryId,
        );
        expect(entry[0]?.details).toMatchObject({ previewable: true });
      }, 90_000);

      it("answers 'unreadable' with the headers of the manifest for a message that stays slow, instead of hanging", async () => {
        await warm();
        previewConfig.timeoutMs = 400;
        const entryId = await insertMailEntry({
          snapshotId: f.mailbox.second,
          protectedObjectId: f.annaMailbox,
          path: "mail/Inbox/Slow.bbbb.eml",
          content: QP_BOMB,
          metadata: { subject: "slow", from: "mallory@example.test" },
        });
        const started = Date.now();
        const preview = await service.previewMailEntry(
          db,
          f.tenantId,
          reader(f.admin),
          f.mailbox.second,
          entryId,
        );
        expect(Date.now() - started).toBeLessThan(30_000);
        expect(preview).toMatchObject({
          previewable: false,
          reason: "unreadable",
          headers: { subject: "slow", from: "mallory@example.test" },
          attachments: [],
        });
        const entry = await entriesBy(
          f.admin,
          service.SNAPSHOT_AUDIT_ACTIONS.mailPreviewed,
          entryId,
        );
        expect(entry[0]?.details).toMatchObject({ previewable: false, reason: "unreadable" });
        // The API is still fine: the next preview works.
        await warm();
      }, 60_000);

      it("refuses the attachment download of such a message with a problem that says what to do", async () => {
        await warm();
        previewConfig.timeoutMs = 400;
        const entryId = await insertMailEntry({
          snapshotId: f.mailbox.second,
          protectedObjectId: f.annaMailbox,
          path: "mail/Inbox/SlowDownload.cccc.eml",
          content: QP_BOMB,
        });
        await expect(
          service.openAttachmentDownload(
            db,
            f.tenantId,
            reader(f.admin),
            f.mailbox.second,
            entryId,
            "att-0",
          ),
        ).rejects.toMatchObject({
          status: 422,
          type: "urn:restow:problem:preview-unreadable",
        });
        expect(
          await entriesBy(f.admin, service.SNAPSHOT_AUDIT_ACTIONS.attachmentDownloaded, entryId),
        ).toEqual([]);
      }, 60_000);
    });

    it("detects a rights-protected message from its content when no flag was recorded", async () => {
      const entryId = await insertMailEntry({
        snapshotId: f.mailbox.second,
        protectedObjectId: f.annaMailbox,
        path: "mail/Inbox/Confidential.yyyy.eml",
        content: RPMSG_MAIL_NO_FLAG,
      });
      const preview = await service.previewMailEntry(
        db,
        f.tenantId,
        reader(f.admin),
        f.mailbox.second,
        entryId,
      );
      expect(preview).toMatchObject({
        previewable: false,
        reason: "rights-protected",
        attachments: [],
      });
    });

    it("never opens content for a message already flagged protected, too-large, or oversized-format", async () => {
      const protectedId = await insertMailEntry({
        snapshotId: f.mailbox.second,
        protectedObjectId: f.annaMailbox,
        path: "mail/Inbox/Flagged.wwww.eml",
        metadata: { subject: "Flagged", protection: "smime-encrypted" },
        size: 500,
      });
      const tooLargeId = await insertMailEntry({
        snapshotId: f.mailbox.second,
        protectedObjectId: f.annaMailbox,
        path: "mail/Inbox/Huge.vvvv.eml",
        metadata: { subject: "Huge" },
        size: 50 * 1024 * 1024,
      });
      const oversizedFormatId = await insertMailEntry({
        snapshotId: f.mailbox.second,
        protectedObjectId: f.annaMailbox,
        path: "mail/Inbox/Oversized.uuuu.json",
        metadata: { subject: "Oversized", format: "json" },
        size: 500,
      });

      // None of these three have chunkRefs, so a preview that tried to read
      // content would throw; getting a clean result proves the shortcut.
      await expect(
        service.previewMailEntry(db, f.tenantId, reader(f.admin), f.mailbox.second, protectedId),
      ).resolves.toMatchObject({ previewable: false, reason: "smime-encrypted" });
      await expect(
        service.previewMailEntry(db, f.tenantId, reader(f.admin), f.mailbox.second, tooLargeId),
      ).resolves.toMatchObject({ previewable: false, reason: "too-large" });
      await expect(
        service.previewMailEntry(
          db,
          f.tenantId,
          reader(f.admin),
          f.mailbox.second,
          oversizedFormatId,
        ),
      ).resolves.toMatchObject({ previewable: false, reason: "unsupported-format" });
    });

    it("refuses another person's mailbox to an end user and writes no audit entry", async () => {
      const entryId = await insertMailEntry({
        snapshotId: f.mailbox.second,
        protectedObjectId: f.annaMailbox,
        path: "mail/Inbox/BobCannotSee.tttt.eml",
        content: HTML_MAIL,
      });
      await expect(
        service.previewMailEntry(db, f.tenantId, reader(f.bob), f.mailbox.second, entryId),
      ).rejects.toMatchObject({ status: 404 });
      expect(await entriesBy(f.bob, service.SNAPSHOT_AUDIT_ACTIONS.mailPreviewed, entryId)).toEqual(
        [],
      );
    });

    it("404s for an id that is not a mail entry (a folder)", async () => {
      const [folder] = await db
        .select({ id: manifestObjects.id })
        .from(manifestObjects)
        .where(
          and(
            eq(manifestObjects.tenantId, f.tenantId),
            eq(manifestObjects.snapshotId, f.mailbox.first),
            eq(manifestObjects.path, "mail/Inbox"),
          ),
        )
        .limit(1);
      await expect(
        service.previewMailEntry(
          db,
          f.tenantId,
          reader(f.admin),
          f.mailbox.first,
          folder?.id as string,
        ),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("openAttachmentDownload", () => {
    it("streams one attachment and audits the download", async () => {
      const entryId = await insertMailEntry({
        snapshotId: f.mailbox.second,
        protectedObjectId: f.annaMailbox,
        path: "mail/Inbox/BoardForDownload.ssss.eml",
        content: HTML_MAIL,
      });
      const preview = await service.previewMailEntry(
        db,
        f.tenantId,
        reader(f.admin),
        f.mailbox.second,
        entryId,
      );
      if (!preview.previewable) throw new Error("expected previewable");
      const attachmentId = preview.attachments.find((a) => a.filename === "board.pdf")
        ?.id as string;
      attachmentParamSchema.parse({ snapshotId: f.mailbox.second, entryId, attachmentId });

      const download = await service.openAttachmentDownload(
        db,
        f.tenantId,
        reader(f.admin),
        f.mailbox.second,
        entryId,
        attachmentId,
      );
      expect(download.filename).toBe("board.pdf");
      expect(download.contentType).toBe("application/pdf");
      expect(download.content.toString("utf8")).toBe("%PDF-1.4\n");

      const entry = await entriesBy(
        f.admin,
        service.SNAPSHOT_AUDIT_ACTIONS.attachmentDownloaded,
        entryId,
      );
      expect(entry[0]).toMatchObject({ onBehalfOf: "anna@contoso.test" });
      expect(entry[0]?.details).toMatchObject({ attachmentId, filename: "board.pdf" });
    });

    it("404s for an unknown attachment id and for another person's mailbox, writing no audit entry for the denial", async () => {
      const entryId = await insertMailEntry({
        snapshotId: f.mailbox.second,
        protectedObjectId: f.annaMailbox,
        path: "mail/Inbox/NoSuchAttachment.rrrr.eml",
        content: HTML_MAIL,
      });
      await expect(
        service.openAttachmentDownload(
          db,
          f.tenantId,
          reader(f.admin),
          f.mailbox.second,
          entryId,
          "att-99",
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.openAttachmentDownload(
          db,
          f.tenantId,
          reader(f.bob),
          f.mailbox.second,
          entryId,
          "att-0",
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        await entriesBy(f.bob, service.SNAPSHOT_AUDIT_ACTIONS.attachmentDownloaded, entryId),
      ).toEqual([]);
    });
  });

  describe("objects?include=all", () => {
    it("lists an object that has never been backed up, with zero restore points", async () => {
      const withBackup = listObjectsQuerySchema.parse({});
      const before = await service.listObjects(db, f.tenantId, f.admin, withBackup);
      expect(before.some((o) => o.externalId === "carol@contoso.test")).toBe(false);

      await db.insert(protectedObjects).values({
        tenantId: f.tenantId,
        sourceId: (
          await db
            .select({ id: protectedObjects.sourceId })
            .from(protectedObjects)
            .where(eq(protectedObjects.id, f.annaMailbox))
            .limit(1)
        )[0]?.id as string,
        kind: "mailbox",
        externalId: "carol@contoso.test",
        displayName: "Carol",
      });

      const all = listObjectsQuerySchema.parse({ include: "all" });
      const rows = await service.listObjects(db, f.tenantId, f.admin, all);
      const carol = rows.find((o) => o.externalId === "carol@contoso.test");
      expect(carol).toMatchObject({
        displayName: "Carol",
        sourceKind: "m365",
        snapshotCount: 0,
        latestSnapshotId: null,
        latestSnapshotAt: null,
        readiness: "no_backup",
      });

      const stillDefault = await service.listObjects(db, f.tenantId, f.admin, withBackup);
      expect(stillDefault.some((o) => o.externalId === "carol@contoso.test")).toBe(false);
    });
  });

  describe("tree sort", () => {
    it("orders undated mail naturally (2, 10, 11) instead of lexically (1, 10, 11, 2)", async () => {
      await db.insert(manifestObjects).values(
        ["2.eml", "10.eml", "11.eml"].map((name) => ({
          tenantId: f.tenantId,
          snapshotId: f.imap,
          protectedObjectId: f.imapAccount,
          kind: "mail" as const,
          path: `mail/INBOX/${name}`,
          name,
          parentPath: "mail/INBOX",
          size: 10,
        })),
      );
      const dateOrder = await service.listTree(
        db,
        f.tenantId,
        reader(f.admin),
        f.imap,
        treeQuerySchema.parse({ path: "mail/INBOX" }),
      );
      // Every entry here is undated, so the natural-name fallback decides the order.
      expect(dateOrder.entries.map((e) => e.name)).toEqual(["1.eml", "2.eml", "10.eml", "11.eml"]);

      const nameOrder = await service.listTree(
        db,
        f.tenantId,
        reader(f.admin),
        f.imap,
        treeQuerySchema.parse({ path: "mail/INBOX", sort: "name" }),
      );
      expect(nameOrder.entries.map((e) => e.name)).toEqual(["1.eml", "2.eml", "10.eml", "11.eml"]);
    });
  });
});
