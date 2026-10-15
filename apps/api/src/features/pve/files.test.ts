import { describe, expect, it } from "vitest";
import { containerBackupPaths } from "./files.js";

describe("containerBackupPaths (#62)", () => {
  it("is the root file system and the volume mount points vzdump backs up", () => {
    const config = [
      "arch: amd64",
      "rootfs: local-lvm:vm-300-disk-0,size=8G",
      "mp0: local-lvm:vm-300-disk-1,mp=/mnt/data,backup=1,size=4G",
      // Volumes without backup=1, bind and device mounts are not in a vzdump backup.
      "mp1: local-lvm:vm-300-disk-2,mp=/var/cache,size=4G",
      "mp2: /srv/host,mp=/mnt/host,backup=1",
      "mp3: /dev/sdb1,mp=/mnt/disk,backup=1",
      "mp4: volume=tank:subvol-300-disk-3,mp=/srv/media/,backup=1",
      "",
      "[before-upgrade]",
      "mp9: local-lvm:vm-300-disk-9,mp=/old,backup=1",
    ].join("\n");
    expect(containerBackupPaths(config)).toEqual(["/", "/mnt/data", "/srv/media"]);
  });

  it("is the root alone for a container without mount points", () => {
    expect(containerBackupPaths("arch: amd64\nrootfs: local:300/vm-300-disk-0.raw\n")).toEqual([
      "/",
    ]);
    expect(containerBackupPaths("")).toEqual(["/"]);
  });
});
