import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { primaryLocation, statfsSpace } from "./capacity.js";

const LOCAL = { kind: "local" as const, basePath: "/data/chunks" };
const S3 = {
  kind: "s3" as const,
  bucket: "backups",
  prefix: null,
  endpoint: null,
  region: "eu-central-1",
  forcePathStyle: false,
};

describe("primaryLocation", () => {
  it("is the tenant's own repository when it has one", () => {
    const own = { ownTarget: { kind: "local", config: { basePath: "/mnt/contoso" } } };
    expect(primaryLocation(own, LOCAL)).toEqual({ kind: "local", basePath: "/mnt/contoso" });
    const bucket = {
      ownTarget: { kind: "s3", config: { bucket: "backups", region: "eu-central-1" } },
    };
    expect(primaryLocation(bucket, LOCAL)).toMatchObject({ kind: "s3", bucket: "backups" });
  });

  it("knows no repository for an unusable configuration of the tenant's own", () => {
    expect(primaryLocation({ ownTarget: { kind: "local", config: {} } }, LOCAL)).toBeNull();
    expect(
      primaryLocation({ ownTarget: { kind: "s3", config: { bucket: "" } } }, LOCAL),
    ).toBeNull();
  });

  it("is the installation default for a tenant without a repository of its own", () => {
    expect(primaryLocation({ ownTarget: null }, LOCAL)).toBe(LOCAL);
    expect(primaryLocation({ ownTarget: null }, S3)).toBe(S3);
    expect(primaryLocation({ ownTarget: null }, null)).toBeNull();
  });
});

describe("statfsSpace", () => {
  it("reads the free and the total space of a filesystem", async () => {
    const space = await statfsSpace(tmpdir());
    expect(space?.totalBytes).toBeGreaterThan(0);
    expect(space?.freeBytes).toBeGreaterThanOrEqual(0);
    expect(space?.freeBytes).toBeLessThanOrEqual(space?.totalBytes ?? 0);
  });

  it("answers null for a path that does not exist", async () => {
    expect(await statfsSpace(join(tmpdir(), "restow-no-such-directory", "x"))).toBeNull();
  });
});
