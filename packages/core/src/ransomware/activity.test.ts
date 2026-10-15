import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ACTIVITY_ENTROPY_SAMPLES,
  ACTIVITY_MAX_ENTROPY_SAMPLES,
  ACTIVITY_MAX_EXTENSIONS,
  ActivityCollector,
  EntropyWindows,
  isExtensionRename,
  parseActivityReport,
} from "./activity.js";
import { ENTROPY_SAMPLE_BYTES } from "./entropy.js";

describe("parsing a runner's report", () => {
  it("reads a complete version 1 report", () => {
    const report = parseActivityReport({
      v: 1,
      added: 12,
      modified: 3,
      removed: 2,
      renamed: 1,
      extensions: [{ value: "locked", count: 9 }],
      names: [{ value: "HOW_TO_DECRYPT.txt", count: 4 }],
      entropy: [{ path: "/a.txt", ext: ".TXT", size: 10, head: 7.99, tail: null }],
      truncated: true,
    });
    expect(report).toEqual({
      v: 1,
      added: 12,
      modified: 3,
      removed: 2,
      renamed: 1,
      extensions: [{ value: "locked", count: 9 }],
      names: [{ value: "HOW_TO_DECRYPT.txt", count: 4 }],
      entropy: [{ path: "/a.txt", ext: "txt", size: 10, head: 7.99, tail: null }],
      truncated: true,
    });
  });

  it("is null for nothing usable: an older runner sends no report", () => {
    expect(parseActivityReport(undefined)).toBeNull();
    expect(parseActivityReport(null)).toBeNull();
    expect(parseActivityReport([])).toBeNull();
    expect(parseActivityReport({ added: 3 })).toBeNull();
  });

  it("drops what is malformed and bounds the lists", () => {
    const report = parseActivityReport({
      v: 2,
      added: -4,
      modified: "7",
      removed: Number.NaN,
      extensions: [
        ...Array.from({ length: 100 }, (_, i) => ({ value: `e${i}`, count: 1 })),
        { value: "", count: 3 },
      ],
      names: [{ value: "x", count: 0 }, "nope", null],
      entropy: [{ path: "/a", head: 99 }, { head: 1 }, { path: "/b", head: -1 }],
      future: { field: true },
    });
    expect(report?.v).toBe(2);
    expect(report?.added).toBe(0);
    expect(report?.modified).toBe(0);
    expect(report?.removed).toBe(0);
    expect(report?.extensions).toHaveLength(ACTIVITY_MAX_EXTENSIONS);
    expect(report?.names).toEqual([]);
    expect(report?.entropy).toEqual([{ path: "/a", ext: "", size: 0, head: 8, tail: null }]);
    expect(report?.truncated).toBe(false);
    const many = parseActivityReport({
      v: 1,
      entropy: Array.from({ length: 50 }, (_, i) => ({ path: `/f${i}`, head: 1 })),
    });
    expect(many?.entropy).toHaveLength(ACTIVITY_MAX_ENTROPY_SAMPLES);
  });
});

describe("extension renames", () => {
  it("count an appended or replaced extension, not a move or a new stem", () => {
    expect(isExtensionRename("/a/report.docx", "/a/report.docx.locked")).toBe(true);
    expect(isExtensionRename("/a/report.docx", "/a/report.crypt")).toBe(true);
    expect(isExtensionRename("/a/report.docx", "/b/report.docx")).toBe(false);
    expect(isExtensionRename("/a/report.docx", "/a/summary.docx")).toBe(false);
    expect(isExtensionRename("/a/report.docx", "/a/report.docx.")).toBe(false);
  });
});

describe("the collector of the OneDrive backup", () => {
  it("counts changes, extensions and note-like names of new files", () => {
    const collector = new ActivityCollector();
    collector.fileAdded("/Documents/HOW_TO_DECRYPT.txt");
    collector.fileAdded("/Pictures/HOW_TO_DECRYPT.txt");
    collector.fileAdded("/Documents/a.docx");
    collector.fileModified("/Documents/b.xlsx.locked", "/Documents/b.xlsx");
    collector.fileModified("/Documents/c.xlsx");
    collector.fileRenamed("/Documents/d.pdf", "/Documents/d.pdf.locked");
    collector.fileRenamed("/Documents/e.pdf", "/Archive/e.pdf");
    collector.filesRemoved(3);
    const report = collector.report();
    expect(report).toMatchObject({ v: 1, added: 3, modified: 2, removed: 3, renamed: 2 });
    expect(report.extensions).toEqual([
      { value: "locked", count: 2 },
      { value: "txt", count: 2 },
      { value: "docx", count: 1 },
      { value: "xlsx", count: 1 },
    ]);
    expect(report.names).toEqual([{ value: "HOW_TO_DECRYPT.txt", count: 2 }]);
  });

  it("takes a handful of entropy samples", () => {
    const collector = new ActivityCollector();
    for (let i = 0; i < 20; i++) {
      if (collector.wantsEntropy()) {
        collector.addEntropy({ path: `/f${i}`, ext: "", size: 1, head: 1, tail: null });
      }
    }
    expect(collector.report().entropy).toHaveLength(ACTIVITY_ENTROPY_SAMPLES);
  });
});

describe("the windows of a stream", () => {
  it("keeps the first and the last 64 KiB across chunks", () => {
    const data = randomBytes(3 * ENTROPY_SAMPLE_BYTES + 123);
    const windows = new EntropyWindows();
    for (let at = 0; at < data.length; at += 10_000) {
      windows.push(data.subarray(at, at + 10_000));
    }
    const { head, tail } = windows.windows();
    expect(windows.size).toBe(data.length);
    expect(Buffer.from(head).equals(data.subarray(0, ENTROPY_SAMPLE_BYTES))).toBe(true);
    expect(tail && Buffer.from(tail).equals(data.subarray(-ENTROPY_SAMPLE_BYTES))).toBe(true);
  });

  it("has no tail for a file of one window", () => {
    const windows = new EntropyWindows();
    windows.push(Buffer.from("small"));
    expect(windows.windows().tail).toBeNull();
    expect(Buffer.from(windows.windows().head).toString()).toBe("small");
  });
});
