import { describe, expect, it } from "vitest";
import { locationOnSystemDisk } from "./destination.js";
import { mountOf, onSystemDisk } from "./system-disk.js";

/**
 * A repository on the server's system disk (incident of 16 October 2026), seen from inside the
 * api container: `/` is the overlay of Docker's data directory, /etc/hostname a bind mount of a
 * file in /var/lib/docker/containers on the system disk (/dev/sda1).
 */

const MOUNTINFO = [
  "22 1 0:21 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/A",
  "30 22 8:1 /var/lib/docker/volumes/restow_data/_data /data rw,relatime - ext4 /dev/sda1 rw",
  "31 22 0:50 / /mnt/restow/nas rw,relatime - nfs4 192.0.2.10:/export rw,vers=4.1",
  "32 22 8:17 /srv/backup /backup rw,relatime - ext4 /dev/sdb1 rw",
  "33 22 0:60 /@data/restow /btrfs rw,relatime - btrfs /dev/sda1 rw,subvol=/@data",
  "40 22 8:1 /var/lib/docker/containers/abc/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw",
  "41 22 8:1 /var/lib/docker/containers/abc/hosts /etc/hosts rw,relatime - ext4 /dev/sda1 rw",
].join("\n");

/** Devices as stat reports them; paths below a mount take the mount's device. */
const DEVICES: [string, number][] = [
  ["/data", 2049], // 8:1
  ["/mnt/restow/nas", 50],
  ["/backup", 2065], // 8:17
  ["/btrfs", 60], // a btrfs subvolume: a device number of its own
  ["/etc/hostname", 2049],
  ["/etc/hosts", 2049],
  ["/", 21], // the overlay
];

/** Every path exists except the ones listed. */
function deps(missing: string[] = []) {
  return {
    deviceOf: async (path: string) => {
      if (missing.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
        return null;
      }
      const found = DEVICES.find(([mount]) => path === mount || path.startsWith(`${mount}/`));
      return found ? found[1] : 21;
    },
    mountinfo: async () => MOUNTINFO,
  };
}

describe("a repository on the system disk", () => {
  it("is a named volume or a host directory on the disk under Docker's data directory", async () => {
    expect(await onSystemDisk("/data/chunks", deps())).toBe(true);
  });

  it("is a path in the container's own layer, e.g. a mount point whose share is not mounted", async () => {
    expect(await onSystemDisk("/srv/restow", deps())).toBe(true);
  });

  it("is a btrfs subvolume of the same disk, by its block device", async () => {
    expect(await onSystemDisk("/btrfs/repo", deps())).toBe(true);
  });

  it("is not a network share or a second disk", async () => {
    expect(await onSystemDisk("/mnt/restow/nas/repo", deps())).toBe(false);
    expect(await onSystemDisk("/backup/repo", deps())).toBe(false);
  });

  it("counts a path that does not exist yet by the nearest directory above it", async () => {
    expect(await onSystemDisk("/backup/new/repo", deps(["/backup/new"]))).toBe(false);
    expect(await onSystemDisk("/data/new/chunks", deps(["/data/new"]))).toBe(true);
  });

  it("decides by device numbers alone where mountinfo cannot be read", async () => {
    const plain = { ...deps(), mountinfo: async () => null };
    expect(await onSystemDisk("/data/chunks", plain)).toBe(true);
    expect(await onSystemDisk("/btrfs/repo", plain)).toBe(false);
  });

  it("is only ever a directory, never object storage", async () => {
    expect(await locationOnSystemDisk({ kind: "local", basePath: "/data/chunks" }, deps())).toBe(
      true,
    );
    expect(
      await locationOnSystemDisk(
        {
          kind: "s3",
          bucket: "b",
          prefix: null,
          endpoint: null,
          region: "us-east-1",
          forcePathStyle: false,
        } as never,
        deps(),
      ),
    ).toBe(false);
    expect(await locationOnSystemDisk(null, deps())).toBe(false);
  });

  it("reads the mount of a path as the longest mount point holding it", () => {
    expect(mountOf(MOUNTINFO, "/data/chunks")?.source).toBe("/dev/sda1");
    expect(mountOf(MOUNTINFO, "/srv")?.source).toBe("overlay");
    expect(mountOf(MOUNTINFO, "/etc/hostname")?.source).toBe("/dev/sda1");
  });
});
