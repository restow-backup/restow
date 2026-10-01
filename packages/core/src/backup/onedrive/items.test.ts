import { describe, expect, it } from "vitest";
import type { DriveDeltaItem } from "../../graph/resources/drive.js";
import type { ManifestObject } from "../../manifest.js";
import fixture from "./fixtures/drive-backup.json" with { type: "json" };
import {
  ONEDRIVE_OBJECT_TYPES,
  canReuseContent,
  classifyItem,
  fileObject,
  folderObject,
  graphPathOf,
  historicalVersions,
  isVersionPath,
  itemMtime,
  reusedFileObject,
  shortcutObject,
  staleFileObject,
  versionObject,
  versionPath,
  versionUnchanged,
} from "./items.js";

const NOW = Date.parse("2026-09-22T10:00:00Z");
const page1 = fixture.initialPage1.value as DriveDeltaItem[];
const page2 = fixture.initialPage2.value as DriveDeltaItem[];
const incremental = fixture.incrementalPage.value as DriveDeltaItem[];
const [root, docs, , q3] = page1 as [
  DriveDeltaItem,
  DriveDeltaItem,
  DriveDeltaItem,
  DriveDeltaItem,
];
const [notes, notebook, shortcut] = page2 as [DriveDeltaItem, DriveDeltaItem, DriveDeltaItem];
const [deletedNotes, , movedQ3, plan] = incremental as [
  DriveDeltaItem,
  DriveDeltaItem,
  DriveDeltaItem,
  DriveDeltaItem,
];

describe("classifyItem", () => {
  it("recognises every facet the delta stream can carry", () => {
    expect(classifyItem(root)).toBe("root");
    expect(classifyItem(docs)).toBe("folder");
    expect(classifyItem(q3)).toBe("file");
    expect(classifyItem(shortcut)).toBe("shortcut");
    expect(classifyItem(deletedNotes)).toBe("deleted");
    expect(classifyItem({ id: "x", name: "?" })).toBe("unknown");
  });

  it("records a OneNote notebook as a folder, so its sections restore below it", () => {
    expect(classifyItem(notebook)).toBe("folder");
    const object = folderObject(notebook, "Notebook", NOW);
    expect(object.type).toBe(ONEDRIVE_OBJECT_TYPES.folder);
    expect(object.metadata?.packageType).toBe("oneNote");
  });

  it("treats a deleted entry as deleted even when the file facet is still present", () => {
    expect(classifyItem({ ...q3, deleted: { state: "deleted" } })).toBe("deleted");
  });
});

describe("graphPathOf", () => {
  it("derives the path from parentReference.path and decodes it", () => {
    expect(graphPathOf(q3)).toBe("Documents/Reports/Q3 report.xlsx");
    expect(graphPathOf(notes)).toBe("notes.txt");
    const encoded: DriveDeltaItem = {
      id: "e",
      name: "a.txt",
      parentReference: { path: "/drive/root:/Ordner%20%C3%9C" },
    };
    expect(graphPathOf(encoded)).toBe("Ordner Ü/a.txt");
    const driveScoped: DriveDeltaItem = {
      id: "d",
      name: "b.txt",
      parentReference: { path: "/drives/b!drive1/root:/Documents" },
    };
    expect(graphPathOf(driveScoped)).toBe("Documents/b.txt");
  });

  it("says nothing when the entry carries no path or no name", () => {
    expect(graphPathOf(plan)).toBeUndefined();
    expect(graphPathOf({ id: "n", parentReference: { path: "/drive/root:" } })).toBeUndefined();
  });
});

