import { describe, expect, it } from "vitest";
import { RestoreSizeCounter } from "./restore-sizes.js";

const file = (path: string, size: number, inode: number, mtime = "2024-01-01T00:00:00Z") => ({
  path,
  type: "file" as const,
  size,
  inode,
  mtime,
});
const dir = (path: string, inode: number) => ({
  path,
  type: "dir" as const,
  size: 0,
  inode,
  mtime: "2024-01-01T00:00:00Z",
});

describe("RestoreSizeCounter", () => {
  it("credits every node to the longest mount target above it (nested mounts)", () => {
    const counter = new RestoreSizeCounter(["/", "/boot", "/boot/efi", "/home"]);
    for (const node of [
      dir("/", 2),
      dir("/etc", 10),
      file("/etc/fstab", 100, 11),
      dir("/boot", 2),
      file("/boot/vmlinuz", 5000, 12),
      dir("/boot/efi", 1),
      file("/boot/efi/EFI/debian/shimx64.efi", 4000, 5),
      dir("/home", 2),
      file("/home/alice/notes.txt", 7, 20),
      file("/homework.txt", 3, 13),
    ]) {
      counter.add(node);
    }
    expect(counter.result()).toEqual({
      "/": { bytes: 103, files: 2, inodes: 4 },
      "/boot": { bytes: 5000, files: 1, inodes: 2 },
      "/boot/efi": { bytes: 4000, files: 1, inodes: 2 },
      "/home": { bytes: 7, files: 1, inodes: 2 },
    });
  });

  it("counts a hard-linked file once per target", () => {
    const counter = new RestoreSizeCounter(["/", "/srv"]);
    counter.add(file("/srv/a", 1000, 42));
    counter.add(file("/srv/b", 1000, 42));
    // The same inode number on another file system is another file.
    counter.add(file("/usr/a", 1000, 42));
    expect(counter.result()["/srv"]).toEqual({ bytes: 1000, files: 1, inodes: 1 });
    expect(counter.result()["/"]).toEqual({ bytes: 1000, files: 1, inodes: 1 });
  });

  it("keeps btrfs subvolumes apart: equal inode numbers with other sizes or times are other files", () => {
    const counter = new RestoreSizeCounter(["/"]);
    // Every subvolume numbers its own inodes from 256.
    counter.add(file("/var/lib/machines/a/etc/hostname", 10, 257, "2024-01-01T00:00:00Z"));
    counter.add(file("/home/alice/.profile", 10, 257, "2024-02-01T00:00:00Z"));
    counter.add(file("/opt/tool/bin", 20, 257, "2024-01-01T00:00:00Z"));
    expect(counter.result()["/"]).toEqual({ bytes: 40, files: 3, inodes: 3 });
  });

  it("never merges files without an inode number", () => {
    const counter = new RestoreSizeCounter(["/"]);
    counter.add({ path: "/a", type: "file", size: 5, inode: 0, mtime: null });
    counter.add({ path: "/b", type: "file", size: 5, inode: null, mtime: null });
    expect(counter.result()["/"]).toEqual({ bytes: 10, files: 2, inodes: 2 });
  });

  it("leaves out what no target covers", () => {
    const counter = new RestoreSizeCounter(["/boot"]);
    counter.add(file("/etc/fstab", 10, 3));
    expect(counter.result()).toEqual({ "/boot": { bytes: 0, files: 0, inodes: 0 } });
  });

  it("bounds what it remembers: past the bound it counts every file and marks an upper bound", () => {
    const counter = new RestoreSizeCounter(["/", "/srv"], 3);
    counter.add(file("/srv/a", 10, 1));
    counter.add(file("/srv/b", 10, 2));
    counter.add(file("/usr/c", 10, 3));
    // The bound is reached: links of known files still merge, new files are counted each time.
    counter.add(file("/srv/a2", 10, 1));
    counter.add(file("/srv/d", 10, 4));
    counter.add(file("/srv/d2", 10, 4));
    counter.add(file("/usr/c2", 10, 3));
    expect(counter.result()).toEqual({
      "/": { bytes: 10, files: 1, inodes: 1 },
      "/srv": { bytes: 40, files: 4, inodes: 4 },
    });
    expect(counter.upperBounds()).toEqual(["/srv"]);
  });

  it("keeps its memory flat on millions of files", () => {
    const counter = new RestoreSizeCounter(["/"], 50_000);
    const before = process.memoryUsage().heapUsed;
    for (let i = 1; i <= 2_000_000; i++) {
      counter.add({
        path: `/data/${i}`,
        type: "file",
        size: 1,
        inode: i,
        mtime: "2024-01-01T00:00:00Z",
      });
    }
    const grown = process.memoryUsage().heapUsed - before;
    expect(counter.result()["/"]).toEqual({
      bytes: 2_000_000,
      files: 2_000_000,
      inodes: 2_000_000,
    });
    expect(counter.upperBounds()).toEqual(["/"]);
    // 50,000 keys take a few MB; 2,000,000 would take well over 100 MB.
    expect(grown).toBeLessThan(60 * 1024 * 1024);
  });
});
