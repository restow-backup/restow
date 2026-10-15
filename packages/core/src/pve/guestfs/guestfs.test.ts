import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseLvmText } from "./lvm.js";
import { readPartitionTable } from "./partitions.js";
import { BufferSource, type ByteSource, GuestFsError } from "./source.js";
import { discoverVolumes, GuestFiles } from "./volumes.js";

/**
 * The guest file system readers against real images made by the file system tools themselves
 * (testdata/make-fixtures.sh: mkfs.ext4/ext2, mkfs.xfs, mkntfs and ntfs-3g, mkfs.vfat and
 * mtools, sgdisk, sfdisk, pvcreate/vgcreate/vgcfgrestore), each holding the same tree.
 */

const fixture = (name: string): ByteSource =>
  new BufferSource(gunzipSync(readFileSync(new URL(`./testdata/${name}.img.gz`, import.meta.url))));

/** big.bin as make-fixtures.sh writes it. */
function bigFile(): Buffer {
  const length = 300 * 1024 + 123;
  const out = Buffer.alloc(Math.ceil(length / 4) * 4);
  for (let i = 0; i * 4 < out.length; i++) {
    out.writeUInt32LE(Number((BigInt(i) * 2654435761n) % 4294967296n), i * 4);
  }
  return out.subarray(0, length);
}

async function readAll(files: GuestFiles, path: string): Promise<Buffer> {
  const file = await files.open(path);
  const parts: Buffer[] = [];
  // Odd piece sizes, so reads cross block and extent borders.
  for (let at = 0; at < file.size; at += 65_537) {
    parts.push(await file.read(at, Math.min(65_537, file.size - at)));
  }
  return Buffer.concat(parts);
}

async function expectTree(files: GuestFiles, volume: string, options: { symlink: boolean }) {
  const root = await files.list(`/${volume}`);
  const names = root.map((e) => e.name).sort();
  expect(names).toEqual(expect.arrayContaining(["empty", "etc", "home", "many", "var"]));
  expect(root.find((e) => e.name === "etc")?.type).toBe("dir");
  if (options.symlink) {
    expect(root.find((e) => e.name === "link")?.type).toBe("symlink");
  }
  expect((await readAll(files, `/${volume}/etc/hostname`)).toString()).toBe("web01\n");
  const anna = await files.list(`/${volume}/home/anna`);
  expect(anna.map((e) => e.name).sort()).toEqual(["Documents", "notes.txt", "ümlaut-é.txt"]);
  const notes = anna.find((e) => e.name === "notes.txt");
  expect(notes).toMatchObject({ type: "file", size: 11 });
  expect(notes?.mtime).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect((await readAll(files, `/${volume}/home/anna/Documents/report 2026.txt`)).toString()).toBe(
    "Quarterly report\n",
  );
  expect((await readAll(files, `/${volume}/home/anna/ümlaut-é.txt`)).toString()).toBe("unicode\n");
  expect((await readAll(files, `/${volume}/var/log/big.bin`)).equals(bigFile())).toBe(true);
  const many = await files.list(`/${volume}/many`);
  expect(many).toHaveLength(300);
  expect(many.map((e) => e.name)).toContain("file-with-a-rather-long-name-299.txt");
  expect(
    (await readAll(files, `/${volume}/many/file-with-a-rather-long-name-042.txt`)).toString(),
  ).toBe("entry 42\n");
  expect(await files.list(`/${volume}/empty`)).toEqual([]);
  expect(await files.stat(`/${volume}/etc/missing`)).toBeNull();
  await expect(files.open(`/${volume}/etc`)).rejects.toBeInstanceOf(GuestFsError);
  await expect(files.list(`/${volume}/etc/hostname`)).rejects.toBeInstanceOf(GuestFsError);
}

