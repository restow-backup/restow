import { describe, expect, it } from "vitest";
import { UniqueNames, parentPrefix, safeEntryName } from "./zip.js";

describe("ZIP entry names", () => {
  it("cannot climb out of the archive", () => {
    expect(safeEntryName("../../etc/passwd")).toBe("etc/passwd");
    expect(safeEntryName("/abs/./path//file")).toBe("abs/path/file");
    expect(safeEntryName("a/../b")).toBe("a/b");
    expect(safeEntryName("..")).toBe("");
    expect(safeEntryName("dir", true)).toBe("dir/");
    expect(safeEntryName("", true)).toBe("");
  });

  it("gives a Windows extractor no backslash, drive or stream to follow", () => {
    // A Linux file may be called `..\..\x`; unpacked on Windows it must stay one file.
    expect(safeEntryName("..\\..\\x")).toBe(".._.._x");
    expect(safeEntryName("docs/..\\..\\Windows\\win.ini")).toBe("docs/.._.._Windows_win.ini");
    expect(safeEntryName("C:/Windows/system.ini")).toBe("C_/Windows/system.ini");
    expect(safeEntryName("C:evil")).toBe("C_evil");
    expect(safeEntryName("file.txt:stream")).toBe("file.txt_stream");
    expect(safeEntryName("a\u0000b\nc")).toBe("a_b_c");
    // Dots-only segments are no names on Windows either.
    expect(safeEntryName(".../x/....")).toBe("x");
    expect(safeEntryName("\\", true)).toBe("_/");
    // Ordinary names are left alone.
    expect(safeEntryName("home/anna/Bericht 2026 (final).pdf")).toBe(
      "home/anna/Bericht 2026 (final).pdf",
    );
    expect(safeEntryName(".config/app.json")).toBe(".config/app.json");
  });

  it("keeps names unique within one archive", () => {
    const names = new UniqueNames();
    expect(names.claim("docs/x.txt")).toBe("docs/x.txt");
    expect(names.claim("docs/x.txt")).toBe("docs/x (2).txt");
    expect(names.claim("docs/x.txt")).toBe("docs/x (3).txt");
    expect(names.claim("noext")).toBe("noext");
    expect(names.claim("noext")).toBe("noext (2)");
    expect(names.claim("dir.v1/file")).toBe("dir.v1/file");
    expect(names.claim("dir.v1/file")).toBe("dir.v1/file (2)");
  });

  it("strips the folders above a selected folder, so the ZIP shows what the user chose", () => {
    expect(parentPrefix("/home/anna/docs")).toBe("home/anna/");
    expect(parentPrefix("/home/anna/docs/")).toBe("home/anna/");
    expect(parentPrefix("/etc")).toBe("");
    expect(parentPrefix("/")).toBe("");
  });
});
