import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The container (LXC) the Restow server runs in (self-guest.ts): its VMID from the sources of the
 * mount table, as the API sees it inside its Docker container, and when a reported guest is it.
 */

const files = vi.hoisted(() => ({ mountinfo: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: string, encoding?: BufferEncoding) =>
      path === "/proc/self/mountinfo" ? files.mountinfo : actual.readFile(path, encoding),
  };
});

const {
  containerIsOwn,
  mountinfoVmids,
  normalizePveVmid,
  ownPveVmid,
  resetOwnPveVmid,
  volumeVmid,
} = await import("./self-guest.js");

/** What Docker's own mounts look like in any container: none names a guest volume. */
const DOCKER = [
  "1067 1012 0:142 / / rw,relatime master:530 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/QW3:/var/lib/docker/overlay2/l/ZT7,upperdir=/var/lib/docker/overlay2/9f1/diff,workdir=/var/lib/docker/overlay2/9f1/work",
  "1068 1067 0:146 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
  "1069 1067 0:147 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755,uid=100000,gid=100000",
  "1070 1069 0:148 / /dev/pts rw,nosuid,noexec,relatime - devpts devpts rw,gid=100005,mode=620,ptmxmode=666",
  "1071 1067 0:149 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro",
  "1072 1071 0:30 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw,nsdelegate",
  "1073 1069 0:145 / /dev/mqueue rw,nosuid,nodev,noexec,relatime - mqueue mqueue rw",
  "1074 1069 0:150 / /dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm rw,size=65536k,uid=100000,gid=100000",
];

const ZFS = [
  ...DOCKER,
  "1075 1067 0:62 /var/lib/docker/volumes/restow_restow-data/_data /data rw,relatime master:23 - zfs rpool/data/subvol-105-disk-0 rw,xattr,posixacl,casesensitive",
  "1076 1067 0:62 /var/lib/docker/containers/4be1/resolv.conf /etc/resolv.conf rw,relatime - zfs rpool/data/subvol-105-disk-0 rw,xattr,posixacl,casesensitive",
  // A volume of the same container (mp0) on another pool.
  "1077 1067 0:71 /backups /mnt/backups rw,relatime shared:12 master:40 - zfs tank/pve/subvol-105-disk-1 rw,xattr,posixacl",
].join("\n");

const LVM_THIN = [
  ...DOCKER,
  "1075 1067 253:7 /var/lib/docker/volumes/restow_pgdata/_data /var/lib/postgresql/data rw,relatime - ext4 /dev/mapper/pve-vm--112--disk--0 rw,stripe=16",
  "1076 1067 253:7 /var/lib/docker/containers/77aa/hosts /etc/hosts rw,relatime - ext4 /dev/mapper/pve-vm--112--disk--0 rw,stripe=16",
].join("\n");

afterEach(() => {
  delete process.env.RESTOW_HOST_PVE_VMID;
  resetOwnPveVmid();
});

