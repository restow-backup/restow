import { RestoreIntegrityError } from "@restow/core";
import { describe, expect, it } from "vitest";
import {
  ArchiveContentError,
  archiveContentObject,
  contentProblemOf,
  emlFileName,
} from "./content.js";

describe("archived content", () => {
  const row = {
    id: "0b6b5a2e-0000-4000-8000-000000000001",
    itemHash: "ab".repeat(32),
    sizeBytes: 12,
    chunks: ["c1", "c2"],
    receivedAt: new Date("2026-01-05T10:00:00Z"),
  };

  it("reads a row by its chunks, size and recorded SHA-256", () => {
    expect(archiveContentObject(row)).toMatchObject({
      size: 12,
      sha256: row.itemHash,
      chunks: ["c1", "c2"],
    });
  });

  it("refuses a row without a recorded chunk list or size", () => {
    expect(archiveContentObject({ ...row, chunks: null })).toBeNull();
    expect(archiveContentObject({ ...row, sizeBytes: null })).toBeNull();
  });

  it("tells a verified mismatch from content storage did not deliver", () => {
    expect(contentProblemOf(new RestoreIntegrityError("hash"))).toBe("mismatch");
    expect(contentProblemOf(new Error("ENOENT"))).toBe("unreadable");
    expect(contentProblemOf(new ArchiveContentError("not_recorded"))).toBe("not_recorded");
  });

  it("names the download after the subject, without characters a file system refuses", () => {
    expect(emlFileName("Re: Rechnung 4711 / März\t2026", row.id)).toBe(
      "Re Rechnung 4711 März 2026.eml",
    );
    expect(emlFileName(null, row.id)).toBe(`${row.id}.eml`);
    expect(emlFileName("   ", row.id)).toBe(`${row.id}.eml`);
  });
});
