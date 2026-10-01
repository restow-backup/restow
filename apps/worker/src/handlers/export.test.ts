import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  Keyring,
  type ProtectedObjectRef,
  createMemoryJobContext,
  generateDek,
  mailfiles,
} from "@restow/core";
import type { Database, MailExport } from "@restow/db";
import { describe, expect, it } from "vitest";
import { readZip } from "../../../../packages/core/src/restore/testing/zip-reader.js";
import { type ExportStore, createExportHandler, exportFileName, fileKindOf } from "./export.js";
import { InvalidPayloadError, type WorkerJobContext } from "./framework.js";

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";
const JOB = "5d2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
const EXPORT = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
const NOW = new Date(Date.UTC(2026, 8, 30, 12));

const object: ProtectedObjectRef = {
  id: "1b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b",
  tenantId: TENANT,
  sourceId: "2b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b",
  kind: "imap",
  externalId: "import-1b2f2c6e",
  displayName: "Legacy mailbox",
  userId: null,
};

class MemoryStorage {
  readonly files = new Map<string, Buffer>();
  async put(key: string, data: Buffer | Readable) {
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(data)) {
      chunks.push(data);
    } else {
      for await (const part of data) {
        chunks.push(part as Buffer);
      }
    }
    this.files.set(key, Buffer.concat(chunks));
  }
  async get(key: string) {
    const found = this.files.get(key);
    if (!found) {
      throw new Error(`ENOENT ${key}`);
    }
    return Buffer.from(found);
  }
  async getStream(key: string) {
    return Readable.from([await this.get(key)]);
  }
  async head(key: string) {
    const found = this.files.get(key);
    return found ? { size: found.length } : null;
  }
  async list(prefix: string) {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}

function eml(subject: string, id: string): Buffer {
  return Buffer.from(
    `From: bob@example.test\r\nTo: alice@example.test\r\nSubject: ${subject}\r\nMessage-ID: <${id}@example.test>\r\nDate: Tue, 05 Mar 2019 14:12:00 +0000\r\n\r\nbody of ${subject}\r\n`,
  );
}

function meta(raw: Buffer): mailfiles.MessageMeta {
  const text = raw.toString("utf8");
  return {
    messageId: /^Message-ID:\s*(\S+)/im.exec(text)?.[1] ?? null,
    subject: /^Subject:\s*(.*)$/im.exec(text)?.[1]?.trim() ?? "",
    from: "bob@example.test",
    to: ["alice@example.test"],
    toCount: 1,
    cc: [],
    ccCount: 0,
    hasAttachments: false,
    attachmentCount: 0,
    sentAt: new Date("2019-03-05T14:12:00Z"),
    protection: null,
    bodyText: "",
  };
}

const MESSAGES: { folder: string[]; raw: Buffer }[] = [
  { folder: ["Inbox"], raw: eml("Offer", "o1") },
  { folder: ["Inbox"], raw: eml("Contract", "o2") },
  { folder: ["Inbox", "Clients"], raw: eml("Kickoff", "o3") },
];

async function snapshotWith(
  ctx: WorkerJobContext,
  messages: { folder: string[]; raw: Buffer }[],
): Promise<string> {
  const walk = async function* (): AsyncGenerator<mailfiles.MailWalkEvent> {
    for (const [index, message] of messages.entries()) {
      yield {
        type: "message",
        ref: `x.mbox#${index}`,
        index,
        folder: message.folder,
        sourceName: `${index}`,
        format: "mbox",
        raw: message.raw,
        synthesized: false,
        flags: [],
        internalDate: null,
        sourceBytes: message.raw.length,
      };
    }
  };
  const file: mailfiles.MailInputFile = {
    path: "x.mbox",
    size: 100,
    open: () => Readable.from([Buffer.alloc(100)]),
    read: async () => Buffer.alloc(10),
  };
  const result = await new mailfiles.MailImportEngine({
    walk,
    parseMeta: async (raw) => meta(raw),
    detect: () => ({ format: "mbox" }),
  }).run(ctx, object, {
    groups: [{ label: "x.mbox", size: 100, kind: "file" }],
    units: [{ key: "k", group: 0, kind: "file", path: "x.mbox", size: 100 }],
    open: () => file,
  });
  return result.snapshotId;
}