describe("manifest objects", () => {
  it("builds a file object with content, timestamps and information-only sharing metadata", () => {
    const object = fileObject(
      q3,
      "Documents/Reports/Q3 report.xlsx",
      { size: 11, sha256: "ab".repeat(32), chunks: ["cd".repeat(32)] },
      { now: NOW, contentType: "application/octet-stream" },
    );
    expect(object).toMatchObject({
      id: "01Q3",
      type: ONEDRIVE_OBJECT_TYPES.file,
      size: 11,
      mtime: Date.parse("2026-08-30T15:30:00Z"),
      sha256: "ab".repeat(32),
      chunks: ["cd".repeat(32)],
    });
    expect(object.metadata).toEqual({
      eTag: '"{Q3},1"',
      cTag: '"c:{Q3},1"',
      sourceSize: "11",
      parentId: "01REPORTS",
      createdDateTime: "2026-08-01T09:00:00Z",
      lastModifiedDateTime: "2026-08-30T15:30:00Z",
      createdBy: "Alice Example",
      lastModifiedBy: "Bob Example",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      quickXorHash: "q3hash1=",
    });

    const folder = folderObject(docs, "Documents", NOW);
    expect(folder).toMatchObject({ type: ONEDRIVE_OBJECT_TYPES.folder, size: 0, chunks: [] });
    expect(folder.metadata).toMatchObject({
      childCount: "1",
      parentId: "01ROOT",
      sharedScope: "users",
      sharedBy: "Alice Example",
      sharedDateTime: "2026-05-01T08:00:00Z",
    });

    const link = shortcutObject(shortcut, "Team files", NOW);
    expect(link.type).toBe(ONEDRIVE_OBJECT_TYPES.shortcut);
    expect(link.metadata).toMatchObject({
      remoteDriveId: "b!teamdrive",
      remoteItemId: "01REMOTE",
      remoteKind: "folder",
    });
  });

  it("falls back to the server timestamp and then to now", () => {
    expect(itemMtime({ lastModifiedDateTime: "2026-01-02T00:00:00Z" }, NOW)).toBe(
      Date.parse("2026-01-02T00:00:00Z"),
    );
    expect(itemMtime({ fileSystemInfo: { lastModifiedDateTime: "garbage" } }, NOW)).toBe(NOW);
    expect(itemMtime({}, NOW)).toBe(NOW);
  });
});

describe("canReuseContent", () => {
  const previous: ManifestObject = fileObject(
    q3,
    "Documents/Reports/Q3 report.xlsx",
    { size: 11, sha256: "ab".repeat(32), chunks: ["cd".repeat(32)] },
    { now: NOW },
  );

  it("reuses when id, size and content tag agree, even after a metadata-only change", () => {
    expect(canReuseContent(previous, movedQ3)).toBe(true);
  });

  it("compares Graph's size with the size Graph reported before, not with the downloaded bytes", () => {
    // SharePoint rewrites Office document properties on download, so the
    // stored object can be larger than the item Graph describes.
    const rewritten: ManifestObject = { ...previous, size: 13 };
    expect(canReuseContent(rewritten, movedQ3)).toBe(true);
    const legacy: ManifestObject = { ...previous, metadata: { cTag: '"c:{Q3},1"' } };
    expect(canReuseContent(legacy, movedQ3)).toBe(true);
    expect(canReuseContent({ ...legacy, size: 13 }, movedQ3)).toBe(false);
  });

  it("refuses when the content tag or size changed, or the copy is stale or incomplete", () => {
    expect(canReuseContent(previous, { ...movedQ3, cTag: '"c:{Q3},2"' })).toBe(false);
    expect(canReuseContent(previous, { ...movedQ3, size: 12 })).toBe(false);
    expect(canReuseContent(previous, { ...movedQ3, size: undefined })).toBe(false);
    expect(canReuseContent({ ...previous, id: "other" }, movedQ3)).toBe(false);
    expect(canReuseContent({ ...previous, type: ONEDRIVE_OBJECT_TYPES.folder }, movedQ3)).toBe(
      false,
    );
    expect(canReuseContent({ ...previous, sha256: undefined }, movedQ3)).toBe(false);
    expect(
      canReuseContent({ ...previous, metadata: { ...previous.metadata, stale: "true" } }, movedQ3),
    ).toBe(false);
  });

  it("falls back to the quickXorHash when no content tag is available", () => {
    const untagged = { ...movedQ3, cTag: undefined };
    const withoutTag: ManifestObject = { ...previous, metadata: { quickXorHash: "q3hash1=" } };
    expect(canReuseContent(withoutTag, untagged)).toBe(true);
    expect(canReuseContent({ ...withoutTag, metadata: { quickXorHash: "x" } }, untagged)).toBe(
      false,
    );
    expect(canReuseContent({ ...withoutTag, metadata: {} }, untagged)).toBe(false);
  });

  it("re-paths a reused file with fresh metadata and keeps the stored bytes", () => {
    const reused = reusedFileObject(previous, movedQ3, "Documents/Archive/Q3 report.xlsx", NOW);
    expect(reused.path).toBe("Documents/Archive/Q3 report.xlsx");
    expect(reused.chunks).toEqual(previous.chunks);
    expect(reused.sha256).toBe(previous.sha256);
    expect(reused.metadata?.eTag).toBe('"{Q3},2"');
    expect(reused.metadata?.parentId).toBe("01REPORTS");
  });

  it("keeps everything that describes the stored bytes when a copy is carried forward stale", () => {
    const changed: DriveDeltaItem = {
      ...movedQ3,
      size: 40,
      cTag: '"c:{Q3},9"',
      file: { mimeType: "text/csv", hashes: { quickXorHash: "new=", sha1Hash: "abc" } },
    };
    const stale = staleFileObject(previous, changed, "Documents/Archive/Q3 report.xlsx", NOW);
    expect(stale.metadata).toMatchObject({
      stale: "true",
      cTag: '"c:{Q3},1"',
      sourceSize: "11",
      quickXorHash: "q3hash1=",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      eTag: '"{Q3},2"',
    });
    expect(stale.metadata?.sha1Hash).toBeUndefined();
    expect(stale.path).toBe("Documents/Archive/Q3 report.xlsx");
    expect(stale.mtime).toBe(previous.mtime);
    expect(stale.chunks).toEqual(previous.chunks);
    expect(canReuseContent(stale, changed)).toBe(false);
  });
});

