import { describe, expect, it } from "vitest";

import { extractDroppedFiles, hasFiles } from "./dropped-files";

const file = (name: string) => new File(["x"], name);

describe("extractDroppedFiles", () => {
  it("takes the files and counts the folders it skips", () => {
    const a = file("a.eml");
    const b = file("b.mbox");
    const result = extractDroppedFiles({
      items: [
        { kind: "file", getAsFile: () => a, webkitGetAsEntry: () => ({ isDirectory: false }) },
        { kind: "file", getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true }) },
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => b },
      ],
    });
    expect(result.files).toEqual([a, b]);
    expect(result.directories).toBe(1);
  });

  it("falls back to the plain file list", () => {
    const a = file("a.eml");
    expect(extractDroppedFiles({ files: [a], items: [] })).toEqual({ files: [a], directories: 0 });
    expect(extractDroppedFiles({})).toEqual({ files: [], directories: 0 });
  });

  it("recognizes a drag that carries files", () => {
    expect(hasFiles({ types: ["text/plain", "Files"] })).toBe(true);
    expect(hasFiles({ types: ["text/uri-list"] })).toBe(false);
    expect(hasFiles(null)).toBe(false);
  });
});
