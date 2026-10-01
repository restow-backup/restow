import { afterEach, describe, expect, it } from "vitest";
import type { MemoryChunkIndex } from "../engine/memory.js";
import { sealManifest } from "../engine/sealed-manifest.js";
import { loadManifest } from "../engine/snapshot.js";
import { must } from "../graph/testing/fake-graph.js";
import {
  OneDriveRestoreEngine,
  driveTargetOf,
  parseDriveTargetRef,
  renamedCopyName,
  verifyUpload,
} from "./onedrive.js";
import { quickXorHash } from "./quickxorhash.js";
import { FakeDrive } from "./testing/fake-drive.js";
import {
  type FixtureObject,
  type SnapshotFixture,
  createSnapshotFixture,
  pseudoRandomBytes,
  restoreRequestFor,
} from "./testing/fixtures.js";

const DRIVE = "b!anna-drive";
const MIB = 1024 * 1024;
const FRAGMENT = 5 * MIB;

function engineFor(drive: FakeDrive): OneDriveRestoreEngine {
  return new OneDriveRestoreEngine({ graph: () => drive.graph.client(), fragmentSize: FRAGMENT });
}

const report = Buffer.from("quarterly report, final version");
const large = pseudoRandomBytes(2 * FRAGMENT, 7);
const odd = pseudoRandomBytes(FRAGMENT + 12_345, 8);

// Objects shaped like the OneDrive backup writes them (backup/onedrive).
const documents: FixtureObject = {
  path: "Documents",
  type: "folder",
  id: "D1",
  content: "",
  metadata: { createdDateTime: "2024-01-01T00:00:00Z" },
};
const emptyFolder: FixtureObject = {
  path: "Documents/Empty",
  type: "folder",
  id: "D2",
  content: "",
};
const reportFile: FixtureObject = {
  path: "Documents/report.docx",
  type: "file",
  id: "F1",
  content: report,
  metadata: {
    createdDateTime: "2025-03-01T08:00:00Z",
    lastModifiedDateTime: "2025-03-02T09:30:00Z",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    quickXorHash: quickXorHash(report),
  },
};
const largeFile: FixtureObject = {
  path: "Videos/Clips/exact.bin",
  type: "file",
  id: "F2",
  content: large,
  metadata: { lastModifiedDateTime: "2025-04-01T12:00:00Z" },
};
const oddFile: FixtureObject = { path: "Videos/odd.bin", type: "file", id: "F3", content: odd };

