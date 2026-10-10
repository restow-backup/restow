import { describe, expect, it } from "vitest";

import type { MountView } from "./sections/mounts-api";
import {
  deriveMountName,
  existingMountFor,
  formatNfsAddress,
  joinPath,
  parseNfsAddress,
  validSubfolder,
} from "./sections/nfs-address";

/**
 * The NFS addresses the path field of a storage location recognises (docs/MOUNTS.md,
 * "From the storage form"): what counts as one, what never does (local and Windows
 * paths, bare IPv6, ports, anything the mounter would refuse), the name derived for the
 * share, and how a share that is mounted already is matched.
 */

describe("parseNfsAddress", () => {
  it.each([
    ["192.168.1.10:/export/backup", "192.168.1.10", "/export/backup"],
    ["nas.local:/volume1/restow", "nas.local", "/volume1/restow"],
    ["NAS.Local:/volume1/restow/", "nas.local", "/volume1/restow"],
    ["  nas:/srv//backup  ", "nas", "/srv/backup"],
    ["nas.local.:/volume1", "nas.local", "/volume1"],
    ["[fd00::5]:/srv/backup", "fd00::5", "/srv/backup"],
    ["[FD00::5]:/srv", "fd00::5", "/srv"],
    ["nfs://192.168.1.10/export/backup", "192.168.1.10", "/export/backup"],
    ["NFS://nas.local/volume1/restow/sub", "nas.local", "/volume1/restow/sub"],
    ["nfs://[fd00::5]/srv/backup", "fd00::5", "/srv/backup"],
    ["nas:/", "nas", "/"],
  ])("recognises %s", (raw, server, exportPath) => {
    expect(parseNfsAddress(raw)).toEqual({ server, export: exportPath });
  });

  it.each([
    // Not an address at all, or a local path.
    "",
    "   ",
    "/data/chunks",
    "/mnt/restow/nas",
    "relative/path",
    "nas",
    // Windows paths: a single letter before the colon is a drive.
    "C:\\backup",
    "c:/backup",
    "C:/",
    "D:\\",
    "\\\\server\\share",
    "nfs://c/backup",
    // No export path, or a relative one.
    "nas:",
    "nas:volume1",
    "nfs://nas",
    "nfs:///export",
    // Ambiguous or unsupported: bare IPv6, ports, users, queries, other schemes.
    "fd00::5:/srv",
    "fd00::5/srv",
    "[fd00::5]/srv",
    "[nas]:/srv",
    "nas:2049:/srv",
    "nfs://nas:2049/srv",
    "nfs://[fd00::5]:2049/srv",
    "nfs://user@nas/srv",
    "nfs://nas/srv?ro",
    "nfs://nas/srv#x",
    "smb://nas/share",
    "https://nas/export",
    // What the mounter refuses anyway.
    "nas,nolock:/srv",
    "nas=x:/srv",
    "nas name:/srv",
    "nas:/srv/../etc",
    "nas:/srv,ro",
    "nas:/srv/a:b",
    "300.1.1.1:/srv",
    "-nas:/srv",
  ])("does not take %j for an NFS address", (raw) => {
    expect(parseNfsAddress(raw)).toBeNull();
  });

  it("prints IPv6 servers in brackets", () => {
    expect(formatNfsAddress({ server: "fd00::5", export: "/srv" })).toBe("[fd00::5]:/srv");
    expect(formatNfsAddress({ server: "nas", export: "/srv" })).toBe("nas:/srv");
  });
});

describe("deriveMountName", () => {
  it("takes the host's first label and the export's last folder", () => {
    expect(deriveMountName({ server: "nas.local", export: "/volume1/restow" })).toBe("nas-restow");
    expect(deriveMountName({ server: "192.168.1.10", export: "/export/backup" })).toBe("backup");
    expect(deriveMountName({ server: "fd00::5", export: "/srv/Backup_Data" })).toBe("backup-data");
    expect(deriveMountName({ server: "nas", export: "/" })).toBe("nas");
    expect(deriveMountName({ server: "10.0.0.5", export: "/" })).toBe("nfs");
  });

  it("keeps within 32 characters and avoids names in use", () => {
    const long = deriveMountName({
      server: "storage-server-in-the-basement.example",
      export: "/volume1/a-very-long-folder-name",
    });
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    expect(deriveMountName({ server: "10.0.0.5", export: "/backup" }, ["backup"])).toBe("backup-2");
    expect(deriveMountName({ server: "10.0.0.5", export: "/backup" }, ["backup", "backup-2"])).toBe(
      "backup-3",
    );
  });
});

describe("existingMountFor", () => {
  const share = (name: string, server: string, exportPath: string): MountView => ({
    mount: {
      protocol: "nfs",
      name,
      server,
      export: exportPath,
      nfsVersion: "4.1",
      readOnly: false,
    },
    path: `/mnt/restow/${name}`,
    volume: `restow-nfs-${name}-12345678`,
  });
  const mounts = [
    share("nas", "nas.local", "/volume1"),
    share("deep", "nas.local", "/volume1/restow"),
    share("other", "10.0.0.5", "/export"),
  ];

  it("finds the share itself or the deepest one above the path", () => {
    expect(existingMountFor({ server: "nas.local", export: "/volume1/restow" }, mounts)).toEqual({
      entry: mounts[1],
      subfolder: "",
      path: "/mnt/restow/deep",
    });
    expect(
      existingMountFor({ server: "nas.local", export: "/volume1/restow/tenant-a" }, mounts)?.path,
    ).toBe("/mnt/restow/deep/tenant-a");
    expect(existingMountFor({ server: "nas.local", export: "/volume1/x" }, mounts)?.path).toBe(
      "/mnt/restow/nas/x",
    );
  });

  it("matches neither another server nor a sibling folder", () => {
    expect(existingMountFor({ server: "nas2.local", export: "/volume1" }, mounts)).toBeNull();
    expect(existingMountFor({ server: "10.0.0.5", export: "/export2" }, mounts)).toBeNull();
  });
});

describe("paths below a share", () => {
  it("joins and checks the subfolder", () => {
    expect(joinPath("/mnt/restow/nas", "")).toBe("/mnt/restow/nas");
    expect(joinPath("/mnt/restow/nas", "/a//b/")).toBe("/mnt/restow/nas/a/b");
    expect(validSubfolder("")).toBe(true);
    expect(validSubfolder("tenant-a/backups")).toBe(true);
    expect(validSubfolder("../etc")).toBe(false);
    expect(validSubfolder("a b")).toBe(false);
    expect(validSubfolder("a,ro")).toBe(false);
  });
});
