import { describe, expect, it } from "vitest";
import {
  createImportSchema,
  createUploadSchema,
  folderQuerySchema,
  listImportsQuerySchema,
  normalizeFolderPath,
  segmentParamsSchema,
  segmentSha256Schema,
} from "./schemas.js";

const UPLOAD_A = "6f1b0d1e-0a11-4c23-9d30-1a2b3c4d5e6f";
const UPLOAD_B = "7a2c1e2f-1b22-4d34-8e41-2b3c4d5e6f70";
const OBJECT = "8b3d2f30-2c33-4e45-9f52-3c4d5e6f7081";

describe("createUploadSchema", () => {
  it("accepts a name, a size and an optional segment size", () => {
    expect(createUploadSchema.parse({ fileName: " archive.zip ", size: 1234 })).toEqual({
      fileName: "archive.zip",
      size: 1234,
    });
    expect(
      createUploadSchema.parse({ fileName: "a.mbox", size: 10, segmentSize: 65536 }).segmentSize,
    ).toBe(65536);
  });

  it("rejects an empty file, a fraction and a missing size", () => {
    expect(createUploadSchema.safeParse({ fileName: "a.eml", size: 0 }).success).toBe(false);
    expect(createUploadSchema.safeParse({ fileName: "a.eml", size: 1.5 }).success).toBe(false);
    expect(createUploadSchema.safeParse({ fileName: "a.eml" }).success).toBe(false);
  });

  it("rejects names that could pass as paths or carry control characters", () => {
    for (const fileName of [
      "",
      "   ",
      "../evil.eml",
      "dir/a.eml",
      "dir\\a.eml",
      "a\u0000.eml",
      "a\n.eml",
    ]) {
      expect(createUploadSchema.safeParse({ fileName, size: 10 }).success, fileName).toBe(false);
    }
    expect(createUploadSchema.safeParse({ fileName: "x".repeat(256), size: 10 }).success).toBe(
      false,
    );
    expect(
      createUploadSchema.safeParse({ fileName: "Müller Postfach 2019.pst", size: 10 }).success,
    ).toBe(true);
  });

  it("does not cap the size itself: the limit is the server's 413", () => {
    expect(createUploadSchema.safeParse({ fileName: "big.zip", size: 2 ** 40 }).success).toBe(true);
  });
});

describe("segmentParamsSchema and the checksum header", () => {
  it("reads the index as a number and refuses negatives", () => {
    expect(segmentParamsSchema.parse({ id: UPLOAD_A, index: "7" }).index).toBe(7);
    expect(segmentParamsSchema.safeParse({ id: UPLOAD_A, index: "-1" }).success).toBe(false);
    expect(segmentParamsSchema.safeParse({ id: UPLOAD_A, index: "1.5" }).success).toBe(false);
    expect(segmentParamsSchema.safeParse({ id: "nope", index: "0" }).success).toBe(false);
  });

  it("wants exactly 64 hexadecimal digits", () => {
    expect(segmentSha256Schema.safeParse("a".repeat(64)).success).toBe(true);
    expect(segmentSha256Schema.safeParse("A".repeat(64)).success).toBe(true);
    expect(segmentSha256Schema.safeParse("a".repeat(63)).success).toBe(false);
    expect(segmentSha256Schema.safeParse("g".repeat(64)).success).toBe(false);
  });
});

describe("folderQuerySchema", () => {
  it("defaults to the import folder itself", () => {
    expect(folderQuerySchema.parse({})).toEqual({ path: "" });
    expect(folderQuerySchema.parse({ path: "MailStore/2019" }).path).toBe("MailStore/2019");
  });
});

describe("normalizeFolderPath", () => {
  it("drops empty and dot components", () => {
    expect(normalizeFolderPath("/a//b/./c/")).toBe("a/b/c");
    expect(normalizeFolderPath("")).toBe("");
    expect(normalizeFolderPath(".")).toBe("");
  });
});

describe("createImportSchema", () => {
  const upload = { origin: "upload", uploadId: UPLOAD_A } as const;

  it("takes a new mailbox name and defaults archive to false", () => {
    const parsed = createImportSchema.parse({ name: " Old mail ", files: [upload] });
    expect(parsed).toMatchObject({ name: "Old mail", archive: false });
    expect(parsed.objectId).toBeUndefined();
  });

  it("takes an existing mailbox instead of a name", () => {
    const parsed = createImportSchema.parse({
      objectId: OBJECT,
      files: [upload, { origin: "folder", path: "MailStore" }],
      archive: true,
    });
    expect(parsed.objectId).toBe(OBJECT);
    expect(parsed.archive).toBe(true);
  });

  it("wants exactly one of name and objectId", () => {
    expect(createImportSchema.safeParse({ files: [upload] }).success).toBe(false);
    expect(
      createImportSchema.safeParse({ name: "x", objectId: OBJECT, files: [upload] }).success,
    ).toBe(false);
  });

  it("bounds the name and requires at least one file", () => {
    expect(createImportSchema.safeParse({ name: "", files: [upload] }).success).toBe(false);
    expect(createImportSchema.safeParse({ name: "x".repeat(121), files: [upload] }).success).toBe(
      false,
    );
    expect(createImportSchema.safeParse({ name: "x", files: [] }).success).toBe(false);
  });

  it("refuses the same upload or folder path twice, however the path is spelled", () => {
    expect(
      createImportSchema.safeParse({ name: "x", files: [upload, { ...upload }] }).success,
    ).toBe(false);
    expect(
      createImportSchema.safeParse({
        name: "x",
        files: [
          { origin: "folder", path: "a/b" },
          { origin: "folder", path: "/a//b/" },
        ],
      }).success,
    ).toBe(false);
    expect(
      createImportSchema.safeParse({
        name: "x",
        files: [upload, { origin: "upload", uploadId: UPLOAD_B }, { origin: "folder", path: "a" }],
      }).success,
    ).toBe(true);
  });

  it("refuses an unknown origin", () => {
    expect(
      createImportSchema.safeParse({ name: "x", files: [{ origin: "url", path: "http://x" }] })
        .success,
    ).toBe(false);
  });
});

describe("listImportsQuerySchema", () => {
  it("defaults to 50 and never exceeds it", () => {
    expect(listImportsQuerySchema.parse({}).limit).toBe(50);
    expect(listImportsQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(listImportsQuerySchema.parse({ limit: "10" }).limit).toBe(10);
  });

  it("pages with an offset that starts at the newest import", () => {
    expect(listImportsQuerySchema.parse({}).offset).toBe(0);
    expect(listImportsQuerySchema.parse({ offset: "50" }).offset).toBe(50);
    expect(listImportsQuerySchema.safeParse({ offset: "-1" }).success).toBe(false);
  });
});