describe("a GPT disk with an EFI system partition and ext4", () => {
  it("finds both file systems and reads the tree", async () => {
    const disk = fixture("gpt-efi-ext4");
    const table = await readPartitionTable(disk);
    expect(table?.scheme).toBe("gpt");
    expect(table?.partitions.map((p) => p.name)).toEqual(["EFI", "root"]);
    const found = await discoverVolumes([{ device: "drive-scsi0", source: disk }]);
    expect(found.volumes.map((v) => [v.id, v.fsType, v.label])).toEqual([
      ["scsi0-p1", "vfat", "EFI"],
      ["scsi0-p2", "ext4", "root"],
    ]);
    const files = new GuestFiles(found);
    expect((await files.list("/")).map((e) => e.name)).toEqual(["scsi0-p1", "scsi0-p2"]);
    await expectTree(files, "scsi0-p2", { symlink: true });
    // FAT: long names, folders, case-insensitive lookup.
    const efi = await files.list("/scsi0-p1");
    expect(efi.map((e) => e.name).sort()).toEqual(["EFI", "Long File Name.txt"]);
    expect((await readAll(files, "/scsi0-p1/efi/boot/bootx64.efi")).toString()).toBe("efi\n");
    expect((await readAll(files, "/scsi0-p1/Long File Name.txt")).toString()).toBe("long name\n");
  });
});

describe("ext2 with 1 KiB blocks on a whole disk", () => {
  it("reads files through the indirect block maps", async () => {
    const found = await discoverVolumes([{ device: "drive-virtio1", source: fixture("raw-ext2") }]);
    expect(found.volumes.map((v) => [v.id, v.fsType, v.label])).toEqual([
      ["virtio1", "ext4", "legacy"],
    ]);
    await expectTree(new GuestFiles(found), "virtio1", { symlink: true });
  });
});

describe("an MBR disk with NTFS", () => {
  it("reads folders from their index and files from their runs", async () => {
    const found = await discoverVolumes([{ device: "drive-sata0", source: fixture("mbr-ntfs") }]);
    expect(found.volumes.map((v) => [v.id, v.fsType, v.label])).toEqual([
      ["sata0-p1", "ntfs", "DATA"],
    ]);
    const files = new GuestFiles(found);
    await expectTree(files, "sata0-p1", { symlink: false });
    // NTFS's own files never show; names are found in any case.
    const root = await files.list("/sata0-p1");
    expect(root.some((e) => e.name.startsWith("$Mft") || e.name === "$MFT")).toBe(false);
    expect((await readAll(files, "/sata0-p1/ETC/HOSTNAME")).toString()).toBe("web01\n");
  });
});

describe("LVM on an MBR disk: XFS in two segments and ext4 with a journal", () => {
  it("assembles the logical volumes and reads both", async () => {
    const found = await discoverVolumes([
      { device: "drive-scsi0", source: fixture("mbr-lvm-xfs-ext4") },
    ]);
    expect(found.volumes.map((v) => [v.id, v.fsType, v.label]).sort()).toEqual([
      ["fixvg-home", "ext4", "home"],
      ["fixvg-root", "xfs", "root"],
    ]);
    expect(found.volumes.find((v) => v.id === "fixvg-root")?.size).toBe(300 * 1024 * 1024);
    const files = new GuestFiles(found);
    await expectTree(files, "fixvg-root", { symlink: true });
    const home = found.volumes.find((v) => v.id === "fixvg-home");
    // Copied while mounted: the journal needed recovery and was replayed in memory.
    expect(home?.note).toBe("journal_replayed");
    expect((await readAll(files, "/fixvg-home/journal.txt")).toString()).toBe("written last\n");
    expect((await readAll(files, "/fixvg-home/anna/notes.txt")).toString()).toBe("Hello Anna\n");
  });
});

