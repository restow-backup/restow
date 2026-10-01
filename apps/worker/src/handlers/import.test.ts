import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  Keyring,
  type ProtectedObjectRef,
  createMemoryJobContext,
  generateDek,
  mailfiles,
} from "@restow/core";
import type { Database, ImportUpload, MailImport, MailImportRequestFile } from "@restow/db";
import { describe, expect, it, vi } from "vitest";
import { InvalidPayloadError, type WorkerJobContext } from "./framework.js";
import {
  type ImportStore,
  baseNameOf,
  buildImportInput,
  createImportHandler,
  openTenantImportFolder,
  tenantRelativePath,
} from "./import.js";

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";
const JOB = "5d2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
const IMPORT = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
const UPLOAD = "3c2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";

const object: ProtectedObjectRef = {
  id: "1b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b",
  tenantId: TENANT,
  sourceId: "2b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b",
  kind: "imap",
  externalId: "import-1b2f2c6e",
  displayName: "Legacy mailbox",
  userId: null,
};

function eml(subject: string, id: string): Buffer {
  return Buffer.from(
    `From: bob@example.test\r\nTo: alice@example.test\r\nSubject: ${subject}\r\nMessage-ID: <${id}@example.test>\r\n\r\nbody\r\n`,
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
    sentAt: null,
    protection: null,
    bodyText: "",
  };
}