describe("OneDriveRestoreEngine", () => {
  let fixture: SnapshotFixture;

  afterEach(async () => {
    await fixture?.cleanup();
  });

  it("restores files and folders byte for byte, through simple uploads and upload sessions", async () => {
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: DRIVE,
      objects: [documents, emptyFolder, reportFile, largeFile, oddFile],
    });
    const drive = new FakeDrive(DRIVE);

    const result = await engineFor(drive).run(fixture.ctx, restoreRequestFor(fixture));

    expect(result.failures).toEqual([]);
    expect(result.restored).toBe(3);
    expect(result.folders).toBe(2);
    expect(result.unverified).toBe(0);
    expect(result.bytes).toBe(report.length + large.length + odd.length);
    expect(fixture.ctx.progress.snapshot()).toMatchObject({ total: 5, done: 5, failed: 0 });

    const byPath = new Map(drive.files().map((item) => [drive.pathOf(item.id), item]));
    expect([...byPath.keys()].sort()).toEqual([
      "Documents/report.docx",
      "Videos/Clips/exact.bin",
      "Videos/odd.bin",
    ]);
    expect(must(byPath.get("Documents/report.docx")).content.equals(report)).toBe(true);
    expect(must(byPath.get("Videos/Clips/exact.bin")).content.equals(large)).toBe(true);
    expect(must(byPath.get("Videos/odd.bin")).content.equals(odd)).toBe(true);
    expect(drive.child(must(drive.child("root", "Documents")).id, "Empty")?.kind).toBe("folder");

    // Timestamps: PATCHed after a simple upload, sent with the session otherwise.
    expect(must(byPath.get("Documents/report.docx")).fileSystemInfo).toEqual({
      createdDateTime: "2025-03-01T08:00:00Z",
      lastModifiedDateTime: "2025-03-02T09:30:00Z",
    });
    expect(must(byPath.get("Videos/Clips/exact.bin")).fileSystemInfo).toEqual({
      lastModifiedDateTime: "2025-04-01T12:00:00Z",
    });

    const sessions = [...drive.sessions.values()];
    expect(sessions.map((session) => session.ranges)).toEqual([
      [
        `bytes 0-${FRAGMENT - 1}/${large.length}`,
        `bytes ${FRAGMENT}-${large.length - 1}/${large.length}`,
      ],
      [
        `bytes 0-${FRAGMENT - 1}/${odd.length}`,
        `bytes ${FRAGMENT}-${odd.length - 1}/${odd.length}`,
      ],
    ]);
    expect(sessions.every((session) => session.conflictBehavior === "rename")).toBe(true);
    expect(result.items.filter((item) => item.type === "file").every((item) => item.verified)).toBe(
      true,
    );
  });

  it("maps the modes onto conflict behaviour: rename keeps both, skip leaves, replace overwrites", async () => {
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: DRIVE,
      objects: [reportFile],
    });
    const drive = new FakeDrive(DRIVE);
    const folder = drive.addFolder("root", "Documents");
    const current = drive.addFile(folder.id, "report.docx", Buffer.from("newer, unwanted edit"));

    const renamed = await engineFor(drive).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "rename" }),
    );
    expect(renamed.restored).toBe(1);
    expect(renamed.items[0]?.reason).toBe('restored as "report 1.docx" next to the existing file');
    expect(drive.child(folder.id, "report 1.docx")?.content.equals(report)).toBe(true);
    expect(current.content.toString()).toBe("newer, unwanted edit");

    const skipped = await engineFor(drive).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );
    expect(skipped.skipped).toBe(1);
    expect(skipped.items[0]).toMatchObject({
      status: "skipped",
      code: "exists",
      targetRef: current.id,
    });

    const replaced = await engineFor(drive).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "replace" }),
    );
    expect(replaced.restored).toBe(1);
    expect(replaced.items[0]?.targetRef).toBe(current.id);
    expect(current.content.equals(report)).toBe(true);
  });

  it("recognises the copies an earlier attempt uploaded when a rename-mode job is retried", async () => {
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: DRIVE,
      objects: [reportFile, largeFile],
    });
    const drive = new FakeDrive(DRIVE);
    const folder = drive.addFolder("root", "Documents");
    drive.addFile(folder.id, "report.docx", Buffer.from("newer, unwanted edit"));
    const request = restoreRequestFor(fixture, { mode: "rename" });

    const first = await engineFor(drive).run(fixture.ctx, request);
    expect(first.restored).toBe(2);
    const retry = await engineFor(drive).run(fixture.ctx, request);

    expect(retry.failures).toEqual([]);
    expect(retry.restored).toBe(0);
    expect(retry.skipped).toBe(2);
    const report1 = must(drive.child(folder.id, "report 1.docx"));
    expect(retry.items.find((item) => item.id === "F1")).toMatchObject({
      status: "skipped",
      code: "exists",
      targetRef: report1.id,
      reason: 'the target folder already holds this file with identical content as "report 1.docx"',
    });
    expect(drive.files().map((item) => drive.pathOf(item.id))).toEqual([
      "Documents/report.docx",
      "Documents/report 1.docx",
      "Videos/Clips/exact.bin",
    ]);
    // The large file was compared by hash, not uploaded a second time.
    expect(drive.sessions.size).toBe(1);
  });

  it("uploads a renamed copy in rename mode only where the file there differs", async () => {
    const older = Buffer.from("quarterly report, draft");
    const sameSizeOther = pseudoRandomBytes(odd.length, 9);
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: DRIVE,
      objects: [
        reportFile,
        {
          path: "Documents/report.docx:versions/2.0",
          type: "file-version",
          id: "F1#2.0",
          content: older,
          metadata: { versionId: "2.0" },
        },
        oddFile,
      ],
    });
    const drive = new FakeDrive(DRIVE);
    const documentsFolder = drive.addFolder("root", "Documents");
    const original = drive.addFile(documentsFolder.id, "report.docx", report);
    const videos = drive.addFolder("root", "Videos");
    drive.addFile(videos.id, "odd.bin", sameSizeOther);

    const result = await engineFor(drive).run(
      fixture.ctx,
      restoreRequestFor(fixture, {
        mode: "rename",
        selection: { objectIds: ["F1", "F1#2.0", "F3"] },
      }),
    );

    expect(result.failures).toEqual([]);
    expect(result.items.find((item) => item.id === "F1")).toMatchObject({
      status: "skipped",
      code: "exists",
      targetRef: original.id,
    });
    expect(result.restored).toBe(2);
    expect(drive.child(documentsFolder.id, "report 1.docx")?.content.equals(older)).toBe(true);
    expect(drive.child(videos.id, "odd 1.bin")?.content.equals(odd)).toBe(true);
    expect(original.content.equals(report)).toBe(true);
  });

  it("restores into another user's OneDrive below a folder", async () => {
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: DRIVE,
      objects: [reportFile],
    });
    const drive = new FakeDrive(DRIVE, { "carla@example.org": "b!carla-drive" });

    const result = await engineFor(drive).run(
      fixture.ctx,
      restoreRequestFor(fixture, {
        target: { type: "other", ref: "carla@example.org:/From Anna" },
      }),
    );

    expect(result.restored).toBe(1);
    const restored = must(drive.files()[0]);
    expect(drive.pathOf(restored.id)).toBe("From Anna/Documents/report.docx");
    const driveCalls = drive.graph.calls.filter((call) => call.url.includes("/drives/"));
    expect(driveCalls.length).toBeGreaterThan(0);
    expect(driveCalls.every((call) => call.url.includes("/drives/b!carla-drive/"))).toBe(true);
  });

  it("puts a selected historical version back under its file's name", async () => {
    const older = Buffer.from("quarterly report, draft");
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: DRIVE,
      objects: [
        reportFile,
        {
          path: "Documents/report.docx:versions/2.0",
          type: "file-version",
          id: "F1#2.0",
          content: older,
          metadata: { versionId: "2.0", lastModifiedDateTime: "2025-02-20T10:00:00Z" },
        },
      ],
    });
    const drive = new FakeDrive(DRIVE);
    const folder = drive.addFolder("root", "Documents");
    const current = drive.addFile(folder.id, "report.docx", report);

    const result = await engineFor(drive).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "replace", selection: { objectIds: ["F1#2.0"] } }),
    );

    expect(result.restored).toBe(1);
    expect(current.content.equals(older)).toBe(true);
    expect(current.fileSystemInfo).toEqual({ lastModifiedDateTime: "2025-02-20T10:00:00Z" });
    expect(result.items[0]?.reason).toBe("version 2.0 of report.docx");
  });

  it("reports what cannot go into a drive and what the target did not confirm", async () => {
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: DRIVE,
      objects: [
        reportFile,
        { path: "Documents/Notes", type: "package", id: "P1", content: "" },
        { path: "Documents/Shared", type: "shortcut", id: "S1", content: "" },
        { path: "mail/Inbox/x.eml", type: "mail", id: "M1", content: "Subject: x\r\n\r\n" },
      ],
    });
    const drive = new FakeDrive(DRIVE);
    drive.reportedQuickXorHash = "AAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    const result = await engineFor(drive).run(fixture.ctx, restoreRequestFor(fixture));

    expect(result.restored).toBe(1);
    expect(result.unverified).toBe(1);
    expect(result.skipped).toBe(2);
    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get("F1")).toMatchObject({
      status: "restored",
      code: "unverified",
      verified: false,
    });
    expect(byId.get("F1")?.reason).toMatch(/QuickXorHash OneDrive reports differs/);
    expect(byId.get("P1")).toMatchObject({ status: "skipped", code: "not_restorable" });
    expect(byId.get("S1")?.reason).toMatch(/shortcuts/);
    expect(byId.get("M1")).toMatchObject({ status: "failed", code: "wrong_target" });
  });

  it("fails an item whose stored bytes do not authenticate, and uploads nothing for it", async () => {
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: DRIVE,
      objects: [reportFile],
    });
    const index = fixture.ctx.chunkIndex as MemoryChunkIndex;
    const location = must(index.chunks.get(must(fixture.objects[0]?.chunks[0])));
    const pack = await fixture.storage.get(location.packPath);
    const last = location.offset + location.length - 1;
    pack[last] = (pack[last] ?? 0) ^ 0xff;
    await fixture.storage.put(location.packPath, pack);
    const drive = new FakeDrive(DRIVE);

    const result = await engineFor(drive).run(fixture.ctx, restoreRequestFor(fixture));

    expect(result.restored).toBe(0);
    expect(result.items[0]).toMatchObject({ status: "failed", code: "integrity" });
    expect(drive.files()).toEqual([]);
  });

  it("fails a file whose uploaded bytes differ from the snapshot and names what OneDrive now holds", async () => {
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: DRIVE,
      objects: [largeFile],
    });
    // A manifest whose recorded hash disagrees with its own (intact) chunks.
    // The file is an exact multiple of the fragment size, so the session
    // completes with the last fragment, before the reader's final check.
    const storage = { primary: fixture.storage, copies: [] };
    const key = must((await fixture.ctx.snapshots.get(fixture.snapshotId))?.manifestPath);
    const manifest = await loadManifest(storage, key, fixture.ctx.keys);
    manifest.objects = manifest.objects.map((object) =>
      object.id === "F2" ? { ...object, sha256: "0".repeat(64) } : object,
    );
    await fixture.storage.put(key, await sealManifest(manifest, fixture.ctx.keys.current, key));
    const drive = new FakeDrive(DRIVE);

    const result = await engineFor(drive).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "replace" }),
    );

    expect(result.restored).toBe(0);
    expect(result.unverified).toBe(0);
    const item = must(result.items.find((entry) => entry.id === "F2"));
    expect(item).toMatchObject({ status: "failed", code: "integrity", verified: false });
    expect(item.targetRef).toBe(must(drive.files()[0]).id);
    expect(item.reason).toMatch(/SHA-256 of the sent bytes differs from the snapshot/);
    expect(item.reason).toMatch(/earlier version/);
  });

  it("refuses a target user without a OneDrive before touching anything", async () => {
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: DRIVE,
      objects: [reportFile],
    });
    const drive = new FakeDrive(DRIVE, {});
    await expect(
      engineFor(drive).run(
        fixture.ctx,
        restoreRequestFor(fixture, { target: { type: "other", ref: "nobody@example.org" } }),
      ),
    ).rejects.toThrow(/has no OneDrive/);
    expect(drive.items.size).toBe(1);
  });
});

