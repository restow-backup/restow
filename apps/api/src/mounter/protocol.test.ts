import { describe, expect, it } from "vitest";
import {
  isValidMountName,
  mountSpecSchema,
  normalizeExportPath,
  normalizeNfsServer,
  operationProgress,
  testMountRequestSchema,
} from "./protocol.js";

describe("share names", () => {
  it("accepts lower-case letters, digits and inner hyphens, up to 32 characters", () => {
    for (const name of ["a", "nas", "nas-01", "0", "a".repeat(32), "backup-2026"]) {
      expect(isValidMountName(name), name).toBe(true);
    }
  });

  it("refuses everything else", () => {
    for (const name of [
      "",
      "-nas",
      "nas-",
      "NAS",
      "nas_01",
      "nas.01",
      "a".repeat(33),
      "../etc",
      "nas/x",
      "näs",
      "nas 01",
    ]) {
      expect(isValidMountName(name), name).toBe(false);
    }
  });
});

describe("NFS servers", () => {
  it("accepts host names, IPv4 and IPv6 addresses", () => {
    expect(normalizeNfsServer("nas.example.lan")).toBe("nas.example.lan");
    expect(normalizeNfsServer("NAS.Example.LAN.")).toBe("nas.example.lan");
    expect(normalizeNfsServer("nas")).toBe("nas");
    expect(normalizeNfsServer(" 192.168.1.10 ")).toBe("192.168.1.10");
    expect(normalizeNfsServer("fd00::10")).toBe("fd00::10");
    expect(normalizeNfsServer("[FD00::10]")).toBe("fd00::10");
  });

  it("refuses anything that could add a mount option or is no host", () => {
    for (const value of [
      "",
      "nas,nolock",
      "nas,addr=1.2.3.4",
      "addr=1.2.3.4",
      "nas example",
      "nas\tx",
      "fe80::1%eth0",
      "256.1.1.1",
      "1.2.3",
      "-nas",
      "nas-.lan",
      "[nas]",
      "nas:/export",
      "nas/",
      "a".repeat(64),
    ]) {
      expect(normalizeNfsServer(value), value).toBeNull();
    }
  });
});

describe("export paths", () => {
  it("accepts absolute paths and tidies slashes", () => {
    expect(normalizeExportPath("/")).toBe("/");
    expect(normalizeExportPath("/volume1/backup")).toBe("/volume1/backup");
    expect(normalizeExportPath("/volume1//backup/")).toBe("/volume1/backup");
    expect(normalizeExportPath("/mnt/pool_1/restow-data.v2")).toBe("/mnt/pool_1/restow-data.v2");
  });

  it("refuses relative paths, traversal and option characters", () => {
    for (const value of [
      "",
      "volume1",
      "/a/../b",
      "/a/./b",
      "/a,ro",
      "/a=b",
      "/a:b",
      "/a b",
      "/a\nb",
      "/a'b",
      '/a"b',
      `/${"a".repeat(1100)}`,
    ]) {
      expect(normalizeExportPath(value), value).toBeNull();
    }
  });
});

describe("mountSpecSchema", () => {
  it("parses a share and fills the defaults", () => {
    expect(
      mountSpecSchema.parse({
        protocol: "nfs",
        name: "nas",
        server: "[fd00::1]",
        export: "/data/",
      }),
    ).toEqual({
      protocol: "nfs",
      name: "nas",
      server: "fd00::1",
      export: "/data",
      nfsVersion: "4.1",
      readOnly: false,
    });
  });

  it("accepts the NFS versions 3, 4, 4.1 and 4.2 only", () => {
    for (const nfsVersion of ["3", "4", "4.1", "4.2"]) {
      expect(
        mountSpecSchema.safeParse({
          protocol: "nfs",
          name: "a",
          server: "x",
          export: "/e",
          nfsVersion,
        }).success,
      ).toBe(true);
    }
    for (const nfsVersion of ["2", "4.0", "5", 4, "4.1,nolock"]) {
      expect(
        mountSpecSchema.safeParse({
          protocol: "nfs",
          name: "a",
          server: "x",
          export: "/e",
          nfsVersion,
        }).success,
      ).toBe(false);
    }
  });

  it("refuses unknown protocols and unknown fields", () => {
    expect(
      mountSpecSchema.safeParse({ protocol: "smb", name: "a", server: "x", export: "/e" }).success,
    ).toBe(false);
    expect(
      mountSpecSchema.safeParse({
        protocol: "nfs",
        name: "a",
        server: "x",
        export: "/e",
        options: "nolock",
      }).success,
    ).toBe(false);
  });

  it("tests either settings or a configured share", () => {
    expect(testMountRequestSchema.safeParse({ name: "nas" }).success).toBe(true);
    expect(testMountRequestSchema.safeParse({ name: "Bad" }).success).toBe(false);
    expect(testMountRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("operationProgress", () => {
  it("weighs the steps", () => {
    expect(operationProgress([{ id: "validate", status: "done" }])).toBe(5);
    expect(
      operationProgress([
        { id: "validate", status: "done" },
        { id: "probe", status: "skipped" },
        { id: "write", status: "done" },
        { id: "apply", status: "running" },
      ]),
    ).toBe(48);
  });
});