function exportRow(overrides: Partial<MailExport> = {}): MailExport {
  return {
    id: EXPORT,
    tenantId: TENANT,
    jobId: JOB,
    origin: "snapshot",
    format: "eml_zip",
    snapshotId: null,
    protectedObjectId: object.id,
    selection: { all: true },
    fileName: null,
    contentType: null,
    fileSize: null,
    segmentSize: null,
    sha256: null,
    report: null,
    expiresAt: null,
    purgedAt: null,
    actorUserId: null,
    impersonated: false,
    reason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fakeStore(row: MailExport | null, used = 0) {
  const results: Parameters<ExportStore["persistResult"]>[1][] = [];
  const store: ExportStore = {
    usedBytes: async () => used,
    loadExport: async () => row,
    countArchive: async () => 0,
    archivePage: async () => ({ rows: [], lastKey: null }),
    mailboxNames: async () => new Map(),
    persistResult: async (_id, result) => {
      results.push(result);
      return { accepted: true };
    },
    persistJobResult: async () => undefined,
    persistRuntimeState: async () => undefined,
  };
  return { store, results };
}

function setup() {
  const storage = new MemoryStorage();
  const base = createMemoryJobContext({
    tenantId: TENANT,
    jobId: JOB,
    keys: new Keyring(TENANT, [generateDek(1)]),
    storage: storage as never,
    now: () => NOW,
  });
  const ctx: WorkerJobContext = { ...base, db: {} as Database, protectedObject: object };
  return { storage, ctx };
}

async function readExport(
  ctx: WorkerJobContext,
  result: { fileSize: number; segmentSize: number },
): Promise<Buffer> {
  const segments = new mailfiles.SegmentStore({ storage: ctx.storage.primary, keys: ctx.keys });
  const parts: Buffer[] = [];
  for await (const part of segments.readStream(
    { tenantId: TENANT, kind: "export", id: EXPORT },
    { size: result.fileSize, segmentSize: result.segmentSize },
  )) {
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}

const payload = { jobId: JOB, tenantId: TENANT, exportId: EXPORT, protectedObjectId: object.id };

describe("file naming", () => {
  it("makes a safe file name and picks .mbox only for one folder", () => {
    const zip = fileKindOf("eml_zip", true);
    expect(exportFileName("../My Export: 2019.zip", zip, NOW)).toBe("My Export- 2019.zip");
    expect(exportFileName(null, zip, NOW)).toMatch(/^mail-export-\d{8}t\d{6}\.zip$/);
    expect(fileKindOf("mbox", true)).toEqual({
      extension: ".mbox",
      contentType: "application/mbox",
    });
    expect(fileKindOf("mbox", false).extension).toBe(".zip");
    expect(fileKindOf("eml_zip", true).extension).toBe(".zip");
  });
});

describe("the export handler", () => {
  it("writes an EML ZIP with the folder structure, checksums and an expiry, sealed in storage", async () => {
    const { storage, ctx } = setup();
    const snapshotId = await snapshotWith(ctx, MESSAGES);
    const harness = fakeStore(exportRow({ snapshotId }));
    const outcome = await createExportHandler({ env: {}, store: () => harness.store }).run(
      ctx,
      payload,
    );

    expect(outcome?.summary).toMatchObject({ messages: 3, failed: 0 });
    const [result] = harness.results;
    if (!result) {
      throw new Error("no result stored");
    }
    expect(result.contentType).toBe("application/zip");
    expect(result.fileName).toMatch(/\.zip$/);
    expect(result.expiresAt.getTime()).toBe(NOW.getTime() + 24 * 3_600_000);
    expect(result.report).toMatchObject({
      messages: 3,
      failed: 0,
      skipped: { calendar: 0, contacts: 0, other: 0 },
    });

    // Sealed at rest: the stored segments never contain the message text.
    const stored = [...storage.files.entries()].filter(([key]) => key.includes("/exports/"));
    expect(stored.length).toBeGreaterThan(0);
    for (const [, bytes] of stored) {
      expect(bytes.includes(Buffer.from("body of Offer"))).toBe(false);
    }

    const file = await readExport(ctx, result);
    expect(createHash("sha256").update(file).digest("hex")).toBe(result.sha256);
    const entries = readZip(file);
    const emls = entries.filter((entry) => entry.name.endsWith(".eml"));
    expect(emls.map((entry) => entry.name.split("/").slice(0, -1).join("/")).sort()).toEqual([
      "Inbox",
      "Inbox",
      "Inbox/Clients",
    ]);
    for (const original of MESSAGES) {
      expect(emls.some((entry) => entry.data.equals(original.raw))).toBe(true);
    }
    const names = entries.map((entry) => entry.name);
    expect(names).toContain("MANIFEST.csv");
    expect(names).toContain("SHA256SUMS");
    const sums = entries.find((entry) => entry.name === "SHA256SUMS")?.data.toString("utf8") ?? "";
    for (const entry of emls) {
      expect(sums).toContain(
        `${createHash("sha256").update(entry.data).digest("hex")}  ${entry.name}`,
      );
    }
  });

  it("exports one folder as a single .mbox file that can be read back message by message", async () => {
    const { ctx } = setup();
    const snapshotId = await snapshotWith(ctx, MESSAGES.slice(0, 2));
    const harness = fakeStore(exportRow({ snapshotId, format: "mbox", selection: { all: true } }));
    await createExportHandler({ env: {}, store: () => harness.store }).run(ctx, payload);
    const [result] = harness.results;
    if (!result) {
      throw new Error("no result stored");
    }
    expect(result.fileName).toMatch(/\.mbox$/);
    expect(result.contentType).toBe("application/mbox");
    const file = await readExport(ctx, result);
    const text = file.toString("utf8");
    expect(text.startsWith("From ")).toBe(true);
    expect(text.split("\nFrom ").length).toBeGreaterThanOrEqual(2);
    expect(text).toContain("Subject: Offer");
    expect(text).toContain("Subject: Contract");
  });

  it("exports several folders as MBOX inside a ZIP, one file per folder", async () => {
    const { ctx } = setup();
    const snapshotId = await snapshotWith(ctx, MESSAGES);
    const harness = fakeStore(exportRow({ snapshotId, format: "mbox" }));
    await createExportHandler({ env: {}, store: () => harness.store }).run(ctx, payload);
    const [result] = harness.results;
    if (!result) {
      throw new Error("no result stored");
    }
    expect(result.fileName).toMatch(/\.zip$/);
    // The archive is ZIP64 (an MBOX file can exceed 4 GiB); the entry names are plain text in it.
    const file = await readExport(ctx, result);
    expect(file.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(file.includes(Buffer.from("Inbox.mbox"))).toBe(true);
    expect(file.includes(Buffer.from("Inbox/Clients.mbox"))).toBe(true);
  });

  it("exports a selected folder only and honours the expiry setting", async () => {
    const { ctx } = setup();
    const snapshotId = await snapshotWith(ctx, MESSAGES);
    const harness = fakeStore(
      exportRow({ snapshotId, selection: { folderPaths: ["mail/Inbox/Clients"] } }),
    );
    await createExportHandler({ env: { EXPORT_TTL_HOURS: "2" }, store: () => harness.store }).run(
      ctx,
      payload,
    );
    const [result] = harness.results;
    if (!result) {
      throw new Error("no result stored");
    }
    expect(result.report).toMatchObject({ messages: 1 });
    expect(result.expiresAt.getTime()).toBe(NOW.getTime() + 2 * 3_600_000);
  });

  it("refuses a format that is not available (PST) and an unknown export", async () => {
    const { ctx } = setup();
    await expect(
      createExportHandler({
        env: {},
        store: () => fakeStore(exportRow({ format: "pst" as never })).store,
      }).run(ctx, payload),
    ).rejects.toThrow(InvalidPayloadError);
    // MSG is not offered (no writer with a clear permissive license).
    await expect(
      createExportHandler({
        env: {},
        store: () => fakeStore(exportRow({ format: "msg_zip" })).store,
      }).run(ctx, payload),
    ).rejects.toThrow(InvalidPayloadError);
    await expect(
      createExportHandler({ env: {}, store: () => fakeStore(null).store }).run(ctx, payload),
    ).rejects.toThrow(/does not exist/);
  });

  describe("the storage limit for exports", () => {
    const storedExportSegments = (storage: MemoryStorage) =>
      [...storage.files.keys()].filter((key) => key.includes("/exports/"));

    it("writes nothing when the other exports already use the whole limit", async () => {
      const { storage, ctx } = setup();
      const snapshotId = await snapshotWith(ctx, MESSAGES);
      const harness = fakeStore(exportRow({ snapshotId }), 1_000_000);
      const failure = await createExportHandler({
        env: { EXPORT_MAX_TENANT_BYTES: "1000000" },
        store: () => harness.store,
      })
        .run(ctx, payload)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InvalidPayloadError);
      expect((failure as InvalidPayloadError).failure).toMatchObject({
        code: "export.quota_exceeded",
        transient: false,
        technical: { usedBytes: 1_000_000, limitBytes: 1_000_000 },
      });
      expect(harness.results).toEqual([]);
      expect(storedExportSegments(storage)).toEqual([]);
    });

    it("stops writing when the file would go beyond what is left, and deletes what it wrote", async () => {
      const { storage, ctx } = setup();
      const snapshotId = await snapshotWith(ctx, MESSAGES);
      const harness = fakeStore(exportRow({ snapshotId }), 0);
      const failure = await createExportHandler({
        env: { EXPORT_MAX_TENANT_BYTES: "300" },
        store: () => harness.store,
      })
        .run(ctx, payload)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InvalidPayloadError);
      expect((failure as InvalidPayloadError).failure?.code).toBe("export.quota_exceeded");
      expect(harness.results).toEqual([]);
      expect(storedExportSegments(storage)).toEqual([]);
    });

    it("takes the room other exports use into account", async () => {
      const { ctx } = setup();
      const snapshotId = await snapshotWith(ctx, MESSAGES);
      const limit = String(1024 * 1024);
      const fits = fakeStore(exportRow({ snapshotId }), 0);
      await createExportHandler({
        env: { EXPORT_MAX_TENANT_BYTES: limit },
        store: () => fits.store,
      }).run(ctx, payload);
      expect(fits.results).toHaveLength(1);
      const size = fits.results[0]?.fileSize as number;

      const { ctx: second } = setup();
      const snapshot2 = await snapshotWith(second, MESSAGES);
      const tight = fakeStore(exportRow({ snapshotId: snapshot2 }), 1024 * 1024 - size + 1);
      await expect(
        createExportHandler({
          env: { EXPORT_MAX_TENANT_BYTES: limit },
          store: () => tight.store,
        }).run(second, payload),
      ).rejects.toThrow(InvalidPayloadError);
      const exact = fakeStore(exportRow({ snapshotId: snapshot2 }), 1024 * 1024 - size);
      await createExportHandler({
        env: { EXPORT_MAX_TENANT_BYTES: limit },
        store: () => exact.store,
      }).run(second, payload);
      expect(exact.results).toHaveLength(1);
    });

    it("deletes the file and fails when another export took the room before this one was recorded", async () => {
      const { storage, ctx } = setup();
      const snapshotId = await snapshotWith(ctx, MESSAGES);
      const harness = fakeStore(exportRow({ snapshotId }), 0);
      harness.store.persistResult = async () => ({ accepted: false, usedBytes: 49_999_999_000 });
      const failure = await createExportHandler({ env: {}, store: () => harness.store })
        .run(ctx, payload)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InvalidPayloadError);
      expect((failure as InvalidPayloadError).failure).toMatchObject({
        code: "export.quota_exceeded",
        technical: { usedBytes: 49_999_999_000 },
      });
      expect(storedExportSegments(storage)).toEqual([]);
    });
  });

  it("deletes the partial file when the export fails and reports a message that cannot be opened", async () => {
    const { storage, ctx } = setup();
    const snapshotId = await snapshotWith(ctx, MESSAGES.slice(0, 2));
    // Damage the stored chunks: every message fails to open, none is written.
    for (const [key, bytes] of storage.files) {
      if (key.includes("/packs/")) {
        const damaged = Buffer.from(bytes);
        damaged[Math.floor(damaged.length / 2)] =
          (damaged[Math.floor(damaged.length / 2)] ?? 0) ^ 0xff;
        storage.files.set(key, damaged);
      }
    }
    const harness = fakeStore(exportRow({ snapshotId }));
    await expect(
      createExportHandler({ env: {}, store: () => harness.store }).run(ctx, payload),
    ).rejects.toBeTruthy();
    expect([...storage.files.keys()].filter((key) => key.includes("/exports/"))).toEqual([]);
    expect(harness.results).toEqual([]);
  });
});
