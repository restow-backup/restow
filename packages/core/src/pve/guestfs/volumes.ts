import { Ext4FileSystem, isExt } from "./ext4.js";
import { FatFileSystem, isFat } from "./fat.js";
import { assembleLogicalVolumes, type PhysicalVolume, readPhysicalVolume } from "./lvm.js";
import { NtfsFileSystem, ntfsKind } from "./ntfs.js";
import { GPT_SKIP, readPartitionTable } from "./partitions.js";
import {
  type ByteSource,
  type FsEntry,
  type FsFile,
  type GuestFileSystem,
  GuestFsError,
  pathParts,
  SliceSource,
} from "./source.js";
import { isXfs, XfsFileSystem } from "./xfs.js";

/**
 * The file systems of a VM restore point: every disk, its partitions (GPT or MBR), the LVM
 * logical volumes on them, and what each holds. A readable file system becomes a volume, a
 * top-level folder of the browser named after where it lies (`scsi0-p2`, `vg0-root`, `scsi1`
 * for a disk without a partition table); what cannot be read is reported with the reason.
 */

export interface GuestDisk {
  /** The QEMU drive id the backup used ("drive-scsi0"). */
  device: string;
  source: ByteSource;
}

export interface GuestVolume {
  /** The folder name in the browser. */
  id: string;
  fsType: GuestFileSystem["type"];
  label: string | null;
  size: number;
  note: string | null;
  fs: GuestFileSystem;
}

export interface SkippedVolume {
  id: string;
  reason: string;
}

export interface GuestVolumes {
  volumes: GuestVolume[];
  skipped: SkippedVolume[];
}

const MAX_VOLUMES = 128;

function deviceName(device: string): string {
  return (
    device
      .replace(/^drive-/, "")
      .replace(/-backup$/, "")
      .replace(/[^A-Za-z0-9_.-]/g, "_") || "disk"
  );
}

type Probe =
  | { kind: "fs"; fs: GuestFileSystem }
  | { kind: "pv"; pv: PhysicalVolume }
  | { kind: "none"; reason: string };

async function probe(source: ByteSource): Promise<Probe> {
  try {
    const pv = await readPhysicalVolume(source);
    if (pv) return { kind: "pv", pv };
    if (await isExt(source)) return { kind: "fs", fs: await Ext4FileSystem.open(source) };
    if (await isXfs(source)) return { kind: "fs", fs: await XfsFileSystem.open(source) };
    const ntfs = await ntfsKind(source);
    if (ntfs === "ntfs") return { kind: "fs", fs: await NtfsFileSystem.open(source) };
    if (ntfs === "bitlocker") return { kind: "none", reason: "BitLocker-encrypted" };
    if (await isFat(source)) return { kind: "fs", fs: await FatFileSystem.open(source) };
    const head = await source.read(0, Math.min(source.size, 4096));
    if (head.length === 4096 && head.toString("latin1", 4086, 4096).startsWith("SWAP")) {
      return { kind: "none", reason: "swap" };
    }
    return { kind: "none", reason: "no file system this reader knows" };
  } catch (error) {
    return {
      kind: "none",
      reason: error instanceof GuestFsError ? error.message : "it could not be read",
    };
  }
}

async function btrfsAt(source: ByteSource): Promise<boolean> {
  if (source.size < 0x10000 + 0x48) return false;
  return (await source.read(0x10040, 8)).toString("latin1") === "_BHRfS_M";
}

/** Find every readable file system of a VM's disks. */
export async function discoverVolumes(disks: readonly GuestDisk[]): Promise<GuestVolumes> {
  const volumes: GuestVolume[] = [];
  const skipped: SkippedVolume[] = [];
  const pvs: PhysicalVolume[] = [];
  const used = new Set<string>();
  const unique = (id: string) => {
    let name = id;
    for (let n = 2; used.has(name); n++) name = `${id}-${n}`;
    used.add(name);
    return name;
  };
  const take = async (id: string, source: ByteSource) => {
    if (volumes.length + skipped.length >= MAX_VOLUMES) return;
    if (await btrfsAt(source).catch(() => false)) {
      skipped.push({ id: unique(id), reason: "btrfs is not supported" });
      return;
    }
    const found = await probe(source);
    if (found.kind === "fs") {
      volumes.push({
        id: unique(id),
        fsType: found.fs.type,
        label: found.fs.label,
        size: source.size,
        note: found.fs.note,
        fs: found.fs,
      });
    } else if (found.kind === "pv") {
      pvs.push(found.pv);
    } else {
      skipped.push({ id: unique(id), reason: found.reason });
    }
  };
  for (const disk of disks) {
    const name = deviceName(disk.device);
    if (/^(efidisk|tpmstate)/.test(name)) continue;
    let table: Awaited<ReturnType<typeof readPartitionTable>> = null;
    try {
      table = await readPartitionTable(disk.source);
    } catch (error) {
      skipped.push({
        id: unique(name),
        reason:
          error instanceof GuestFsError ? error.message : "the partition table could not be read",
      });
      continue;
    }
    if (!table) {
      await take(name, disk.source);
      continue;
    }
    for (const part of table.partitions) {
      if (GPT_SKIP.has(part.type) || part.type === "0x82") continue;
      let slice: ByteSource;
      try {
        slice = new SliceSource(disk.source, part.offset, part.size);
      } catch {
        skipped.push({
          id: unique(`${name}-p${part.number}`),
          reason: "the partition lies outside the disk",
        });
        continue;
      }
      await take(`${name}-p${part.number}`, slice);
    }
  }
  for (const lv of assembleLogicalVolumes(pvs)) {
    const id = `${lv.vg}-${lv.name}`.replace(/[^A-Za-z0-9_.+-]/g, "_");
    if (!lv.source) {
      skipped.push({ id: unique(id), reason: lv.reason ?? "it could not be assembled" });
      continue;
    }
    await take(id, lv.source);
  }
  return { volumes, skipped };
}

/** One namespace over all volumes: `/<volume id>/<path in that file system>`. */
export class GuestFiles {
  constructor(readonly found: GuestVolumes) {}

  private split(path: string): { volume: GuestVolume; inner: string } | null {
    const parts = pathParts(path);
    const id = parts[0];
    if (!id) return null;
    const volume = this.found.volumes.find((v) => v.id === id);
    if (!volume) throw new GuestFsError("not_found", "no such volume");
    return { volume, inner: `/${parts.slice(1).join("/")}` };
  }

  async list(path: string): Promise<FsEntry[]> {
    const at = this.split(path);
    if (!at) {
      return this.found.volumes.map((v) => ({
        name: v.id,
        type: "dir" as const,
        size: v.size,
        mtime: null,
      }));
    }
    return at.volume.fs.list(at.inner);
  }

  async stat(path: string): Promise<FsEntry | null> {
    const at = this.split(path);
    if (!at) return { name: "/", type: "dir", size: null, mtime: null };
    if (at.inner === "/")
      return { name: at.volume.id, type: "dir", size: at.volume.size, mtime: null };
    return at.volume.fs.stat(at.inner);
  }

  async open(path: string): Promise<FsFile> {
    const at = this.split(path);
    if (!at || at.inner === "/") throw new GuestFsError("not_a_file", "not a regular file");
    return at.volume.fs.open(at.inner);
  }
}
