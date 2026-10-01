import { describe, expect, it } from "vitest";

import type { Snapshot, Version } from "@/features/restore/api";

import { isShownVersion, snapshotOfVersion, storedVersionEntry, versionEntry } from "./versions";

const version: Version = {
  objectId: "o1",
  snapshotId: "s4",
  sequence: 4,
  snapshotAt: "2026-01-04T00:00:00Z",
  firstSeenSequence: 2,
  firstSeenAt: "2026-01-02T00:00:00Z",
  snapshotCount: 3,
  path: "Documents/report.docx",
  name: "report.docx",
  kind: "file",
  size: 512,
  mtime: null,
  itemId: "drive-report",
  deleted: false,
};

const snapshot = (id: string, sequence: number): Snapshot => ({
  id,
  objectId: "o1",
  sequence,
  itemCount: 1,
  byteSize: 1,
  startedAt: null,
  completedAt: `2026-01-0${sequence}T00:00:00Z`,
  createdAt: `2026-01-0${sequence}T00:00:00Z`,
});

describe("isShownVersion", () => {
  it("is the version whose range of snapshots contains the browsed one", () => {
    expect(isShownVersion(version, { sequence: 2 })).toBe(true);
    expect(isShownVersion(version, { sequence: 4 })).toBe(true);
    expect(isShownVersion(version, { sequence: 1 })).toBe(false);
    expect(isShownVersion(version, { sequence: 5 })).toBe(false);
  });
});

describe("snapshotOfVersion", () => {
  it("uses the loaded snapshot and falls back to what the version knows", () => {
    const known = snapshot("s4", 4);
    expect(snapshotOfVersion(version, [snapshot("s5", 5), known])).toBe(known);
    expect(snapshotOfVersion(version, undefined)).toMatchObject({
      id: "s4",
      sequence: 4,
      completedAt: "2026-01-04T00:00:00Z",
    });
  });
});

describe("version entries", () => {
  it("turns versions into restore entries", () => {
    expect(versionEntry(version, { mail: null })).toEqual({
      path: "Documents/report.docx",
      kind: "file",
      itemId: "drive-report",
      subject: null,
      size: 512,
    });
    expect(
      storedVersionEntry({
        path: "Documents/report.docx:versions/1.0",
        versionId: "1.0",
        size: 100,
        modifiedAt: null,
        modifiedBy: null,
      }),
    ).toEqual({
      path: "Documents/report.docx:versions/1.0",
      kind: "file",
      itemId: null,
      subject: null,
      size: 100,
    });
  });
});