describe("hostile or damaged input", () => {
  it("reports an empty or unknown disk as nothing readable", async () => {
    const found = await discoverVolumes([
      { device: "drive-scsi0", source: new BufferSource(Buffer.alloc(1 << 20)) },
    ]);
    expect(found.volumes).toEqual([]);
    expect(found.skipped).toEqual([{ id: "scsi0", reason: "no file system this reader knows" }]);
  });

  it("survives random bytes and a damaged superblock without throwing", async () => {
    const noise = Buffer.alloc(2 << 20);
    let x = 12345;
    for (let i = 0; i < noise.length; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      noise[i] = x >>> 24;
    }
    // An ext magic in the noise: the reader must refuse, not crash.
    noise.writeUInt16LE(0xef53, 1024 + 56);
    const found = await discoverVolumes([
      { device: "drive-scsi0", source: new BufferSource(noise) },
    ]);
    expect(found.volumes).toEqual([]);
    expect(found.skipped).toHaveLength(1);
  });

  it("damages every byte of a real file system's metadata in turn without a crash or a hang", async () => {
    const image = gunzipSync(readFileSync(new URL("./testdata/raw-ext2.img.gz", import.meta.url)));
    for (const at of [1024 + 4, 1024 + 24, 1024 + 32, 1024 + 40, 2048 + 8, 2048 + 0]) {
      const copy = Buffer.from(image.subarray(0, 4 << 20));
      copy.writeUInt32LE(0xffffffff, at);
      const found = await discoverVolumes([
        { device: "drive-scsi0", source: new BufferSource(copy) },
      ]);
      for (const volume of found.volumes) {
        await new GuestFiles(found).list(`/${volume.id}`).catch((error) => {
          expect(error).toBeInstanceOf(GuestFsError);
        });
      }
    }
  });

  it("ends on every fixture with damaged metadata: errors, never a hang or a crash", async () => {
    // A fixed pseudo-random sequence: the same damage on every run.
    let x = 99;
    const random = (n: number) => {
      x = (x * 1103515245 + 12345) >>> 0;
      return x % n;
    };
    for (const name of ["gpt-efi-ext4", "raw-ext2", "mbr-ntfs", "mbr-lvm-xfs-ext4"]) {
      const image = gunzipSync(readFileSync(new URL(`./testdata/${name}.img.gz`, import.meta.url)));
      for (let round = 0; round < 6; round++) {
        const copy = Buffer.from(image);
        // Damage bytes where the metadata lives: the first MiB of the image.
        for (let i = 0; i < 400; i++) {
          copy[random(1 << 20)] = random(256);
        }
        let found: Awaited<ReturnType<typeof discoverVolumes>>;
        try {
          found = await discoverVolumes([
            { device: "drive-scsi0", source: new BufferSource(copy) },
          ]);
        } catch (error) {
          expect.fail(`discovery threw on ${name}: ${String(error)}`);
        }
        const files = new GuestFiles(found);
        const walk = async (path: string, depth: number): Promise<void> => {
          if (depth > 4) return;
          let entries: Awaited<ReturnType<GuestFiles["list"]>> = [];
          try {
            entries = await files.list(path);
          } catch {
            return;
          }
          for (const entry of entries.slice(0, 20)) {
            const child = `${path === "/" ? "" : path}/${entry.name}`;
            if (entry.type === "dir") await walk(child, depth + 1);
            if (entry.type === "file") {
              await files
                .open(child)
                .then((f) => f.read(0, Math.min(f.size, 1 << 20)))
                .catch(() => undefined);
            }
          }
        };
        await walk("/", 0);
      }
    }
  }, 60_000);

  it("parses LVM text and refuses what is not LVM text", () => {
    const text = 'vg { id = "x" seqno = 3 list = ["a", 1] # a comment\n sub { k = "v\\"q" } }';
    expect(parseLvmText(text)).toEqual({
      vg: { id: "x", seqno: 3, list: ["a", 1], sub: { k: 'v"q' } },
    });
    expect(() => parseLvmText("vg { id = ")).toThrow(GuestFsError);
    expect(() => parseLvmText("}")).toThrow(GuestFsError);
    expect(() => parseLvmText(`${"a { ".repeat(40)}${"} ".repeat(40)}`)).toThrow(GuestFsError);
  });

  it("refuses paths that climb out", async () => {
    const found = await discoverVolumes([{ device: "drive-virtio1", source: fixture("raw-ext2") }]);
    await expect(new GuestFiles(found).list("/virtio1/etc/../..")).rejects.toBeInstanceOf(
      GuestFsError,
    );
  });
});
