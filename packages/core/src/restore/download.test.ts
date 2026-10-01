import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryChunkIndex } from "../engine/memory.js";
import type { ManifestObject } from "../manifest.js";
import { chunkReaderFor } from "./common.js";
import {
  ARCHIVE_MANIFEST_COLUMNS,
  ARCHIVE_MANIFEST_NAME,
  DownloadRestoreEngine,
  EntryNamer,
  archiveEntryName,
  archiveFileName,
  createRestoreArchive,
  csvField,
} from "./download.js";
import {
  type SnapshotFixture,
  createSnapshotFixture,
  mimeMessage,
  pseudoRandomBytes,
  restoreRequestFor,
} from "./testing/fixtures.js";
import { parseCsv, readZip } from "./testing/zip-reader.js";

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function drain(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) {
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}

function object(overrides: Partial<ManifestObject> & { path: string }): ManifestObject {
  return { size: 1, mtime: 0, chunks: [], ...overrides };
}

describe("download restore", () => {
  let fixture: SnapshotFixture;
  const bigFile = pseudoRandomBytes(3 * 1024 * 1024 + 777, 42);
  const kickoff = mimeMessage({ messageId: "<one@example.org>", subject: "Quarterly figures" });
  const quoted = mimeMessage({ messageId: "<two@example.org>", subject: 'Re: "quotes"' });

  afterEach(async () => {
    await fixture?.cleanup();
  });

  it("streams a ZIP with EML files, folders and a MANIFEST.csv of SHA-256 hashes", async () => {
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: "anna@example.org",
      now: () => new Date(Date.UTC(2026, 8, 22, 14, 30)),
      objects: [
        { path: "mail", type: "folder", content: "", metadata: { folderKind: "root" } },
        {
          path: "mail/Inbox/Quarterly figures.0a1b.eml",
          type: "mail",
          id: "AAMk1",
          content: kickoff,
          metadata: { messageId: "<one@example.org>", folderPath: "Inbox" },
        },
        {
          path: "mail/Inbox/Projects, 2026/Re: quotes.2b3c",
          type: "mail",
          id: "AAMk2",
          content: quoted,
        },
        {
          path: "mail/Inbox/Big.4d5e.json",
          type: "mail",
          id: "AAMk3",
          content: '{"subject":"Big"}',
          metadata: { format: "json", folderPath: "Inbox" },
        },
        {
          path: "mail/Inbox/Big.4d5e.attachments/Plan.pdf.9f8e",
          type: "attachment",
          id: "AAMk3/att1",
          content: "%PDF-1.7 plan",
          metadata: { messagePath: "mail/Inbox/Big.4d5e.json", name: "Plan.pdf" },
        },
        {
          path: "calendar/Team/Standup.6f7a.json",
          type: "event",
          id: "EV1",
          content: '{"subject":"Standup"}',
        },
        { path: "Documents/big.bin", type: "file", id: "F1", content: bigFile },
        { path: "Documents/Empty", type: "folder", id: "D1", content: "" },
      ],
    });

    const request = restoreRequestFor(fixture, {
      target: { type: "download", ref: null },
      restoreJobId: "0f2a1e0e-3b3c-4d4d-8e8e-9f9f9f9f9f9f",
    });
    const report = await new DownloadRestoreEngine().run(fixture.ctx, request);

    expect(report.failures).toEqual([]);
    expect(report.restored).toBe(6);
    expect(report.unverified).toBe(0);
    expect(report.bytes).toBe(fixture.objects.reduce((sum, o) => sum + o.size, 0));
    expect(report.downloadKey).toBe(
      `tenants/${fixture.ctx.tenantId}/downloads/0f2a1e0e-3b3c-4d4d-8e8e-9f9f9f9f9f9f/restore-20260922t143000.zip`,
    );

    const entries = readZip(await fixture.storage.get(report.downloadKey as string));
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect([...byName.keys()]).toEqual([
      "Documents/Empty/",
      "Documents/big.bin",
      "calendar/Team/Standup.6f7a.json",
      "mail/",
      "mail/Inbox/Big.4d5e.attachments/Plan.pdf",
      "mail/Inbox/Big.4d5e.json",
      "mail/Inbox/Projects, 2026/Re_ quotes.2b3c.eml",
      "mail/Inbox/Quarterly figures.0a1b.eml",
      ARCHIVE_MANIFEST_NAME,
    ]);
    expect(byName.get("Documents/Empty/")?.isDirectory).toBe(true);
    expect(byName.get("Documents/big.bin")?.data.equals(bigFile)).toBe(true);
    expect(byName.get("mail/Inbox/Quarterly figures.0a1b.eml")?.data.toString("utf8")).toBe(
      kickoff,
    );
    expect(byName.get("mail/Inbox/Big.4d5e.attachments/Plan.pdf")?.data.toString()).toBe(
      "%PDF-1.7 plan",
    );

    const csv = parseCsv(byName.get(ARCHIVE_MANIFEST_NAME)?.data.toString("utf8") ?? "");
    expect(csv[0]).toEqual([...ARCHIVE_MANIFEST_COLUMNS]);
    const rows = new Map(csv.slice(1).map((row) => [row[0], row]));
    expect(rows.get("Documents/big.bin")).toEqual([
      "Documents/big.bin",
      "Documents/big.bin",
      "file",
      "added",
      String(bigFile.length),
      sha256Hex(bigFile),
      "2026-01-15T10:30:00.000Z",
      "F1",
      "",
    ]);
    expect(rows.get("mail/Inbox/Projects, 2026/Re_ quotes.2b3c.eml")?.slice(1, 6)).toEqual([
      "mail/Inbox/Projects, 2026/Re: quotes.2b3c",
      "mail",
      "added",
      String(Buffer.byteLength(quoted)),
      sha256Hex(quoted),
    ]);
    expect(rows.get("Documents/Empty/")?.[3]).toBe("directory");
    expect(fixture.ctx.progress.snapshot()).toMatchObject({ total: 6, done: 6, failed: 0 });
  });

  it("restores a selection only and lists missing and content-less objects instead of aborting", async () => {
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: "drive-1",
      objects: [
        { path: "Documents/a.txt", type: "file", id: "A", content: "alpha" },
        { path: "Documents/b.txt", type: "file", id: "B", content: "bravo" },
        { path: "Documents/Notebook", type: "package", id: "N", content: "" },
        { path: "Documents/a.txt:versions/2.0", type: "file-version", id: "A#2.0", content: "alp" },
        { path: "Pictures/c.txt", type: "file", id: "C", content: "charlie" },
      ],
    });
    // Forget one object's chunks: a garbage-collected or corrupted index entry.
    const index = fixture.ctx.chunkIndex as MemoryChunkIndex;
    for (const id of fixture.objects[1]?.chunks ?? []) {
      index.chunks.delete(id);
    }

    const request = restoreRequestFor(fixture, {
      target: { type: "download", ref: null },
      selection: { folderPaths: ["Documents"], objectIds: ["A#2.0"] },
      options: { archiveName: "Docs backup.zip" },
    });
    const report = await new DownloadRestoreEngine().run(fixture.ctx, request);

    expect(report.restored).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.failures).toEqual([
      {
        itemRef: "B",
        reason: "1 of 1 chunks are not in the chunk index",
        cause: expect.objectContaining({ code: "verify.chunk_missing" }),
      },
    ]);
    expect(report.items.find((item) => item.id === "B")?.code).toBe("data_missing");
    expect(report.items.find((item) => item.id === "N")).toMatchObject({
      status: "skipped",
      code: "not_restorable",
    });
    expect(report.downloadKey?.endsWith("/Docs-backup.zip")).toBe(true);

    const entries = readZip(await fixture.storage.get(report.downloadKey as string));
    expect(entries.map((entry) => entry.name)).toEqual([
      "Documents/a.txt",
      "Documents/a (version 2.0).txt",
      ARCHIVE_MANIFEST_NAME,
    ]);
    expect(entries[1]?.data.toString()).toBe("alp");
    const csv = parseCsv(entries[2]?.data.toString("utf8") ?? "");
    expect(csv.map((row) => [row[1], row[3], row[8]])).toEqual([
      ["source_path", "status", "note"],
      [
        "Documents/Notebook",
        "not-included",
        "OneNote notebooks and other packages are recorded without content",
      ],
      ["Documents/a.txt", "added", ""],
      ["Documents/a.txt:versions/2.0", "added", ""],
      ["Documents/b.txt", "missing", "1 of 1 chunks are not in the chunk index"],
    ]);
  });

  it("aborts the archive and removes the partial file when an object fails integrity", async () => {
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: "drive-1",
      objects: [{ path: "Documents/a.txt", type: "file", id: "A", content: "alpha" }],
    });
    const tampered: ManifestObject = {
      ...(fixture.objects[0] as ManifestObject),
      sha256: "00".repeat(32),
    };
    const { stream, completed } = createRestoreArchive({
      reader: chunkReaderFor(fixture.ctx),
      objects: [tampered],
    });
    const drained = drain(stream).catch((error: unknown) => error);
    await expect(completed).rejects.toThrow(/hash mismatch/);
    expect(await drained).toBeInstanceOf(Error);
  });

  it("deletes the partial archive when the engine fails", async () => {
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: "drive-1",
      objects: [{ path: "Documents/a.txt", type: "file", id: "A", content: "alpha" }],
    });
    const manifestPath = (await fixture.ctx.snapshots.get(fixture.snapshotId))
      ?.manifestPath as string;
    // Corrupt the sealed chunk in its pack: authentication fails while streaming.
    const index = fixture.ctx.chunkIndex as MemoryChunkIndex;
    const location = index.chunks.get(fixture.objects[0]?.chunks[0] ?? "");
    if (!location) {
      throw new Error("fixture chunk is not indexed");
    }
    const pack = await fixture.storage.get(location.packPath);
    const last = location.offset + location.length - 1;
    pack[last] = (pack[last] ?? 0) ^ 0xff;
    await fixture.storage.put(location.packPath, pack);
    const request = restoreRequestFor(fixture, {
      target: { type: "download", ref: null },
      restoreJobId: "5c1d6c0e-1111-4222-8333-944444444444",
    });
    await expect(new DownloadRestoreEngine().run(fixture.ctx, request)).rejects.toThrow();
    const leftovers = await fixture.storage.list(`tenants/${fixture.ctx.tenantId}/downloads/`);
    expect(leftovers).toEqual([]);
    expect(await fixture.storage.head(manifestPath)).not.toBeNull();
  });

  it("stops promptly when the job is cancelled", async () => {
    const controller = new AbortController();
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: "drive-1",
      signal: controller.signal,
      objects: [
        { path: "Documents/a.txt", type: "file", id: "A", content: "alpha" },
        { path: "Documents/b.txt", type: "file", id: "B", content: "bravo" },
      ],
    });
    const { stream, completed } = createRestoreArchive({
      reader: chunkReaderFor(fixture.ctx),
      objects: fixture.objects,
      signal: controller.signal,
      onEntry: () => controller.abort(),
    });
    drain(stream).catch(() => undefined);
    await expect(completed).rejects.toThrow(/aborted/);
  });

  it("refuses requests that are not download restores", async () => {
    fixture = await createSnapshotFixture({ kind: "onedrive", externalId: "drive-1", objects: [] });
    await expect(
      new DownloadRestoreEngine().run(fixture.ctx, restoreRequestFor(fixture)),
    ).rejects.toThrow(/only serves download restores/);
  });
});

