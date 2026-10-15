import { describe, expect, it } from "vitest";

import { COMPRESSED_EXTENSIONS, PLAIN_EXTENSIONS } from "./entropy.js";
import {
  baseNameOf,
  extensionOf,
  isRansomNoteName,
  isRansomwareExtension,
  RANSOM_NOTE_NAMES,
  RANSOMWARE_EXTENSIONS,
  RANSOMWARE_SIGNATURES_VERSION,
} from "./signatures.js";

describe("the name signatures", () => {
  it("are versioned", () => {
    expect(RANSOMWARE_SIGNATURES_VERSION).toMatch(/^\d{4}\.\d{2}-\d+$/);
  });

  it("hold lower-case extensions without a dot, once each", () => {
    for (const ext of RANSOMWARE_EXTENSIONS) {
      expect(ext).toBe(ext.toLowerCase());
      expect(ext.startsWith(".")).toBe(false);
    }
    expect(new Set(RANSOMWARE_EXTENSIONS).size).toBe(RANSOMWARE_EXTENSIONS.length);
  });

  it("leave out extensions that ordinary software uses", () => {
    for (const ext of ["enc", "java", "xyz", "abc", "txt", "docx", "pdf", "zip", "bak", "tmp"]) {
      expect(isRansomwareExtension(ext)).toBe(false);
    }
    // No overlap with the formats the entropy rules know as ordinary files.
    for (const ext of [...COMPRESSED_EXTENSIONS, ...PLAIN_EXTENSIONS]) {
      expect(RANSOMWARE_EXTENSIONS).not.toContain(ext);
    }
  });

  it("match extensions with or without the dot, in any case", () => {
    expect(isRansomwareExtension(".LOCKED")).toBe(true);
    expect(isRansomwareExtension("lockbit")).toBe(true);
    expect(isRansomwareExtension(" .Encrypted ")).toBe(true);
  });

  it("recognise ransom notes by fixed name and by their words", () => {
    for (const name of [
      "README_TO_DECRYPT.txt",
      "HOW_TO_DECRYPT_FILES.html",
      "How-To-Restore-Your-Files.hta",
      "_readme.txt",
      "Restore-My-Files.txt",
      "C:\\Users\\a\\Desktop\\RyukReadMe.txt",
      "/share/finance/!!!_READ_ME_!!!.txt",
      "DECRYPT-INSTRUCTIONS.rtf",
    ]) {
      expect(isRansomNoteName(name), name).toBe(true);
    }
    for (const name of RANSOM_NOTE_NAMES) {
      expect(isRansomNoteName(name), name).toBe(true);
    }
  });

  it("leave ordinary names alone", () => {
    for (const name of [
      "README.txt",
      "readme.md",
      "restore.log",
      "decrypt.py",
      "Help.html",
      "files.txt",
      "how_to_decrypt.docx",
      "recover.txt",
      "",
    ]) {
      expect(isRansomNoteName(name), name).toBe(false);
    }
  });

  it("read extensions and base names of both path styles", () => {
    expect(extensionOf("/a/b/report.docx.locked")).toBe("locked");
    expect(extensionOf("C:\\x\\Report.PDF")).toBe("pdf");
    expect(extensionOf(".bashrc")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf("trailing.")).toBe("");
    expect(baseNameOf("C:\\x\\y.txt")).toBe("y.txt");
    expect(baseNameOf("plain")).toBe("plain");
  });
});
