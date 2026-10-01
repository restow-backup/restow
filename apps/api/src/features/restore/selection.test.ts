import { describe, expect, it } from "vitest";
import {
  type SelectionLookup,
  parseStoredSelection,
  requestedKeys,
  resolveSelection,
  summarizeSelection,
} from "./selection.js";

const lookup: SelectionLookup = {
  kindByPath: new Map([
    ["Inbox", "folder"],
    ["Inbox/Projects", "folder"],
    ["Inbox/Projects/mail-1", "mail"],
    ["Documents/report.docx", "file"],
    ["Documents/old.docx", "file"],
  ]),
  implicitFolders: new Set(["Documents"]),
  knownItemIds: new Set(["item-a", "item-b"]),
};

describe("requestedKeys", () => {
  it("splits paths and item ids, ignoring the root", () => {
    expect(
      requestedKeys([
        { path: "Inbox" },
        { path: "" },
        { itemId: "item-a" },
        { path: "Inbox" },
        { itemId: "item-a" },
      ]),
    ).toEqual({ paths: ["Inbox"], itemIds: ["item-a"] });
  });
});

describe("resolveSelection", () => {
  it("maps folders, items and ids onto the engine selection", () => {
    const result = resolveSelection(
      [
        { path: "Inbox/Projects", kind: "folder" },
        { path: "Documents/report.docx" },
        { itemId: "item-b" },
      ],
      lookup,
    );
    expect(result).toEqual({
      ok: true,
      selection: {
        folderPaths: ["Inbox/Projects"],
        paths: ["Documents/report.docx"],
        objectIds: ["item-b"],
      },
      summary: { all: false, folders: 1, items: 2 },
    });
  });

  it("treats a parent path without a folder row as a folder", () => {
    const result = resolveSelection([{ path: "Documents" }], lookup);
    expect(result).toEqual({
      ok: true,
      selection: { folderPaths: ["Documents"] },
      summary: { all: false, folders: 1, items: 0 },
    });
  });

  it("selects everything for the root and ignores the rest", () => {
    const result = resolveSelection([{ path: "/" }, { path: "Inbox" }], {
      ...lookup,
    });
    expect(result).toEqual({
      ok: true,
      selection: { all: true },
      summary: { all: true, folders: 0, items: 0 },
    });
  });

  it("drops entries already covered by a selected folder", () => {
    const result = resolveSelection(
      [
        { path: "Inbox" },
        { path: "Inbox/Projects" },
        { path: "Inbox/Projects/mail-1" },
        { path: "Documents/old.docx" },
      ],
      lookup,
    );
    expect(result).toEqual({
      ok: true,
      selection: { folderPaths: ["Inbox"], paths: ["Documents/old.docx"] },
      summary: { all: false, folders: 1, items: 1 },
    });
  });

  it("rejects unknown paths and ids instead of restoring less than asked", () => {
    const result = resolveSelection(
      [{ path: "Inbox" }, { path: "Nowhere/x.txt" }, { itemId: "ghost" }],
      lookup,
    );
    expect(result).toEqual({ ok: false, unknown: ["path:Nowhere/x.txt", "itemId:ghost"] });
  });
});

describe("summarizeSelection / parseStoredSelection", () => {
  it("summarizes stored selections", () => {
    expect(summarizeSelection({ all: true })).toEqual({ all: true, folders: 0, items: 0 });
    expect(summarizeSelection({ folderPaths: ["a"], paths: ["b", "c"], objectIds: ["d"] })).toEqual(
      { all: false, folders: 1, items: 3 },
    );
  });

  it("reads stored jsonb tolerantly and falls back to everything", () => {
    expect(parseStoredSelection(null)).toEqual({ all: true });
    expect(parseStoredSelection({})).toEqual({ all: true });
    expect(parseStoredSelection({ paths: ["a"], folderPaths: "nope" })).toEqual({ paths: ["a"] });
    expect(parseStoredSelection({ all: true, paths: ["a"] })).toEqual({ all: true, paths: ["a"] });
  });
});