describe("versions", () => {
  it("keeps every version but the newest and skips entries without an id", () => {
    const versions = historicalVersions([
      ...fixture.versions.value,
      { size: 1 } as { id?: string; size?: number },
    ]);
    expect(versions.map((v) => v.id)).toEqual(["2.0", "1.0"]);
  });

  it("finds the current version by time, not by list position", () => {
    const shuffled = [
      fixture.versions.value[2],
      fixture.versions.value[0],
      fixture.versions.value[1],
    ] as typeof fixture.versions.value;
    expect(historicalVersions(shuffled).map((v) => v.id)).toEqual(["2.0", "1.0"]);
    expect(historicalVersions([])).toEqual([]);
  });

  it("stores a version below the file's version namespace", () => {
    const version = versionObject(
      q3,
      "Documents/Reports/Q3 report.xlsx",
      { id: "2.0", size: 14, lastModifiedDateTime: "2026-08-20T11:00:00Z" },
      { size: 14, sha256: "ef".repeat(32), chunks: ["01".repeat(32)] },
      NOW,
    );
    expect(version.path).toBe("Documents/Reports/Q3 report.xlsx:versions/2.0");
    expect(isVersionPath(version.path)).toBe(true);
    expect(isVersionPath("Documents/Reports/Q3 report.xlsx")).toBe(false);
    expect(version.id).toBe("01Q3#2.0");
    expect(version.type).toBe(ONEDRIVE_OBJECT_TYPES.version);
    expect(version.mtime).toBe(Date.parse("2026-08-20T11:00:00Z"));
    expect(version.metadata).toMatchObject({ itemId: "01Q3", versionId: "2.0", sourceSize: "14" });

    expect(versionUnchanged(version, { id: "2.0", size: 14 })).toBe(true);
    expect(versionUnchanged(version, { id: "2.0" })).toBe(true);
    expect(versionUnchanged(version, { id: "2.0", size: 15 })).toBe(false);
    expect(versionUnchanged({ ...version, sha256: undefined }, { id: "2.0", size: 14 })).toBe(
      false,
    );
    expect(versionPath("a.txt", "1.0")).toBe("a.txt:versions/1.0");
  });
});
