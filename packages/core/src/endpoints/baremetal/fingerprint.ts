/**
 * The layout fingerprint (docs/BAREMETAL.md 12.4): a SHA-256 over the parts of a Linux layout
 * that a restore depends on, and nothing volatile (free space, used bytes, mounted state, the
 * capture time). Two snapshots with the same fingerprint need the same restore plan. The Go agent
 * computes the same value (`LayoutFingerprint`, agent/internal/baremetal/fingerprint.go); the
 * shared test data carries it for each manifest (`<name>.fingerprint`).
 */
import { canonicalLayoutJson, canonicalSha256, compareUtf8 } from "./canonical.js";
import type { LayoutManifest, LinuxLayoutManifest } from "./manifest.js";

const lower = (value: string) => value.toLowerCase();

/** Sort by one or more string keys, compared by UTF-8 bytes; stable. */
function sortBy<T>(items: readonly T[], ...keys: ((item: T) => string)[]): T[] {
  return [...items].sort((a, b) => {
    for (const key of keys) {
      const order = compareUtf8(key(a), key(b));
      if (order !== 0) return order;
    }
    return 0;
  });
}

/** The projection the fingerprint hashes, in the shape the Go agent builds it. */
export function layoutFingerprintInput(m: LinuxLayoutManifest): Record<string, unknown> {
  const fsUuid = new Map(m.filesystems.map((fs) => [fs.id, fs.uuid]));
  const subvols: { fs: string | null; path: string }[] = [];
  for (const fs of m.filesystems) {
    for (const subvolume of fs.btrfs?.subvolumes ?? []) {
      if (subvolume.kind === "normal" || subvolume.kind === "machines") {
        subvols.push({ fs: fs.uuid, path: subvolume.path });
      }
    }
  }
  return {
    v: 1,
    platform: "linux",
    firmware: m.firmware.mode,
    disks: sortBy(m.disks, (d) => d.id).map((d) => ({
      id: d.id,
      table: d.table?.type ?? null,
      tableId: d.table ? lower(d.table.id) : null,
      parts: [...(d.table?.partitions ?? [])]
        .sort((a, b) => a.number - b.number)
        .map((p) => ({
          n: p.number,
          type: lower(p.type),
          uuid: lower(p.uuid ?? ""),
          size: p.sizeBytes,
        })),
    })),
    md: sortBy(m.md, (md) => md.uuid).map((md) => ({
      uuid: md.uuid,
      level: md.level,
      metadata: md.metadata,
      devices: md.raidDevices,
    })),
    luks: sortBy(m.luks, (luks) => luks.uuid).map((luks) => ({
      uuid: luks.uuid,
      version: luks.version,
      cipher: luks.cipher,
      keyBits: luks.keyBits,
      sectorSize: luks.sectorSize,
    })),
    plain: sortBy(m.plainCrypt, (plain) => plain.mappedName).map((plain) => ({
      name: plain.mappedName,
      cipher: plain.cipher,
      keyBits: plain.keyBits,
      purpose: plain.purpose,
    })),
    vgs: sortBy(m.lvm.vgs, (vg) => vg.name).map((vg) => ({
      name: vg.name,
      lvs: sortBy(vg.lvs, (lv) => lv.name).map((lv) => ({
        name: lv.name,
        type: lv.type,
        size: lv.sizeBytes,
        pool: lv.pool,
      })),
    })),
    fs: sortBy(
      m.filesystems,
      (fs) => fs.uuid ?? "",
      (fs) => fs.id,
    ).map((fs) => ({
      type: fs.type,
      uuid: fs.uuid,
      label: fs.label,
      features: [
        ...(fs.ext?.features ?? []),
        ...(fs.xfs?.features ?? []),
        ...(fs.btrfs?.features ?? []),
        ...(fs.vfat ? [`fat${fs.vfat.fatBits}`] : []),
      ].sort(compareUtf8),
    })),
    subvols: sortBy(
      subvols,
      (s) => s.fs ?? "",
      (s) => s.path,
    ),
    mounts: sortBy(m.mounts, (mount) => mount.target).map((mount) => ({
      target: mount.target,
      fs: mount.fs === null ? null : (fsUuid.get(mount.fs) ?? null),
    })),
    fstab: m.fstab.map((entry) => ({
      source: entry.source,
      target: entry.target,
      type: entry.type,
      options: entry.options,
    })),
    bootloader: m.bootloader.kind,
    initramfs: m.initramfs.generator,
    keymap: `${m.initramfs.keymap.layout ?? ""}:${m.initramfs.keymap.variant ?? ""}`,
  };
}

/** The layout fingerprint of a Linux manifest; macOS has none before M6. */
export function layoutFingerprint(m: LayoutManifest): string {
  if (m.platform !== "linux") {
    throw new Error("a layout fingerprint exists for Linux manifests only");
  }
  return canonicalSha256(canonicalLayoutJson(layoutFingerprintInput(m)));
}
