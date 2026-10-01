import { describe, expect, it } from "vitest";
import {
  createStorageTargetSchema,
  probeStorageSchema,
  updateStorageTargetSchema,
} from "./schemas.js";

describe("createStorageTargetSchema", () => {
  it("accepts a local and an S3 target", () => {
    expect(
      createStorageTargetSchema.safeParse({
        kind: "local",
        name: "NAS",
        role: "copy",
        config: { basePath: "/mnt/nas" },
      }).success,
    ).toBe(true);
    expect(
      createStorageTargetSchema.safeParse({
        kind: "s3",
        name: "Hetzner",
        role: "primary",
        config: { bucket: "acme", endpoint: "https://fsn1.your-objectstorage.com", region: "fsn1" },
        credentials: { accessKeyId: "ABCDEF", secretAccessKey: "0123456789abcdef" },
      }).success,
    ).toBe(true);
  });

  it("requires credentials for S3", () => {
    expect(
      createStorageTargetSchema.safeParse({
        kind: "s3",
        name: "Hetzner",
        role: "copy",
        config: { bucket: "acme" },
      }).success,
    ).toBe(false);
  });

  it("refuses keys with whitespace (a pasted newline)", () => {
    const result = createStorageTargetSchema.safeParse({
      kind: "s3",
      name: "Hetzner",
      role: "copy",
      config: { bucket: "acme" },
      credentials: { accessKeyId: "ABCDEF", secretAccessKey: "0123456789abcdef\n" },
    });
    expect(result.success).toBe(false);
  });
});

describe("updateStorageTargetSchema", () => {
  it("needs at least one change", () => {
    expect(updateStorageTargetSchema.safeParse({}).success).toBe(false);
    expect(updateStorageTargetSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });
});

describe("probeStorageSchema", () => {
  it("needs credentials or a stored target for S3", () => {
    expect(probeStorageSchema.safeParse({ kind: "s3", config: { bucket: "acme" } }).success).toBe(
      false,
    );
    expect(
      probeStorageSchema.safeParse({
        kind: "s3",
        config: { bucket: "acme" },
        targetId: "8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d",
      }).success,
    ).toBe(true);
    expect(
      probeStorageSchema.safeParse({ kind: "local", config: { basePath: "/mnt/nas" } }).success,
    ).toBe(true);
  });
});