describe("drive targets and verification", () => {
  it("parses target references", () => {
    expect(parseDriveTargetRef("b!xyz")).toEqual({ drive: "b!xyz", basePath: [] });
    expect(parseDriveTargetRef("carla@example.org:/Restore/From Anna/")).toEqual({
      drive: "carla@example.org",
      basePath: ["Restore", "From Anna"],
    });
    const base = restoreRequestFor({
      protectedObject: {
        id: "p",
        tenantId: "t",
        sourceId: "s",
        kind: "onedrive",
        externalId: DRIVE,
        displayName: null,
        userId: null,
      },
      snapshotId: "snap",
    });
    expect(driveTargetOf(base)).toEqual({ drive: DRIVE, basePath: [] });
    expect(() => driveTargetOf({ ...base, target: { type: "other", ref: ":/x" } })).toThrow(
      /target drive/,
    );
    expect(() => driveTargetOf({ ...base, target: { type: "download", ref: null } })).toThrow(
      /download/,
    );
  });

  it("names renamed copies the way OneDrive does", () => {
    expect(renamedCopyName("report.docx", 0)).toBe("report.docx");
    expect(renamedCopyName("report.docx", 2)).toBe("report 2.docx");
    expect(renamedCopyName("archive.tar.gz", 1)).toBe("archive.tar 1.gz");
    expect(renamedCopyName("README", 3)).toBe("README 3");
    expect(renamedCopyName(".env", 1)).toBe(".env 1");
  });

  it("names every disagreement between snapshot, sent bytes and OneDrive", () => {
    const object = {
      path: "a.txt",
      size: 5,
      mtime: 0,
      chunks: [],
      sha256: "aa",
      metadata: { quickXorHash: "q0" },
    };
    const sent = { bytes: 4, quickXorHash: "q1", sha256Hex: "bb" };
    expect(
      verifyUpload(object, { size: 6, file: { hashes: { quickXorHash: "q2" } } }, sent).problems,
    ).toEqual([
      "sent 4 bytes, the snapshot recorded 5",
      "OneDrive reports 6 bytes, expected 5",
      "the QuickXorHash OneDrive reports differs from the sent bytes",
      "the QuickXorHash differs from the one OneDrive reported at backup time",
    ]);
    expect(
      verifyUpload(object, { size: 5 }, { bytes: 5, quickXorHash: "q0", sha256Hex: "aa" }).problems,
    ).toEqual([]);
  });
});