function uploadRow(status: ImportUpload["status"] = "consumed"): ImportUpload {
  return {
    id: UPLOAD,
    tenantId: TENANT,
    createdBy: null,
    fileName: "C:\\mail\\legacy.mbox",
    size: 4096,
    segmentSize: 64 * 1024,
    segmentCount: 1,
    status,
    detectedFormat: "mbox",
    importId: IMPORT,
    expiresAt: new Date(Date.UTC(2027, 0, 1)),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function importRow(
  files: MailImportRequestFile[],
  options: { archive: boolean } = { archive: false },
  report: Record<string, unknown> | null = null,
): MailImport {
  return {
    id: IMPORT,
    tenantId: TENANT,
    sourceId: object.sourceId,
    protectedObjectId: object.id,
    jobId: JOB,
    name: "Legacy mailbox",
    files,
    options,
    report,
    createdBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

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
    return found;
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

function fakeStore(row: MailImport | null, uploads: ImportUpload[] = []) {
  const reports: mailfiles.ImportReport[] = [];
  const live: unknown[] = [];
  const results: Record<string, unknown>[] = [];
  let committed: { id: string; sequence: number } | null = null;
  const store: ImportStore = {
    loadImport: async () => row,
    loadUploads: async () => uploads,
    tenantSlug: async () => "acme",
    persistReport: async (_id, report) => {
      reports.push(report);
    },
    committedSnapshot: async () => committed,
    persistLive: async (_job, stats) => {
      live.push(stats);
    },
    persistResult: async (_job, summary) => {
      results.push(summary);
    },
    persistRuntimeState: async () => undefined,
  };
  return {
    store,
    reports,
    live,
    results,
    setCommitted: (value: { id: string; sequence: number }) => {
      committed = value;
    },
  };
}

function context(storage: MemoryStorage): WorkerJobContext {
  const base = createMemoryJobContext({
    tenantId: TENANT,
    jobId: JOB,
    keys: new Keyring(TENANT, [generateDek(1)]),
    storage: storage as never,
    now: () => new Date(Date.UTC(2026, 8, 30, 12)),
  });
  return { ...base, db: {} as Database, protectedObject: object };
}

async function stageUpload(
  storage: MemoryStorage,
  ctx: WorkerJobContext,
  bytes: Buffer,
): Promise<void> {
  const segments = new mailfiles.SegmentStore({ storage, keys: ctx.keys });
  await segments.put({ tenantId: TENANT, kind: "staging", id: UPLOAD }, 0, bytes);
}

/** Walker that turns a staged upload of N bytes into N/100 scripted messages. */
function scriptedWalk(messages: number) {
  return async function* walk(
    file: mailfiles.MailInputFile,
  ): AsyncGenerator<mailfiles.MailWalkEvent> {
    for (let index = 0; index < messages; index++) {
      const raw = eml(`Mail ${index}`, `m${index}`);
      yield {
        type: "message",
        ref: `${file.path}#${index}`,
        index,
        folder: ["Inbox"],
        sourceName: `${index}`,
        format: "mbox",
        raw,
        synthesized: false,
        flags: [],
        internalDate: null,
        sourceBytes: raw.length,
      };
    }
  };
}

describe("baseNameOf", () => {
  it("keeps only the last segment of a name the browser reported", () => {
    expect(baseNameOf("C:\\mail\\legacy.mbox")).toBe("legacy.mbox");
    expect(baseNameOf("../../etc/passwd")).toBe("passwd");
    expect(baseNameOf("")).toBe("file");
  });
});

describe("buildImportInput", () => {
  it("maps an upload to a staged file named like its base name and refuses a lost upload", async () => {
    const storage = new MemoryStorage();
    const ctx = context(storage);
    const segments = new mailfiles.SegmentStore({ storage, keys: ctx.keys });
    const files: MailImportRequestFile[] = [
      {
        origin: "upload",
        uploadId: UPLOAD,
        kind: "file",
        path: "legacy.mbox",
        size: 4096,
        format: "mbox",
      },
    ];
    const input = await buildImportInput({
      files,
      uploads: new Map([[UPLOAD, uploadRow()]]),
      tenantId: TENANT,
      segments,
      folder: null,
      tenantSlug: "acme",
    });
    expect(input.groups).toEqual([{ label: "C:\\mail\\legacy.mbox", size: 4096, kind: "file" }]);
    expect(input.units).toEqual([
      { key: `upload:${UPLOAD}`, group: 0, kind: "file", path: "legacy.mbox", size: 4096 },
    ]);

    await expect(
      buildImportInput({
        files,
        uploads: new Map(),
        tenantId: TENANT,
        segments,
        folder: null,
        tenantSlug: "acme",
      }),
    ).rejects.toThrow(InvalidPayloadError);
    await expect(
      buildImportInput({
        files,
        uploads: new Map([[UPLOAD, uploadRow("cancelled")]]),
        tenantId: TENANT,
        segments,
        folder: null,
        tenantSlug: "acme",
      }),
    ).rejects.toThrow(/no longer available/);
  });

  it("refuses a folder entry when the import folder is not available", async () => {
    const storage = new MemoryStorage();
    const ctx = context(storage);
    await expect(
      buildImportInput({
        files: [{ origin: "folder", kind: "file", path: "a.eml", size: 1, format: null }],
        uploads: new Map(),
        tenantId: TENANT,
        segments: new mailfiles.SegmentStore({ storage, keys: ctx.keys }),
        folder: null,
        tenantSlug: "acme",
      }),
    ).rejects.toThrow(/import folder is not available/);
  });
});

describe("the tenant's server folder", () => {
  async function folderFixture() {
    const root = await mkdtemp(join(tmpdir(), "restow-import-scope-"));
    await mkdir(join(root, "acme", "tree", "Inbox"), { recursive: true });
    await mkdir(join(root, "other"), { recursive: true });
    await writeFile(join(root, "acme", "tree", "Inbox", "a.eml"), eml("A", "a1"));
    await writeFile(join(root, "acme", "one.eml"), eml("One", "o1"));
    await writeFile(join(root, "other", "secret.eml"), eml("Secret", "s1"));
    return root;
  }

  it("reads paths below <slug>/ and shows them without the prefix", async () => {
    const root = await folderFixture();
    try {
      const storage = new MemoryStorage();
      const ctx = context(storage);
      const input = await buildImportInput({
        files: [
          { origin: "folder", kind: "directory", path: "acme/tree", size: 0, format: null },
          { origin: "folder", kind: "file", path: "acme/one.eml", size: 0, format: null },
        ],
        uploads: new Map(),
        tenantId: TENANT,
        segments: new mailfiles.SegmentStore({ storage, keys: ctx.keys }),
        folder: new mailfiles.ImportFolder(join(root, "acme")),
        tenantSlug: "acme",
      });
      expect(input.groups.map((group) => group.label)).toEqual(["tree/", "one.eml"]);
      expect(input.units.flatMap((unit) => (unit.kind === "file" ? [unit.path] : []))).toEqual([
        "Inbox/a.eml",
        "one.eml",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a path of another tenant's folder, a bare path and a parent reference", async () => {
    const root = await folderFixture();
    try {
      const storage = new MemoryStorage();
      const ctx = context(storage);
      for (const path of [
        "other/secret.eml",
        "one.eml",
        "acme/../other/secret.eml",
        "acmeevil/x",
      ]) {
        await expect(
          buildImportInput({
            files: [{ origin: "folder", kind: "file", path, size: 0, format: null }],
            uploads: new Map(),
            tenantId: TENANT,
            segments: new mailfiles.SegmentStore({ storage, keys: ctx.keys }),
            folder: new mailfiles.ImportFolder(join(root, "acme")),
            tenantSlug: "acme",
          }),
        ).rejects.toThrow(/not below this tenant's import folder/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("tenantRelativePath and openTenantImportFolder", () => {
  it("accepts <slug>/... and the bare tenant folder, refuses everything else", () => {
    expect(tenantRelativePath("acme/tree/Inbox", "acme")).toBe("tree/Inbox");
    expect(tenantRelativePath("acme/", "acme")).toBe("");
    expect(tenantRelativePath("acme", "acme")).toBe("");
    for (const bad of ["other/x", "acmeevil/x", "acme/../other/x", "acme/./x", "x", "acme\\x"]) {
      expect(() => tenantRelativePath(bad, "acme"), bad).toThrow(InvalidPayloadError);
    }
  });

  it("roots the folder at the tenant's directory and refuses a directory that is a link elsewhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "restow-import-open-"));
    try {
      await mkdir(join(root, "acme"), { recursive: true });
      await mkdir(join(root, "other"), { recursive: true });
      await writeFile(join(root, "other", "secret.eml"), eml("Secret", "s1"));
      await symlink(join(root, "other"), join(root, "evil"));
      await symlink(join(root, "other"), join(root, "acme", "sneak"));

      const own = await openTenantImportFolder(root, "acme");
      expect(own?.root).toBe(join(root, "acme"));
      // A tenant directory that is a link to a sibling's folder is not the tenant's own.
      expect(await openTenantImportFolder(root, "evil")).toBeNull();
      expect(await openTenantImportFolder(root, "missing")).toBeNull();
      expect(await openTenantImportFolder(root, "../other")).toBeNull();
      // A link inside the tenant's folder that leaves it is refused by the folder itself.
      await expect(own?.file("sneak/secret.eml")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the import handler", () => {
  const files: MailImportRequestFile[] = [
    {
      origin: "upload",
      uploadId: UPLOAD,
      kind: "file",
      path: "legacy.mbox",
      size: 4096,
      format: "mbox",
    },
  ];

  function handlerFor(
    harness: ReturnType<typeof fakeStore>,
    walk: ReturnType<typeof scriptedWalk>,
    extra: Parameters<typeof createImportHandler>[0] = {},
  ) {
    return createImportHandler({
      env: {},
      store: () => harness.store,
      engineOptions: {
        walk,
        parseMeta: async (raw) => meta(raw),
        detect: () => ({ format: "mbox" }),
      },
      ...extra,
    });
  }

  it("imports the staged file, stores the report and deletes the staged segments", async () => {
    const storage = new MemoryStorage();
    const ctx = context(storage);
    await stageUpload(storage, ctx, Buffer.alloc(4096, 7));
    const harness = fakeStore(importRow(files), [uploadRow()]);
    const outcome = await handlerFor(harness, scriptedWalk(3)).run(ctx, {
      jobId: JOB,
      tenantId: TENANT,
      importId: IMPORT,
      protectedObjectId: object.id,
    });

    expect(outcome?.summary).toMatchObject({ messages: 3, failed: 0 });
    expect(harness.reports).toHaveLength(2);
    const stored = harness.reports.at(-1) as mailfiles.ImportReport;
    expect(stored.totals.messages).toBe(3);
    expect(stored.snapshotId).not.toBeNull();
    expect(stored.files[0]).toMatchObject({ path: "C:\\mail\\legacy.mbox", status: "imported" });
    expect(harness.results[0]).toMatchObject({ messages: 3 });
    // The staged upload is gone; the snapshot's chunks are the only copy.
    expect([...storage.files.keys()].filter((key) => key.includes("/staging/"))).toHaveLength(0);
  });

  it("stores the report of a run that found nothing and fails it without retry", async () => {
    const storage = new MemoryStorage();
    const ctx = context(storage);
    await stageUpload(storage, ctx, Buffer.alloc(4096, 7));
    const harness = fakeStore(importRow(files), [uploadRow()]);
    const walk = async function* (
      file: mailfiles.MailInputFile,
    ): AsyncGenerator<mailfiles.MailWalkEvent> {
      yield {
        type: "problem",
        ref: `${file.path}#0`,
        index: 0,
        code: "pst_not_supported",
        reason: "PST and OST import is planned for a later release.",
      };
    };
    await expect(
      handlerFor(harness, walk as never).run(ctx, {
        jobId: JOB,
        tenantId: TENANT,
        importId: IMPORT,
        protectedObjectId: object.id,
      }),
    ).rejects.toThrow(InvalidPayloadError);
    const report = harness.reports[0] as mailfiles.ImportReport;
    expect(report.snapshotId).toBeNull();
    expect(report.items[0]).toMatchObject({ code: "pst_not_supported", outcome: "failed" });
    expect([...storage.files.keys()].filter((key) => key.includes("/staging/"))).toHaveLength(0);
  });

  it("ends a re-import where every message is a duplicate as a success, without a snapshot", async () => {
    const storage = new MemoryStorage();
    const ctx = context(storage);
    const payload = {
      jobId: JOB,
      tenantId: TENANT,
      importId: IMPORT,
      protectedObjectId: object.id,
    };
    await stageUpload(storage, ctx, Buffer.alloc(4096, 7));
    const first = fakeStore(importRow(files), [uploadRow()]);
    await handlerFor(first, scriptedWalk(3)).run(ctx, payload);
    expect((first.reports.at(-1) as mailfiles.ImportReport).totals.messages).toBe(3);

    // The same file again, with the archive asked for: nothing is new, so nothing is archived.
    await stageUpload(storage, ctx, Buffer.alloc(4096, 7));
    const second = fakeStore(importRow(files, { archive: true }), [uploadRow()]);
    const archive = vi.fn();
    const outcome = await handlerFor(second, scriptedWalk(3), { archive }).run(ctx, payload);

    expect(outcome?.summary).toMatchObject({ messages: 0, duplicates: 3, alreadyImported: 3 });
    expect(archive).not.toHaveBeenCalled();
    const report = second.reports.at(-1) as mailfiles.ImportReport;
    expect(report.snapshotId).toBeNull();
    expect(report.totals).toMatchObject({ messages: 0, duplicates: 3, failed: 0 });
    expect(second.results[0]).toMatchObject({
      snapshotId: null,
      messages: 0,
      duplicates: 3,
      alreadyImported: 3,
    });
    // The staged upload is gone, and no second snapshot exists.
    expect([...storage.files.keys()].filter((key) => key.includes("/staging/"))).toHaveLength(0);
    expect((await ctx.snapshots.latestCompleted(object.id))?.sequence).toBe(1);
  });

  it("still fails a re-import when an item could not be read, even if the rest were duplicates", async () => {
    const storage = new MemoryStorage();
    const ctx = context(storage);
    const payload = {
      jobId: JOB,
      tenantId: TENANT,
      importId: IMPORT,
      protectedObjectId: object.id,
    };
    await stageUpload(storage, ctx, Buffer.alloc(4096, 7));
    await handlerFor(fakeStore(importRow(files), [uploadRow()]), scriptedWalk(2)).run(ctx, payload);

    await stageUpload(storage, ctx, Buffer.alloc(4096, 7));
    const inner = scriptedWalk(2);
    const walk = async function* (
      file: mailfiles.MailInputFile,
    ): AsyncGenerator<mailfiles.MailWalkEvent> {
      yield* inner(file);
      yield {
        type: "problem",
        ref: `${file.path}#9`,
        index: 9,
        code: "unreadable",
        reason: "Truncated header block",
      };
    };
    const harness = fakeStore(importRow(files), [uploadRow()]);
    await expect(handlerFor(harness, walk as never).run(ctx, payload)).rejects.toThrow(
      InvalidPayloadError,
    );
    const report = harness.reports[0] as mailfiles.ImportReport;
    expect(report.totals).toMatchObject({ messages: 0, duplicates: 2, failed: 1 });
    expect(harness.results).toHaveLength(0);
  });

  it("archives the new messages when asked and adds the result to the report", async () => {
    const storage = new MemoryStorage();
    const ctx = context(storage);
    await stageUpload(storage, ctx, Buffer.alloc(4096, 7));
    const harness = fakeStore(importRow(files, { archive: true }), [uploadRow()]);
    let archived = 0;
    await handlerFor(harness, scriptedWalk(2), {
      archive: async (options) => {
        archived++;
        expect(options.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
        return { requested: true, ingested: 2, alreadyArchived: 0, failed: 0 };
      },
    }).run(ctx, {
      jobId: JOB,
      tenantId: TENANT,
      importId: IMPORT,
      protectedObjectId: object.id,
    });
    expect(archived).toBe(1);
    const final = harness.reports.at(-1) as mailfiles.ImportReport;
    expect(final.archive).toEqual({ requested: true, ingested: 2, alreadyArchived: 0, failed: 0 });
  });

  it("does not read again when a previous attempt already committed the snapshot", async () => {
    const storage = new MemoryStorage();
    const ctx = context(storage);
    await stageUpload(storage, ctx, Buffer.alloc(4096, 7));
    const previousReport = {
      version: 1,
      startedAt: "2026-09-30T10:00:00.000Z",
      completedAt: "2026-09-30T10:01:00.000Z",
      snapshotId: "11111111-1111-4111-8111-111111111111",
      totals: { messages: 5, duplicates: 0, skipped: 0, failed: 0 },
      files: [],
      items: [],
      itemsOmitted: 0,
      archive: null,
      notes: [],
    };
    const harness = fakeStore(importRow(files, { archive: true }, previousReport), [uploadRow()]);
    harness.setCommitted({ id: "11111111-1111-4111-8111-111111111111", sequence: 3 });
    let walked = 0;
    // biome-ignore lint/correctness/useYield: a walker that must never be called
    const walk = async function* (): AsyncGenerator<mailfiles.MailWalkEvent> {
      walked++;
    };
    let archivedSnapshot = "";
    await handlerFor(harness, walk as never, {
      archive: async (options) => {
        archivedSnapshot = options.snapshotId;
        return { requested: true, ingested: 5, alreadyArchived: 0, failed: 0 };
      },
    }).run(ctx, {
      jobId: JOB,
      tenantId: TENANT,
      importId: IMPORT,
      protectedObjectId: object.id,
    });
    expect(walked).toBe(0);
    expect(archivedSnapshot).toBe("11111111-1111-4111-8111-111111111111");
    expect((harness.reports.at(-1) as mailfiles.ImportReport).archive?.ingested).toBe(5);
  });

  it("rejects a payload without a known import", async () => {
    const storage = new MemoryStorage();
    const harness = fakeStore(null);
    await expect(
      handlerFor(harness, scriptedWalk(1)).run(context(storage), {
        jobId: JOB,
        tenantId: TENANT,
        importId: IMPORT,
        protectedObjectId: object.id,
      }),
    ).rejects.toThrow(/does not exist/);
  });
});