describe("entry names", () => {
  it("adds extensions by type and neutralises path tricks", () => {
    expect(archiveEntryName(object({ path: "mail/Inbox/AAMk1", type: "mail" }))).toBe(
      "mail/Inbox/AAMk1.eml",
    );
    expect(archiveEntryName(object({ path: "mail/Inbox/x.eml", type: "message" }))).toBe(
      "mail/Inbox/x.eml",
    );
    expect(
      archiveEntryName(
        object({ path: "mail/Inbox/x.json", type: "mail", metadata: { format: "json" } }),
      ),
    ).toBe("mail/Inbox/x.json");
    expect(archiveEntryName(object({ path: "calendar/Team/ev1", type: "event" }))).toBe(
      "calendar/Team/ev1.json",
    );
    expect(archiveEntryName(object({ path: "/../Documents/../secret.txt" }))).toBe(
      "Documents/secret.txt",
    );
    expect(archiveEntryName(object({ path: "Documents\\Sub\\file.txt" }))).toBe(
      "Documents/Sub/file.txt",
    );
    expect(archiveEntryName(object({ path: "Documents/Empty", type: "folder" }))).toBe(
      "Documents/Empty/",
    );
    expect(archiveEntryName(object({ path: 'Mail/What? "Now" <x>|y*. ', type: "file" }))).toBe(
      "Mail/What_ _Now_ _x__y_",
    );
    expect(archiveEntryName(object({ path: "../..", id: "X" }))).toBe("X");
  });

  it("names attachments by their file name and versions by their id", () => {
    expect(
      archiveEntryName(
        object({
          path: "mail/Inbox/M.1.attachments/Fwd: Offer.77",
          type: "attachment",
          metadata: { name: "Fwd: Offer", attachmentType: "#microsoft.graph.itemAttachment" },
        }),
      ),
    ).toBe("mail/Inbox/M.1.attachments/Fwd_ Offer.eml");
    expect(
      archiveEntryName(object({ path: "Docs/report.docx:versions/3.0", type: "file-version" })),
    ).toBe("Docs/report (version 3.0).docx");
  });

  it("keeps entry names unique regardless of case", () => {
    const namer = new EntryNamer();
    expect(namer.unique("a/Report.pdf")).toBe("a/Report.pdf");
    expect(namer.unique("a/report.pdf")).toBe("a/report (2).pdf");
    expect(namer.unique("a/REPORT.pdf")).toBe("a/REPORT (3).pdf");
    expect(namer.unique("a/Dir/")).toBe("a/Dir/");
    expect(namer.unique("a/dir/")).toBe("a/dir (2)/");
  });

  it("quotes CSV fields only when needed", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('say "hi", now')).toBe('"say ""hi"", now"');
    expect(csvField(null)).toBe("");
    expect(csvField(12)).toBe("12");
  });

  it("builds safe archive file names", () => {
    const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(archiveFileName(now)).toBe("restore-20260102t030405.zip");
    expect(archiveFileName(now, "../../etc/passwd")).toBe("etc-passwd.zip");
    expect(archiveFileName(now, "Mailbox Anna.ZIP")).toBe("Mailbox-Anna.ZIP");
    expect(archiveFileName(now, "***")).toBe("restore-20260102t030405.zip");
  });
});
