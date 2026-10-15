import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capacityPath, statfsSpace } from "./capacity.js";

const LOCAL = { kind: "local" as const, basePath: "/data/chunks" };
const S3 = {
  kind: "s3" as const,
  bucket: "backups",
  prefix: null,
  endpoint: null,
  region: "eu-central-1",
  forcePathStyle: false,
};

describe("capacityPath", () => {
  it("reads the tenant's own local repository", () => {
    const own = { ownTarget: { kind: "local", config: { basePath: "/mnt/contoso" } } };
    expect(capacityPath(own, LOCAL, false)).toBe("/mnt/contoso");
  });

  it("knows no capacity of an S3 repository or an unusable configuration", () => {
    expect(capacityPath({ ownTarget: { kind: "s3", config: { bucket: "b" } } }, LOCAL, true)).toBe(
      null,
    );
    expect(capacityPath({ ownTarget: { kind: "local", config: {} } }, LOCAL, true)).toBeNull();
    expect(capacityPath({ ownTarget: null }, S3, true)).toBeNull();
  });

  it("reads the installation default only for the tenant that has it to itself", () => {
    expect(capacityPath({ ownTarget: null }, LOCAL, true)).toBe("/data/chunks");
    expect(capacityPath({ ownTarget: null }, LOCAL, false)).toBeNull();
    expect(capacityPath({ ownTarget: null }, null, true)).toBeNull();
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
