import { describe, expect, it } from "vitest";
import { filesystemTypeOf, isOnServerDisk } from "./destination.js";

/**
 * Whether backups land on a disk of the server itself (docs/STORAGE.md, "Where backups
 * land"): the file system of the directory, from /proc/self/mountinfo.
 */

const MOUNTINFO = [
  "22 1 0:21 / / rw,relatime - overlay overlay rw,lowerdir=/a",
  "30 22 8:1 /var/lib/docker/volumes/restow_data/_data /data rw,relatime - ext4 /dev/sda1 rw",
  "31 22 0:50 / /mnt/nas rw,relatime - nfs4 192.0.2.10:/export rw,vers=4.1",
  "32 22 0:51 / /mnt/smb\\040share rw,relatime - cifs //192.0.2.11/backup rw",
].join("\n");

const local = (basePath: string) => ({ kind: "local" as const, basePath });

describe("the file system of a directory", () => {
  it("is the longest mount point that holds it", () => {
    expect(filesystemTypeOf(MOUNTINFO, "/data/chunks")).toBe("ext4");
    expect(filesystemTypeOf(MOUNTINFO, "/mnt/nas/restow")).toBe("nfs4");
    expect(filesystemTypeOf(MOUNTINFO, "/mnt/smb share/restow")).toBe("cifs");
    expect(filesystemTypeOf(MOUNTINFO, "/srv/backup")).toBe("overlay");
    // A prefix of a mount point's name is not inside it.
    expect(filesystemTypeOf(MOUNTINFO, "/mnt/nas2")).toBe("overlay");
  });
});

describe("backups on the server's own disk", () => {
  const info = async () => MOUNTINFO;

  it("is a directory on a local file system, not a network share or object storage", async () => {
    expect(await isOnServerDisk(local("/data/chunks"), true, info)).toBe(true);
    expect(await isOnServerDisk(local("/srv/backup"), false, info)).toBe(true);
    expect(await isOnServerDisk(local("/mnt/nas/restow"), false, info)).toBe(false);
    expect(await isOnServerDisk(local("/mnt/smb share/x"), false, info)).toBe(false);
    expect(
      await isOnServerDisk(
        {
          kind: "s3",
          bucket: "b",
          prefix: null,
          endpoint: null,
          region: "eu-central-1",
          forcePathStyle: false,
        },
        true,
        info,
      ),
    ).toBe(false);
  });

  it("counts only the installation default when the file system cannot be told", async () => {
    const none = async () => null;
    expect(await isOnServerDisk(local("/data/chunks"), true, none)).toBe(true);
    expect(await isOnServerDisk(local("/mnt/nas"), false, none)).toBe(false);
  });
});
