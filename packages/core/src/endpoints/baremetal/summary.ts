/**
 * What the machine's page shows of a layout (docs/BAREMETAL.md 14.6): the disks as bars with their
 * partitions, the storage stack as a tree, firmware, boot loader, distribution and encryption.
 * Stored next to the manifest (`endpoint_layouts.summary`), so the page never loads the full
 * manifest with its serial numbers (an admin opens that on its own route).
 */
import type { BlockRef, LinuxLayoutManifest } from "./manifest.js";

export const PARTITION_CONTENTS = [
  "esp",
  "bios_boot",
  "filesystem",
  "luks",
  "md",
  "pv",
  "swap",
  "plain",
  "empty",
  "other",
] as const;
export type PartitionContent = (typeof PARTITION_CONTENTS)[number];

export type LayoutStackKind =
  | "disk"
  | "partition"
  | "md"
  | "luks"
  | "plain"
  | "vg"
  | "lv"
  | "fs"
  | "subvolume"
  | "swap";

export interface LayoutStackNode {
  kind: LayoutStackKind;
  id: string;
  label: string;
  sizeBytes: number | null;
  children: LayoutStackNode[];
}

export interface LayoutSummary {
  platform: "linux";
  os: {
    prettyName: string | null;
    id: string;
    versionId: string | null;
    arch: string;
    kernel: string;
  };
  firmware: { mode: "uefi" | "bios"; secureBoot: boolean | null };
  bootloader: { kind: string; platform: string | null; shim: boolean };
  initramfs: { generator: string | null; keymap: string | null };
  disks: {
    id: string;
    kname: string;
    model: string | null;
    sizeBytes: number;
    transport: string | null;
    logicalSectorSize: number;
    tableType: "gpt" | "dos" | null;
    partitions: {
      number: number;
      startBytes: number;
      sizeBytes: number;
      content: PartitionContent;
      label: string | null;
    }[];
  }[];
  stack: LayoutStackNode[];
  mounts: { target: string; type: string }[];
  encryption: { luks: number; plainCrypt: number; tokenTypes: string[] };
  vgs: { name: string; sizeBytes: number; freeBytes: number }[];
  counts: { subvolumes: number; lvs: number };
}

const ESP_TYPES = new Set(["c12a7328-f81f-11d2-ba4b-00a0c93ec93b", "ef"]);
const BIOS_BOOT_TYPE = "21686148-6449-6e6f-744e-656564454649";
const EMPTY_TYPES = new Set(["00000000-0000-0000-0000-000000000000", "0", "00"]);

function refKey(ref: BlockRef): string {
  switch (ref.kind) {
    case "disk":
      return `disk:${ref.disk}`;
    case "partition":
      return `partition:${ref.disk}:${ref.number}`;
    case "md":
      return `md:${ref.id}`;
    case "luks":
      return `luks:${ref.id}`;
    case "plain":
      return `plain:${ref.id}`;
    case "lv":
      return `lv:${ref.vg}/${ref.lv}`;
  }
}

/** The kernel's name of partition `n` of a disk (`sda1`, `nvme0n1p1`). */
function partitionName(kname: string, n: number): string {
  return /\d$/.test(kname) ? `${kname}p${n}` : `${kname}${n}`;
}

/** What lies on each block device, by the key of {@link refKey}. */
function usersOf(m: LinuxLayoutManifest): Map<string, PartitionContent> {
  const content = new Map<string, PartitionContent>();
  const set = (ref: BlockRef | null, kind: PartitionContent) => {
    if (ref && !content.has(refKey(ref))) content.set(refKey(ref), kind);
  };
  for (const luks of m.luks) set(luks.device, "luks");
  for (const md of m.md) {
    for (const member of md.members) set(member.device, "md");
    for (const spare of md.spares) set(spare, "md");
  }
  for (const pv of m.lvm.pvs) set(pv.device, "pv");
  for (const plain of m.plainCrypt) set(plain.device, plain.purpose === "swap" ? "swap" : "plain");
  for (const swap of m.swap) set(swap.device, "swap");
  for (const fs of m.filesystems) for (const device of fs.devices) set(device, "filesystem");
  return content;
}