describe("the VMID of the container the API runs in", () => {
  it("reads it from a ZFS subvolume and ignores Docker's own mounts", () => {
    expect(mountinfoVmids(ZFS)).toEqual([105]);
    expect(mountinfoVmids(DOCKER.join("\n"))).toEqual([]);
  });

  it("reads it from an LVM or LVM-thin volume, with dashes doubled in the device name", () => {
    expect(mountinfoVmids(LVM_THIN)).toEqual([112]);
    expect(volumeVmid("/dev/mapper/ssd--pool-vm--210--disk--1")).toBe(210);
    expect(volumeVmid("/dev/pve/vm-105-disk-0")).toBe(105);
    expect(volumeVmid("/dev/rbd-pve/1f2e3d4c/ceph-ct/vm-301-disk-0")).toBe(301);
    // A base volume of a template, a VM's own LVM inside the VM and a VM's disk are no match.
    expect(volumeVmid("/dev/mapper/ubuntu--vg-ubuntu--lv")).toBeNull();
    expect(volumeVmid("/dev/sda1")).toBeNull();
    expect(volumeVmid("/dev/mapper/pve-base--900--disk--0")).toBeNull();
    expect(volumeVmid("rpool/data/basevol-900-disk-0")).toBeNull();
    expect(volumeVmid("rpool/data/subvol-105-disk-0@snap")).toBeNull();
  });

  it("finds none on directory storage (a loop device) or in a VM", () => {
    const loop = [
      ...DOCKER,
      "1075 1067 7:3 /var/lib/docker/volumes/restow_restow-data/_data /data rw,relatime - ext4 /dev/loop3 rw",
    ].join("\n");
    const vm = [
      ...DOCKER,
      "1075 1067 8:1 /var/lib/docker/volumes/restow_restow-data/_data /data rw,relatime - ext4 /dev/sda1 rw,discard,errors=remount-ro",
    ].join("\n");
    expect(mountinfoVmids(loop)).toEqual([]);
    expect(mountinfoVmids(vm)).toEqual([]);
  });

  it("undoes the escapes of the mount table, also in the mount point before the source", () => {
    const line =
      "1080 1067 0:75 / /mnt/old\\040share rw,relatime - zfs tank/old\\040pool/subvol-107-disk-2 rw,xattr";
    expect(mountinfoVmids(line)).toEqual([107]);
    // A line without the separator or the source is skipped, not misread.
    expect(mountinfoVmids("1081 1067 0:76 / /x rw\n\n1082 1067 0:77 / /y rw - zfs")).toEqual([]);
  });

  it("takes VMIDs as PVE gives them", () => {
    expect(normalizePveVmid("105")).toBe(105);
    expect(normalizePveVmid(" 999999999 ")).toBe(999999999);
    expect(normalizePveVmid("99")).toBeNull();
    expect(normalizePveVmid("1e3")).toBeNull();
    expect(normalizePveVmid("-105")).toBeNull();
    expect(normalizePveVmid("")).toBeNull();
    expect(normalizePveVmid(undefined)).toBeNull();
  });

  describe("ownPveVmid", () => {
    beforeEach(() => {
      files.mountinfo = "";
      resetOwnPveVmid();
    });

    it("decides only when the mount table names exactly one guest", async () => {
      files.mountinfo = ZFS;
      expect(await ownPveVmid()).toBe(105);
      resetOwnPveVmid();
      // A volume of another container mounted in: two guests, no decision.
      files.mountinfo = `${ZFS}\n1090 1067 0:80 / /mnt/shared rw - zfs rpool/data/subvol-131-disk-0 rw`;
      expect(await ownPveVmid()).toBeNull();
      resetOwnPveVmid();
      files.mountinfo = DOCKER.join("\n");
      expect(await ownPveVmid()).toBeNull();
    });

    it("takes RESTOW_HOST_PVE_VMID before the mount table, a malformed one not at all", async () => {
      files.mountinfo = ZFS;
      process.env.RESTOW_HOST_PVE_VMID = "240";
      expect(await ownPveVmid()).toBe(240);
      resetOwnPveVmid();
      process.env.RESTOW_HOST_PVE_VMID = "ct-240";
      expect(await ownPveVmid()).toBe(105);
    });
  });
});

describe("whether a reported guest is the container the API runs in", () => {
  it("matches a container with the VMID when no other connected cluster has one", () => {
    expect(containerIsOwn(105, { kind: "ct", vmid: 105 }, 0)).toBe(true);
    expect(containerIsOwn(105, { kind: "ct", vmid: 106 }, 0)).toBe(false);
    expect(containerIsOwn(null, { kind: "ct", vmid: 105 }, 0)).toBe(false);
  });

  it("matches none while another connected cluster has a container with the VMID", () => {
    expect(containerIsOwn(105, { kind: "ct", vmid: 105 }, 1)).toBe(false);
  });

  it("never matches a VM by its VMID", () => {
    expect(containerIsOwn(105, { kind: "vm", vmid: 105 }, 0)).toBe(false);
  });
});