/** The storage stack as a tree from the disks down; a device on several parents hangs under the first. */
function stackOf(m: LinuxLayoutManifest): LayoutStackNode[] {
  const nodes = new Map<string, LayoutStackNode>();
  const placed = new Set<string>();
  const node = (key: string, kind: LayoutStackKind, label: string, size: number | null) => {
    const created: LayoutStackNode = { kind, id: key, label, sizeBytes: size, children: [] };
    nodes.set(key, created);
    return created;
  };
  const attach = (parentKey: string, child: LayoutStackNode) => {
    const parent = nodes.get(parentKey);
    if (!parent || placed.has(child.id)) return;
    parent.children.push(child);
    placed.add(child.id);
  };

  const roots: LayoutStackNode[] = [];
  for (const disk of m.disks) {
    const diskNode = node(`disk:${disk.id}`, "disk", disk.kname, disk.sizeBytes);
    roots.push(diskNode);
    placed.add(diskNode.id);
    for (const partition of disk.table?.partitions ?? []) {
      const key = `partition:${disk.id}:${partition.number}`;
      attach(
        diskNode.id,
        node(key, "partition", partitionName(disk.kname, partition.number), partition.sizeBytes),
      );
    }
  }
  // Holders in the order they can depend on each other: md, LUKS and plain on partitions (or on
  // each other), VGs on PVs, LVs in VGs, file systems and swap on any of them. Two passes place
  // a LUKS volume on an LV after the LV exists.
  const pending: (() => boolean)[] = [];
  for (const md of m.md) {
    const mdNode = node(`md:${md.id}`, "md", md.name ?? md.kname, md.sizeBytes);
    const parents = [...md.members.map((member) => member.device), ...md.spares];
    pending.push(() => place(mdNode, parents));
  }
  for (const luks of m.luks) {
    const luksNode = node(`luks:${luks.id}`, "luks", luks.mappedName ?? luks.uuid, null);
    pending.push(() => place(luksNode, [luks.device]));
  }
  for (const plain of m.plainCrypt) {
    const plainNode = node(`plain:${plain.id}`, "plain", plain.mappedName, null);
    pending.push(() => place(plainNode, [plain.device]));
  }
  for (const vg of m.lvm.vgs) {
    const vgNode = node(`vg:${vg.name}`, "vg", vg.name, vg.sizeBytes);
    for (const lv of vg.lvs) {
      vgNode.children.push(
        node(`lv:${vg.name}/${lv.name}`, "lv", `${vg.name}/${lv.name}`, lv.sizeBytes),
      );
      placed.add(`lv:${vg.name}/${lv.name}`);
    }
    const pvs = m.lvm.pvs.filter((pv) => pv.vg === vg.name).map((pv) => pv.device);
    pending.push(() => place(vgNode, pvs));
  }
  m.filesystems.forEach((fs) => {
    const targets = m.mounts.filter((mount) => mount.fs === fs.id).map((mount) => mount.target);
    const label = [fs.type, fs.label ? `"${fs.label}"` : null, targets[0] ?? null]
      .filter(Boolean)
      .join(" ");
    const fsNode = node(`fs:${fs.id}`, "fs", label, fs.sizeBytes);
    for (const subvolume of fs.btrfs?.subvolumes ?? []) {
      fsNode.children.push(
        node(`subvolume:${fs.id}:${subvolume.id}`, "subvolume", subvolume.path, null),
      );
    }
    pending.push(() => place(fsNode, fs.devices));
  });
  m.swap.forEach((swap, index) => {
    if (!swap.device) return;
    const swapNode = node(`swap:${index}`, "swap", swap.path ?? "swap", swap.sizeBytes);
    const device = swap.device;
    pending.push(() => place(swapNode, [device]));
  });

  function place(child: LayoutStackNode, parents: BlockRef[]): boolean {
    for (const parent of parents) {
      const key = refKey(parent);
      if (placed.has(key)) {
        attach(key, child);
        return true;
      }
    }
    return false;
  }
  // A few passes settle chains (partition, md, LUKS, PV, VG, LV, LUKS, file system).
  for (let pass = 0; pass < 8 && pending.length > 0; pass++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i]?.()) pending.splice(i, 1);
    }
  }
  return roots;
}

function partitionContent(
  type: string,
  key: string,
  users: Map<string, PartitionContent>,
): PartitionContent {
  const lowered = type.toLowerCase();
  if (ESP_TYPES.has(lowered)) return "esp";
  if (lowered === BIOS_BOOT_TYPE) return "bios_boot";
  const used = users.get(key);
  if (used) return used;
  return EMPTY_TYPES.has(lowered) ? "empty" : "other";
}

/** The summary of a Linux layout for the machine's page. */
export function summarizeLayout(m: LinuxLayoutManifest): LayoutSummary {
  const users = usersOf(m);
  const fsLabel = new Map<string, string | null>();
  for (const fs of m.filesystems) {
    for (const device of fs.devices) fsLabel.set(refKey(device), fs.label);
  }
  const keymap = m.initramfs.keymap.layout
    ? m.initramfs.keymap.variant
      ? `${m.initramfs.keymap.layout}:${m.initramfs.keymap.variant}`
      : m.initramfs.keymap.layout
    : null;
  return {
    platform: "linux",
    os: {
      prettyName: m.os.prettyName,
      id: m.os.id,
      versionId: m.os.versionId,
      arch: m.os.arch,
      kernel: m.os.kernel,
    },
    firmware: { mode: m.firmware.mode, secureBoot: m.firmware.secureBoot },
    bootloader: {
      kind: m.bootloader.kind,
      platform: m.bootloader.platform,
      shim: m.bootloader.shim,
    },
    initramfs: { generator: m.initramfs.generator, keymap },
    disks: m.disks.map((disk) => ({
      id: disk.id,
      kname: disk.kname,
      model: disk.model,
      sizeBytes: disk.sizeBytes,
      transport: disk.transport,
      logicalSectorSize: disk.logicalSectorSize,
      tableType: disk.table?.type ?? null,
      partitions: [...(disk.table?.partitions ?? [])]
        .sort((a, b) => a.startBytes - b.startBytes)
        .map((partition) => {
          const key = `partition:${disk.id}:${partition.number}`;
          return {
            number: partition.number,
            startBytes: partition.startBytes,
            sizeBytes: partition.sizeBytes,
            content: partitionContent(partition.type, key, users),
            label: partition.name ?? fsLabel.get(key) ?? null,
          };
        }),
    })),
    stack: stackOf(m),
    mounts: m.mounts.map((mount) => ({ target: mount.target, type: mount.type })),
    encryption: {
      luks: m.luks.length,
      plainCrypt: m.plainCrypt.length,
      tokenTypes: [...new Set(m.luks.flatMap((luks) => luks.tokenTypes))].sort(),
    },
    vgs: m.lvm.vgs.map((vg) => ({
      name: vg.name,
      sizeBytes: vg.sizeBytes,
      freeBytes: vg.freeBytes,
    })),
    counts: {
      subvolumes: m.filesystems.reduce((sum, fs) => sum + (fs.btrfs?.subvolumes.length ?? 0), 0),
      lvs: m.lvm.vgs.reduce((sum, vg) => sum + vg.lvs.length, 0),
    },
  };
}
