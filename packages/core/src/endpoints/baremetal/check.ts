/**
 * Stage 1 of the bare metal restore check (docs/BAREMETAL.md 12.1): the pure part. The worker
 * (apps/worker/src/endpoints/baremetal-check.ts) reads the newest whole machine snapshot once
 * (`restic ls`), dumps the few files listed here (`restic dump`), runs the agent's planner three
 * times and hands everything to {@link judgeLayoutCheck}, which rates the snapshot with the checks
 * L1 to L8. Nothing here reaches a repository or starts a process.
 *
 * Red needs proof: a check fails only for what the table of 12.1 names (an invalid or unsupported
 * layout, a planner problem on the same or the minimal hardware, the manifest missing from or
 * differing in the snapshot, a missing source, an fstab entry that resolves to nothing, a missing
 * default kernel, loader, initramfs generator or BIOS boot loader tool, plain dm-crypt on a device
 * name without PARTUUID). Everything else is a warning. A planner that could not answer makes the
 * report yellow (`incomplete`), not red.
 *
 * Evidence holds structured fields only (paths, mount targets, fstab sources, counts, booleans),
 * never raw lines of grub.cfg, loader entries or a kernel command line; every string is free of
 * control characters and at most 300 characters long.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { RunConsistency } from "../consistency.js";
import { noControlChars } from "./canonical.js";
import { type BlockRef, type LinuxLayoutManifest, parseLayoutManifest } from "./manifest.js";
import { LINUX_MANIFEST_PATH } from "./paths.js";
import type { BaremetalPlan, PlanError, RestoreSize } from "./plan.js";
import { restoreSizeTargets } from "./restore-sizes.js";

export const LAYOUT_CHECK_IDS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"] as const;
export type LayoutCheckId = (typeof LAYOUT_CHECK_IDS)[number];

export const CHECK_STATUSES = ["ok", "warning", "failed", "skipped"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** The codes of the stage 1 findings (besides the planner's own codes, which L3 passes on). */
export const CHECK_FINDING_CODES = [
  // L1
  "manifest_invalid",
  // L2
  "verdict_unsupported",
  // L3 (besides the planner's own codes)
  "planner_refused_valid_manifest",
  // L4
  "manifest_missing",
  "manifest_mismatch",
  // L5
  "source_missing",
  "source_empty",
  "fstab_entry_not_covered",
  "subvolume_not_covered",
  "system_mount_excluded",
  "paths_differ",
  // L6
  "fstab_missing",
  "fstab_unresolvable",
  "crypttab_plain_device_name",
  "crypttab_unresolvable",
  "kernel_missing",
  "kernel_size_mismatch",
  "initramfs_missing",
  "loader_missing",
  "generator_missing",
  "bootloader_tool_missing",
  "grub_cfg_missing",
  "bls_kernel_missing",
  "modules_alias_missing",
  "keymap_mismatch",
  "lvm_filter_device_names",
  "device_name_refs",
  // L7
  "consistency_live_root",
  "consistency_missing",
  // L8
  "restore_sizes",
] as const;
export type CheckFindingCode = (typeof CHECK_FINDING_CODES)[number];

/** Why stage 1 could not rate the snapshot completely (the report is yellow, or red for the last). */
export const CHECK_INCOMPLETE_REASONS = [
  "planner_timeout",
  "planner_output_too_large",
  "planner_crashed",
  "planner_unavailable",
  "planner_refused_valid_manifest",
] as const;
export type CheckIncompleteReason = (typeof CHECK_INCOMPLETE_REASONS)[number];

export interface CheckFinding {
  code: string;
  /** `failed` makes its check fail, `warning` gives it a warning, `info` is a hint. */
  severity: "failed" | "warning" | "info";
  ref: string | null;
  params: Record<string, unknown>;
}

export interface LayoutCheck {
  id: LayoutCheckId;
  status: CheckStatus;
  findings: CheckFinding[];
  /** What the check looked at, structured (12.1 "Beleg"). */
  evidence: Record<string, unknown>;
}

/** At most this many findings per check are kept. */
export const MAX_CHECK_FINDINGS = 50;
/** Every string of a report is cut to this length. */
export const MAX_REPORT_STRING = 300;
/** How many files stage 1 dumps at most, and how large each may be. */
export const MAX_STAGE_ONE_DUMPS = 80;
export const MAX_DUMP_BYTES = 1024 * 1024;
export const MAX_MODULES_DUMP_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// fstab and crypttab
// ---------------------------------------------------------------------------

export interface FstabLine {
  source: string;
  target: string;
  type: string;
  options: string;
  /** 1-based line number in the file. */
  line: number;
}

/** fstab's octal escapes (`\040` for a space). */
function unescapeOctal(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

/** The entries of an fstab (fstab(5)): comments and blank lines left out, escapes decoded. */
export function parseFstab(text: string): FstabLine[] {
  const out: FstabLine[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) return;
    const fields = line.split(/\s+/);
    if (fields.length < 2) return;
    out.push({
      source: unescapeOctal(fields[0] as string),
      target: unescapeOctal(fields[1] as string),
      type: fields[2] ?? "auto",
      options: fields[3] ?? "defaults",
      line: index + 1,
    });
  });
  return out;
}

export interface CrypttabLine {
  name: string;
  device: string;
  keyFile: string | null;
  options: string;
  line: number;
}

/** The entries of a crypttab (crypttab(5)). */
export function parseCrypttab(text: string): CrypttabLine[] {
  const out: CrypttabLine[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) return;
    const fields = line.split(/\s+/);
    if (fields.length < 2) return;
    out.push({
      name: fields[0] as string,
      device: fields[1] as string,
      keyFile: fields[2] ?? null,
      options: fields[3] ?? "",
      line: index + 1,
    });
  });
  return out;
}

function optionsOf(options: string): string[] {
  return options.split(",").map((option) => option.trim());
}

function hasOption(options: string, name: string): boolean {
  return optionsOf(options).some((option) => option === name || option.startsWith(`${name}=`));
}

// ---------------------------------------------------------------------------
// Resolving a device against the manifest
// ---------------------------------------------------------------------------

export type FstabResolution = { fs: string } | { swap: number } | { block: BlockRef } | null;

function blockKey(ref: BlockRef): string {
  switch (ref.kind) {
    case "disk":
      return `disk:${ref.disk}`;
    case "partition":
      return `part:${ref.disk}:${ref.number}`;
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

/** The kernel name of a partition (`sda1`, `nvme0n1p2`). */
function partitionKname(diskKname: string, number: number): string {
  return /\d$/.test(diskKname) ? `${diskKname}p${number}` : `${diskKname}${number}`;
}

/** The device-mapper name of an LV (`vg-name` with every `-` doubled). */
function lvDmName(vg: string, lv: string): string {
  return `${vg.replace(/-/g, "--")}-${lv.replace(/-/g, "--")}`;
}

/** udev's escapes in `/dev/disk/by-label` names (`\x20`). */
function unescapeUdev(value: string): string {
  return value.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

const same = (a: string | null | undefined, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

function partitionsOf(m: LinuxLayoutManifest) {
  return m.disks.flatMap((disk) =>
    (disk.table?.partitions ?? []).map((partition) => ({ disk, partition })),
  );
}

/** A block reference for a device path or tag, or null. */
function resolveBlock(m: LinuxLayoutManifest, source: string): BlockRef | null {
  const tag = /^(UUID|LABEL|PARTUUID|PARTLABEL)=(.*)$/.exec(source);
  if (tag) {
    const value = (tag[2] as string).replace(/^"(.*)"$/, "$1");
    switch (tag[1]) {
      case "PARTUUID": {
        const hit = partitionsOf(m).find(({ partition }) => same(partition.uuid, value));
        return hit ? { kind: "partition", disk: hit.disk.id, number: hit.partition.number } : null;
      }
      case "PARTLABEL": {
        const hit = partitionsOf(m).find(({ partition }) => partition.name === value);
        return hit ? { kind: "partition", disk: hit.disk.id, number: hit.partition.number } : null;
      }
      case "UUID": {
        const luks = m.luks.find((volume) => same(volume.uuid, value));
        return luks ? { kind: "luks", id: luks.id } : null;
      }
      default: {
        const luks = m.luks.find((volume) => volume.label === value);
        return luks ? { kind: "luks", id: luks.id } : null;
      }
    }
  }
  const byPath = /^\/dev\/disk\/by-(uuid|label|partuuid|partlabel)\/(.+)$/.exec(source);
  if (byPath) {
    const kind = (byPath[1] as string).toUpperCase();
    return resolveBlock(m, `${kind}=${unescapeUdev(byPath[2] as string)}`);
  }
  const byId = /^\/dev\/disk\/by-id\/(.+?)(?:-part(\d+))?$/.exec(source);
  if (byId) {
    const id = byId[1] as string;
    const number = byId[2] ? Number(byId[2]) : null;
    if (id.startsWith("dm-name-")) return resolveBlock(m, `/dev/mapper/${id.slice(8)}`);
    if (id.startsWith("md-uuid-")) {
      const wanted = id.slice(8).replace(/[:-]/g, "").toLowerCase();
      const md = m.md.find((array) => array.uuid.replace(/[:-]/g, "").toLowerCase() === wanted);
      return md ? { kind: "md", id: md.id } : null;
    }
    const disk = m.disks.find((candidate) => {
      if (id.startsWith("wwn-") && candidate.wwn) {
        return same(candidate.wwn.replace(/^0x/i, ""), id.slice(4).replace(/^0x/i, ""));
      }
      if (id.startsWith("nvme-eui.") && candidate.eui64) {
        return same(candidate.eui64, id.slice(9));
      }
      return (
        candidate.serial !== null && candidate.serial !== "" && id.endsWith(`_${candidate.serial}`)
      );
    });
    if (!disk) return null;
    return number === null
      ? { kind: "disk", disk: disk.id }
      : { kind: "partition", disk: disk.id, number };
  }
  const mapper = /^\/dev\/mapper\/(.+)$/.exec(source);
  if (mapper) {
    const name = mapper[1] as string;
    const luks = m.luks.find(
      (volume) => volume.mappedName === name || volume.crypttabName === name,
    );
    if (luks) return { kind: "luks", id: luks.id };
    const plain = m.plainCrypt.find((volume) => volume.mappedName === name);
    if (plain) return { kind: "plain", id: plain.id };
    for (const vg of m.lvm.vgs) {
      const lv = vg.lvs.find((candidate) => lvDmName(vg.name, candidate.name) === name);
      if (lv) return { kind: "lv", vg: vg.name, lv: lv.name };
    }
    return null;
  }
  const md = /^\/dev\/md(?:\/(.+)|(\d+))$/.exec(source);
  if (md) {
    const wanted = md[1] ?? `md${md[2]}`;
    const array = m.md.find(
      (candidate) =>
        candidate.kname === wanted ||
        candidate.kname === `md${wanted}` ||
        candidate.name === wanted ||
        (candidate.name ?? "").split(":").at(-1) === wanted,
    );
    return array ? { kind: "md", id: array.id } : null;
  }
  const dev = /^\/dev\/(.+)$/.exec(source);
  if (dev) {
    const name = dev[1] as string;
    const vgLv = /^([^/]+)\/([^/]+)$/.exec(name);
    if (vgLv) {
      const vg = m.lvm.vgs.find((candidate) => candidate.name === vgLv[1]);
      const lv = vg?.lvs.find((candidate) => candidate.name === vgLv[2]);
      return vg && lv ? { kind: "lv", vg: vg.name, lv: lv.name } : null;
    }
    for (const disk of m.disks) {
      if (disk.kname === name) return { kind: "disk", disk: disk.id };
      for (const partition of disk.table?.partitions ?? []) {
        if (partitionKname(disk.kname, partition.number) === name) {
          return { kind: "partition", disk: disk.id, number: partition.number };
        }
      }
    }
    const array = m.md.find((candidate) => candidate.kname === name);
    if (array) return { kind: "md", id: array.id };
  }
  return null;
}

/**
 * What an fstab or crypttab source names in the manifest: a file system, a swap area, or (for a
 * block device without either) the device. `UUID=`, `LABEL=`, `PARTUUID=`, `PARTLABEL=`, the
 * `/dev/disk/by-*` links, `/dev/mapper/…`, `/dev/<vg>/<lv>`, md devices and kernel names
 * (through each disk's `kname`). A swap file resolves by its path. Null when nothing matches.
 */
export function resolveFstabSource(m: LinuxLayoutManifest, source: string): FstabResolution {
  const tag = /^(UUID|LABEL)=(.*)$/.exec(source);
  if (tag) {
    const value = (tag[2] as string).replace(/^"(.*)"$/, "$1");
    const isUuid = tag[1] === "UUID";
    const fs = m.filesystems.find((candidate) =>
      isUuid ? same(candidate.uuid, value) : candidate.label === value,
    );
    if (fs) return { fs: fs.id };
    const swap = m.swap.findIndex((candidate) =>
      isUuid ? same(candidate.uuid, value) : candidate.label === value,
    );
    if (swap >= 0) return { swap };
  }
  const byPath = /^\/dev\/disk\/by-(uuid|label)\/(.+)$/.exec(source);
  if (byPath) {
    return resolveFstabSource(
      m,
      `${(byPath[1] as string).toUpperCase()}=${unescapeUdev(byPath[2] as string)}`,
    );
  }
  if (source.startsWith("/") && !source.startsWith("/dev/")) {
    const swap = m.swap.findIndex(
      (candidate) => candidate.kind === "file" && candidate.path === source,
    );
    return swap >= 0 ? { swap } : null;
  }
  const block = resolveBlock(m, source);
  if (!block) return null;
  const key = blockKey(block);
  const fs = m.filesystems.find((candidate) =>
    candidate.devices.some((device) => blockKey(device) === key),
  );
  if (fs) return { fs: fs.id };
  const swap = m.swap.findIndex(
    (candidate) => candidate.device !== null && blockKey(candidate.device) === key,
  );
  if (swap >= 0) return { swap };
  return { block };
}

/** File system types that are no local block device (network, virtual, in memory). */
const NOT_LOCAL_TYPES = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smb3",
  "smbfs",
  "sshfs",
  "glusterfs",
  "ceph",
  "9p",
  "virtiofs",
  "davfs",
  "tmpfs",
  "devtmpfs",
  "ramfs",
  "proc",
  "sysfs",
  "devpts",
  "securityfs",
  "cgroup",
  "cgroup2",
  "debugfs",
  "tracefs",
  "efivarfs",
  "mqueue",
  "hugetlbfs",
  "configfs",
  "bpf",
  "pstore",
  "fusectl",
  "binfmt_misc",
  "autofs",
  "overlay",
  "none",
]);

/** Whether an fstab entry is a local file system or swap (not a bind mount, not on the network). */
export function isLocalFstabEntry(entry: Pick<FstabLine, "source" | "type" | "options">): boolean {
  const type = entry.type.toLowerCase();
  if (NOT_LOCAL_TYPES.has(type) || type.startsWith("fuse") || type.startsWith("nfs")) return false;
  if (hasOption(entry.options, "bind") || hasOption(entry.options, "rbind")) return false;
  if (hasOption(entry.options, "_netdev")) return false;
  // `//server/share`, `server:/export`
  if (entry.source.startsWith("//") || /^[^/=]+:/.test(entry.source)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// What stage 1 reads from the snapshot
// ---------------------------------------------------------------------------

/** Where a binary may lie; merged-/usr systems keep it below /usr and link the old folders. */
const BIN_DIRS = ["/usr/sbin", "/usr/bin", "/sbin", "/bin"];

const GENERATORS: Record<string, string[]> = {
  "initramfs-tools": ["update-initramfs"],
  dracut: ["dracut"],
  mkinitcpio: ["mkinitcpio"],
};

const MODULES_FILES = ["modules.alias", "modules.builtin", "modules.builtin.modinfo"] as const;

/** The configuration files of L6 and the boot chain fingerprint, in dump order. */
const CONFIG_FILES = [
  "/etc/fstab",
  "/etc/crypttab",
  "/etc/mdadm/mdadm.conf",
  "/etc/mdadm.conf",
  "/etc/default/grub",
  "/etc/kernel/cmdline",
  "/etc/lvm/lvm.conf",
  "/etc/lvm/devices/system.devices",
  "/etc/vconsole.conf",
  "/etc/default/keyboard",
] as const;

/** The configuration files whose SHA-256 goes into the boot chain fingerprint (12.4). */
const FINGERPRINT_CONFIGS = [
  "/etc/fstab",
  "/etc/crypttab",
  "/etc/mdadm/mdadm.conf",
  "/etc/mdadm.conf",
  "/etc/default/grub",
  "/etc/kernel/cmdline",
  "/etc/lvm/lvm.conf",
  "/etc/lvm/devices/system.devices",
] as const;

function binCandidates(name: string): string[] {
  return BIN_DIRS.map((dir) => `${dir}/${name}`);
}

function modulesCandidates(version: string, file: string): string[] {
  return [`/lib/modules/${version}/${file}`, `/usr/lib/modules/${version}/${file}`];
}

/** The default kernel and the next one (the fallback the planner checks drivers against). */
export function stageOneKernels(m: LinuxLayoutManifest): LinuxLayoutManifest["kernels"] {
  const defaultKernel = m.kernels.find((kernel) => kernel.default) ?? m.kernels[0];
  if (!defaultKernel) return [];
  const fallback = m.kernels.find((kernel) => kernel !== defaultKernel);
  return fallback ? [defaultKernel, fallback] : [defaultKernel];
}

/** The mount target of a file system: its first mount, else its fstab entry. */
function targetOfFs(m: LinuxLayoutManifest, fsId: string): string | null {
  const mount = m.mounts.find((candidate) => candidate.fs === fsId && !candidate.autofs);
  if (mount) return mount.target;
  const entry = m.fstab.find(
    (candidate) =>
      candidate.resolved !== null && "fs" in candidate.resolved && candidate.resolved.fs === fsId,
  );
  return entry?.target.startsWith("/") ? entry.target : null;
}

/** Mount targets of the ESPs and of the XBOOTLDR partition (`bootloader.esps`, `xbootldr`). */
function bootTargets(m: LinuxLayoutManifest): { esps: string[]; xbootldr: string | null } {
  const esps = m.bootloader.esps
    .map((fs) => targetOfFs(m, fs))
    .filter((target): target is string => target !== null);
  const xbootldr = m.bootloader.xbootldr ? targetOfFs(m, m.bootloader.xbootldr) : null;
  return { esps, xbootldr };
}

/** The targets of every vfat file system (file names compare without case there). */
function vfatTargets(m: LinuxLayoutManifest): string[] {
  return m.filesystems
    .filter((fs) => fs.type === "vfat")
    .map((fs) => targetOfFs(m, fs.id))
    .filter((target): target is string => target !== null);
}

/** The file an active `Boot####` entry starts, as a path in the snapshot, or null. */
function loaderPathOf(
  m: LinuxLayoutManifest,
  entry: LinuxLayoutManifest["firmware"]["entries"][number],
): string | null {
  if (!entry.loader || !entry.partuuid) return null;
  const partition = partitionsOf(m).find(({ partition: p }) =>
    same(p.uuid, entry.partuuid as string),
  );
  if (!partition) return null;
  const key = blockKey({
    kind: "partition",
    disk: partition.disk.id,
    number: partition.partition.number,
  });
  const fs = m.filesystems.find((candidate) => candidate.devices.some((d) => blockKey(d) === key));
  const target = fs ? targetOfFs(m, fs.id) : null;
  if (!target) return null;
  const relative = entry.loader.replace(/\\/g, "/").replace(/^\/+/, "");
  return posix.join(target, relative);
}

export interface StageOneWanted {
  /** Paths whose node (type, size, modification time) the walk records. */
  listPaths: string[];
  /** Folders whose whole subtree the walk records (boot partitions, ESPs), up to a cap. */
  listPrefixes: string[];
  /** Folders whose direct children the walk counts (the backup's sources). */
  countChildren: string[];
  /** Mount targets of vfat file systems: names there compare without case. */
  caseInsensitive: string[];
}

/**
 * What the walk over the snapshot (`restic ls --json <snapshot>`) has to record for stage 1:
 * kernels, initramfs images and loader files, `modules.alias`, `modules.builtin` and
 * `modules.builtin.modinfo` of the default kernel and the next one (below /lib and /usr/lib), the
 * initramfs generator and the boot loader tools in every binary folder, the L6 configuration
 * files, the agent's copy of the manifest, the MOK files and everything below /boot, /efi and the
 * ESPs (BLS and loader entries, GRUB's configuration).
 */
export function stageOneWanted(m: LinuxLayoutManifest): StageOneWanted {
  const list = new Set<string>([LINUX_MANIFEST_PATH, ...CONFIG_FILES]);
  for (const kernel of m.kernels) {
    list.add(kernel.image);
    if (kernel.initramfs) list.add(kernel.initramfs);
  }
  for (const kernel of stageOneKernels(m)) {
    for (const file of MODULES_FILES) {
      for (const path of modulesCandidates(kernel.version, file)) list.add(path);
    }
  }
  for (const loader of m.loaders) list.add(loader.path);
  for (const entry of m.firmware.entries) {
    const path = loaderPathOf(m, entry);
    if (path) list.add(path);
  }
  if (m.bootloader.grubCfg) list.add(m.bootloader.grubCfg);
  for (const names of Object.values(GENERATORS)) {
    for (const name of names) for (const path of binCandidates(name)) list.add(path);
  }
  for (const name of ["kernel-install", "grub-install", "grub2-install", "bootctl"]) {
    for (const path of binCandidates(name)) list.add(path);
  }
  for (const file of m.mokFiles) list.add(file.path);
  if (m.initramfs.keymap.source?.startsWith("/")) list.add(m.initramfs.keymap.source);
  const { esps, xbootldr } = bootTargets(m);
  const prefixes = new Set<string>(["/boot", "/efi", ...esps]);
  if (xbootldr) prefixes.add(xbootldr);
  return {
    listPaths: [...list].map(normalisePath).sort(),
    listPrefixes: [...prefixes].map(normalisePath).sort(),
    countChildren: [...new Set(m.backup.sources.map(normalisePath))].sort(),
    caseInsensitive: [...new Set(vfatTargets(m).map(normalisePath))].sort(),
  };
}

function normalisePath(path: string): string {
  const collapsed = `/${path}`.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

/** A node of the snapshot's tree that stage 1 kept. */
export interface CheckNode {
  type: "file" | "dir" | "symlink" | "other";
  size: number | null;
  mtime: string | null;
}

/** The most nodes below the boot prefixes the walk keeps (a /boot is small; this is a fence). */
export const MAX_PREFIX_NODES = 20_000;

/**
 * Collects, during one walk over the snapshot, what {@link stageOneWanted} asks for. Feed it every
 * node in any order.
 */
export class StageOneCollector {
  readonly nodes = new Map<string, CheckNode>();
  readonly childCounts = new Map<string, number>();
  private readonly wanted: Set<string>;
  private readonly wantedLower = new Map<string, string>();
  private readonly prefixes: string[];
  private readonly caseInsensitive: string[];
  private prefixNodes = 0;
  /** The cap on the boot prefixes was reached: some nodes there were not kept. */
  truncated = false;

  constructor(wanted: StageOneWanted) {
    this.wanted = new Set(wanted.listPaths);
    this.prefixes = wanted.listPrefixes;
    this.caseInsensitive = wanted.caseInsensitive;
    for (const path of wanted.listPaths) {
      if (this.caseInsensitive.some((target) => isUnder(path, target))) {
        this.wantedLower.set(path.toLowerCase(), path);
      }
    }
    for (const dir of wanted.countChildren) this.childCounts.set(dir, 0);
  }

  add(path: string, node: CheckNode): void {
    const parent = posix.dirname(path);
    if (path !== "/" && this.childCounts.has(parent)) {
      this.childCounts.set(parent, (this.childCounts.get(parent) as number) + 1);
    }
    if (this.wanted.has(path) || this.childCounts.has(path)) {
      this.nodes.set(path, node);
      return;
    }
    const lower = this.wantedLower.get(path.toLowerCase());
    if (lower && this.caseInsensitive.some((target) => isUnder(path, target))) {
      this.nodes.set(lower, node);
      return;
    }
    if (this.prefixes.some((prefix) => isUnder(path, prefix))) {
      if (this.prefixNodes >= MAX_PREFIX_NODES) {
        this.truncated = true;
        return;
      }
      this.prefixNodes += 1;
      this.nodes.set(path, node);
    }
  }
}

function isUnder(path: string, dir: string): boolean {
  return dir === "/" || path === dir || path.startsWith(`${dir}/`);
}

/** Loader entries (BLS, systemd-boot) among the kept nodes. */
function loaderEntryFiles(nodes: ReadonlyMap<string, CheckNode>): string[] {
  return [...nodes.entries()]
    .filter(([path, node]) => node.type === "file" && /\/loader\/entries\/[^/]+\.conf$/i.test(path))
    .map(([path]) => path)
    .sort();
}

export interface StageOneDump {
  path: string;
  maxBytes: number;
}

/**
 * The files to dump after the walk, in order, at most {@link MAX_STAGE_ONE_DUMPS}: only those the
 * walk found as files. The agent's copy of the manifest (L4) is read separately.
 */
export function stageOneDumps(
  m: LinuxLayoutManifest,
  nodes: ReadonlyMap<string, CheckNode>,
): StageOneDump[] {
  const out: StageOneDump[] = [];
  const seen = new Set<string>();
  const add = (path: string, maxBytes = MAX_DUMP_BYTES) => {
    const node = nodes.get(path);
    if (node?.type !== "file" || seen.has(path) || out.length >= MAX_STAGE_ONE_DUMPS) {
      return;
    }
    seen.add(path);
    out.push({ path, maxBytes });
  };
  for (const path of CONFIG_FILES) add(path);
  if (m.initramfs.keymap.source?.startsWith("/")) add(normalisePath(m.initramfs.keymap.source));
  for (const kernel of stageOneKernels(m)) {
    for (const file of MODULES_FILES) {
      for (const path of modulesCandidates(kernel.version, file)) add(path, MAX_MODULES_DUMP_BYTES);
    }
  }
  for (const file of m.mokFiles) add(normalisePath(file.path));
  for (const path of loaderEntryFiles(nodes)) add(path);
  return out;
}

/** A dumped file: its text (UTF-8, as far as read), whether the cap cut it, its SHA-256. */
export interface DumpedFile {
  bytes: Buffer;
  truncated: boolean;
}

function textOf(file: DumpedFile | undefined): string | null {
  return file ? file.bytes.toString("utf8") : null;
}

function sha256Of(file: DumpedFile | undefined): string | null {
  return file && !file.truncated ? createHash("sha256").update(file.bytes).digest("hex") : null;
}

/** The DER bytes of a certificate file (PEM is decoded), for the MOK fact's SHA-256. */
function derOf(bytes: Buffer): Buffer {
  const text = bytes.toString("latin1");
  const pem = /-----BEGIN [A-Z ]+-----([\s\S]*?)-----END [A-Z ]+-----/.exec(text);
  return pem ? Buffer.from((pem[1] as string).replace(/\s+/g, ""), "base64") : bytes;
}

/** The first existing of a set of candidate paths. */
function firstPresent(
  nodes: ReadonlyMap<string, CheckNode>,
  candidates: readonly string[],
): string | null {
  return candidates.find((candidate) => nodes.has(candidate)) ?? null;
}

/**
 * The facts for the planner (`restow-plan-facts-v1`, C-M2-2): the module lists of the default
 * kernel and the next one, the restore sizes and the MOK files, from what stage 1 read.
 */
export function planFactsOf(
  m: LinuxLayoutManifest,
  nodes: ReadonlyMap<string, CheckNode>,
  files: ReadonlyMap<string, DumpedFile>,
  restoreSizes: Record<string, RestoreSize>,
): Record<string, unknown> {
  const kernels = stageOneKernels(m).map((kernel, index) => {
    const read = (file: (typeof MODULES_FILES)[number]) => {
      const path = firstPresent(nodes, modulesCandidates(kernel.version, file));
      const dumped = path ? files.get(path) : undefined;
      if (!dumped || dumped.truncated) return "";
      return dumped.bytes.toString("utf8").replace(/\0/g, "\n");
    };
    return {
      version: kernel.version,
      default: index === 0,
      modulesAlias: read("modules.alias"),
      modulesBuiltin: read("modules.builtin"),
      modulesBuiltinModinfo: read("modules.builtin.modinfo"),
    };
  });
  const mokFiles = m.mokFiles.map((file) => {
    const path = normalisePath(file.path);
    const dumped = files.get(path);
    return {
      path: file.path,
      present: nodes.get(path)?.type === "file",
      sha256:
        dumped && !dumped.truncated
          ? createHash("sha256").update(derOf(dumped.bytes)).digest("hex")
          : null,
    };
  });
  return { format: "restow-plan-facts-v1", kernels, restoreSizes, mokFiles };
}

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

export type PlannerOutcome =
  | { kind: "plan"; plan: BaremetalPlan }
  | { kind: "refused"; error: PlanError["error"] }
  | {
      kind: "incomplete";
      reason: Exclude<CheckIncompleteReason, "planner_refused_valid_manifest">;
    };

export interface PlannerRuns {
  same: PlannerOutcome;
  minimal: PlannerOutcome;
  otherController: PlannerOutcome;
}

export interface LayoutCheckInput {
  /** The stored manifest (`endpoint_layouts.manifest`). */
  manifest: unknown;
  /** `endpoint_layouts.sha256`. */
  layoutSha256: string;
  /** The agent's copy of the manifest in the snapshot: its SHA-256, or proven missing. */
  manifestInSnapshot: { state: "found"; sha256: string; bytes: number } | { state: "missing" };
  /** The snapshot's `paths`. */
  snapshotPaths: readonly string[];
  nodes: ReadonlyMap<string, CheckNode>;
  childCounts: ReadonlyMap<string, number>;
  files: ReadonlyMap<string, DumpedFile>;
  /** `consistency` of the run that recorded the layout. */
  consistency: RunConsistency | null;
  restoreSizes: Record<string, RestoreSize>;
  /** The three planner runs; null when the manifest was invalid and no planner ran. */
  planner: PlannerRuns | null;
}

export interface LayoutCheckResult {
  readiness: "green" | "yellow" | "red";
  checks: LayoutCheck[];
  incomplete: CheckIncompleteReason | null;
}

/** A string cut to the report's limit, with control characters replaced. */
export function reportString(value: string): string {
  const clean = noControlChars(value)
    ? value
    : [...value].map((c) => (noControlChars(c) ? c : "?")).join("");
  return clean.length > MAX_REPORT_STRING ? clean.slice(0, MAX_REPORT_STRING) : clean;
}

/** A value made safe for a report: strings cut, lists and depth bounded. */
export function reportValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return reportString(value);
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => reportValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[reportString(key)] = reportValue(item, depth + 1);
    }
    return out;
  }
  return null;
}

class CheckBuilder {
  readonly findings: CheckFinding[] = [];
  evidence: Record<string, unknown> = {};
  skipped = false;

  constructor(readonly id: LayoutCheckId) {}

  add(
    code: string,
    severity: CheckFinding["severity"],
    ref: string | null,
    params: Record<string, unknown> = {},
  ): void {
    this.findings.push({
      code,
      severity,
      ref: ref === null ? null : reportString(ref),
      params: reportValue(params) as Record<string, unknown>,
    });
  }

  build(): LayoutCheck {
    // Failures first, so the cap never drops the proof.
    const order = { failed: 0, warning: 1, info: 2 } as const;
    const findings = [...this.findings]
      .sort((a, b) => order[a.severity] - order[b.severity])
      .slice(0, MAX_CHECK_FINDINGS);
    const status: CheckStatus = this.skipped
      ? "skipped"
      : findings.some((finding) => finding.severity === "failed")
        ? "failed"
        : findings.some((finding) => finding.severity === "warning")
          ? "warning"
          : "ok";
    return {
      id: this.id,
      status,
      findings,
      evidence: reportValue(this.evidence) as Record<string, unknown>,
    };
  }
}

/** Mount targets of the system file systems (`/`, `/boot`, the ESPs, `/usr`, `/var`). */
function systemTargets(m: LinuxLayoutManifest): string[] {
  const targets = new Set(["/", "/boot", "/usr", "/var"]);
  for (const target of bootTargets(m).esps) targets.add(normalisePath(target));
  return [...targets];
}

/** A restic exclude pattern as a matcher over path components (`*`, `?`, `[…]`, `**`). */
function excludeMatcher(pattern: string): (path: string) => boolean {
  const anchored = pattern.startsWith("/");
  const parts = (anchored ? pattern.slice(1) : `**/${pattern}`).split("/").filter(Boolean);
  const component = (glob: string) =>
    new RegExp(
      `^${glob
        .replace(/[.+^${}()|\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")}$`,
    );
  const compiled = parts.map((part) => (part === "**" ? null : component(part)));
  const matchFrom = (segments: string[], pi: number, si: number): boolean => {
    if (pi === compiled.length) return true; // the pattern matched a prefix: the rest is below it
    if (si > segments.length) return false;
    const part = compiled[pi];
    if (part === null) {
      for (let next = si; next <= segments.length; next++) {
        if (matchFrom(segments, pi + 1, next)) return true;
      }
      return false;
    }
    if (si === segments.length) return false;
    return part.test(segments[si] as string) && matchFrom(segments, pi + 1, si + 1);
  };
  return (path) => matchFrom(path.split("/").filter(Boolean), 0, 0);
}

/** Whether a path, or a folder above it, is excluded by one of the patterns. */
function isExcluded(patterns: readonly ((path: string) => boolean)[], path: string): boolean {
  return patterns.some((matches) => matches(path));
}

/** Whether a source covers a path (the path is the source; restic runs with -x, so not below). */
function isSource(sources: ReadonlySet<string>, path: string): boolean {
  return sources.has(normalisePath(path));
}

/** Where every btrfs subvolume below a mounted one lies (as the agent lists its sources). */
function subvolumeLocations(m: LinuxLayoutManifest): string[] {
  const out = new Set<string>();
  const fsById = new Map(m.filesystems.map((fs) => [fs.id, fs]));
  for (const mount of m.mounts) {
    if (!mount.fs || mount.subvol === null) continue;
    const fs = fsById.get(mount.fs);
    if (!fs?.btrfs) continue;
    const root = mount.subvol.replace(/^\/+|\/+$/g, "");
    for (const subvolume of fs.btrfs.subvolumes) {
      if (["snapper", "timeshift", "restow"].includes(subvolume.kind) || subvolume.readOnly)
        continue;
      const rest =
        root === ""
          ? subvolume.path
          : subvolume.path.startsWith(`${root}/`)
            ? subvolume.path.slice(root.length + 1)
            : null;
      if (!rest) continue;
      // Below a snapshot (`.snapshots/1/snapshot/…`): not a subvolume of the running system.
      if (/(^|\/)\.snapshots(\/|$)/.test(rest)) continue;
      out.add(normalisePath(posix.join(mount.target, rest)));
    }
  }
  return [...out].sort();
}

function checkL5(m: LinuxLayoutManifest, input: LayoutCheckInput, check: CheckBuilder): void {
  const sources = new Set(m.backup.sources.map(normalisePath));
  const excludes = m.backup.excludes.map(excludeMatcher);
  const system = new Set(systemTargets(m));
  const missing: string[] = [];
  for (const source of sources) {
    const node = input.nodes.get(source);
    const children = input.childCounts.get(source) ?? 0;
    const present = node !== undefined || children > 0 || source === "/";
    if (!present) {
      missing.push(source);
      check.add("source_missing", "failed", source, { source });
      continue;
    }
    if ((node === undefined || node.type === "dir") && children === 0) {
      check.add("source_empty", system.has(source) ? "failed" : "warning", source, {
        source,
        system: system.has(source),
      });
    }
  }
  const snapshotPaths = new Set(input.snapshotPaths.map(normalisePath));
  const notInPaths = [...sources].filter((source) => !snapshotPaths.has(source));
  if (notInPaths.length > 0 && missing.length < sources.size) {
    check.add("paths_differ", "warning", null, {
      count: notInPaths.length,
      sources: notInPaths.slice(0, 10),
    });
  }
  for (const entry of m.fstab) {
    if (entry.type === "swap" || !entry.target.startsWith("/")) continue;
    if (!isLocalFstabEntry(entry) || entry.resolved === null || !("fs" in entry.resolved)) continue;
    const target = normalisePath(entry.target);
    if (!isSource(sources, target) && !isExcluded(excludes, target)) {
      check.add("fstab_entry_not_covered", "warning", target, {
        target,
        noauto: entry.noauto,
        automount: entry.automount,
      });
    }
  }
  for (const location of subvolumeLocations(m)) {
    if (!isSource(sources, location) && !isExcluded(excludes, location)) {
      check.add("subvolume_not_covered", "warning", location, { path: location });
    }
  }
  for (const target of system) {
    const isMounted = m.mounts.some((mount) => normalisePath(mount.target) === target);
    if (isMounted && isExcluded(excludes, target)) {
      check.add("system_mount_excluded", "warning", target, { target });
    }
  }
  check.evidence = {
    sources: [...sources].slice(0, 50).map((source) => ({
      source,
      present: input.nodes.has(source) || (input.childCounts.get(source) ?? 0) > 0,
      entries: input.childCounts.get(source) ?? 0,
    })),
    excludes: m.backup.excludes.length,
  };
}

/** `KEY=value` lines of a shell-style file, quotes removed. */
function shellVars(text: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of (text ?? "").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!match) continue;
    out.set(match[1] as string, (match[2] as string).trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  return out;
}

/** The kernel and initramfs paths of a BLS or loader entry (`linux`, `initrd`, `efi`). */
function loaderEntryPaths(text: string): { kind: string; path: string }[] {
  const out: { kind: string; path: string }[] = [];
  for (const raw of text.split("\n")) {
    const match = /^\s*(linux|initrd|efi)\s+(\S+)/.exec(raw);
    if (match) out.push({ kind: match[1] as string, path: match[2] as string });
  }
  return out;
}

function lookupNode(
  input: LayoutCheckInput,
  lower: Map<string, CheckNode>,
  caseInsensitive: readonly string[],
  path: string,
): CheckNode | undefined {
  const normalised = normalisePath(path);
  const exact = input.nodes.get(normalised);
  if (exact) return exact;
  if (caseInsensitive.some((target) => isUnder(normalised, target))) {
    return lower.get(normalised.toLowerCase());
  }
  return undefined;
}

function checkL6(m: LinuxLayoutManifest, input: LayoutCheckInput, check: CheckBuilder): void {
  const caseInsensitive = vfatTargets(m).map(normalisePath);
  const lower = new Map<string, CheckNode>();
  for (const [path, node] of input.nodes) {
    if (caseInsensitive.some((target) => isUnder(path, target)))
      lower.set(path.toLowerCase(), node);
  }
  const find = (path: string) => lookupNode(input, lower, caseInsensitive, path);
  const evidence: Record<string, unknown> = {};

  // fstab: every entry without noauto/nofail resolves against the manifest.
  const fstab = textOf(input.files.get("/etc/fstab"));
  const fstabEntries = fstab === null ? [] : parseFstab(fstab);
  if (fstab === null && m.fstab.some((entry) => entry.origin === "fstab")) {
    check.add("fstab_missing", "failed", "/etc/fstab", { path: "/etc/fstab" });
  }
  let unresolved = 0;
  for (const entry of fstabEntries) {
    if (!isLocalFstabEntry(entry)) continue;
    const optional = hasOption(entry.options, "noauto") || hasOption(entry.options, "nofail");
    if (resolveFstabSource(m, entry.source) !== null) continue;
    unresolved += 1;
    check.add("fstab_unresolvable", optional ? "warning" : "failed", entry.target, {
      source: entry.source,
      target: entry.target,
      type: entry.type,
      optional,
    });
  }
  evidence.fstab = { present: fstab !== null, entries: fstabEntries.length, unresolved };

  // crypttab: plain entries must name their device by PARTUUID (or something stable).
  const crypttab = textOf(input.files.get("/etc/crypttab"));
  const crypttabEntries = crypttab === null ? [] : parseCrypttab(crypttab);
  for (const entry of crypttabEntries) {
    const block = resolveBlock(m, entry.device);
    const luks = block?.kind === "luks" || hasOption(entry.options, "luks");
    const plainByManifest = m.plainCrypt.some(
      (volume) => volume.crypttabName === entry.name || volume.mappedName === entry.name,
    );
    const plain =
      !luks &&
      (plainByManifest ||
        hasOption(entry.options, "plain") ||
        hasOption(entry.options, "swap") ||
        hasOption(entry.options, "tmp"));
    const optional = hasOption(entry.options, "noauto") || hasOption(entry.options, "nofail");
    if (block === null) {
      check.add("crypttab_unresolvable", "warning", entry.name, {
        name: entry.name,
        device: entry.device,
        optional,
      });
    }
    if (!plain) continue;
    const isKernelName = /^\/dev\/(?!disk\/|mapper\/)/.test(entry.device);
    if (!isKernelName) continue;
    const partition =
      block?.kind === "partition"
        ? m.disks
            .find((disk) => disk.id === block.disk)
            ?.table?.partitions.find((p) => p.number === block.number)
        : undefined;
    const hasPartuuid = partition?.uuid !== null && partition?.uuid !== undefined;
    check.add("crypttab_plain_device_name", hasPartuuid ? "warning" : "failed", entry.name, {
      name: entry.name,
      device: entry.device,
      partuuid: hasPartuuid,
    });
  }
  evidence.crypttab = { present: crypttab !== null, entries: crypttabEntries.length };

  // md, LVM: the configuration the restored system boots with.
  evidence.mdadm = {
    arrays: m.md.length,
    present: input.files.has("/etc/mdadm/mdadm.conf") || input.files.has("/etc/mdadm.conf"),
  };
  evidence.lvm = {
    lvmConf: input.files.has("/etc/lvm/lvm.conf"),
    devicesFile: m.lvm.useDevicesFile,
    systemDevices: input.files.has("/etc/lvm/devices/system.devices"),
  };
  if (m.lvm.filterHasDeviceNames) {
    check.add("lvm_filter_device_names", "warning", "/etc/lvm/lvm.conf", {
      path: "/etc/lvm/lvm.conf",
    });
  }

  // Kernels and initramfs images, with the sizes the manifest recorded.
  const defaultKernel = m.kernels.find((kernel) => kernel.default) ?? m.kernels[0] ?? null;
  const kernels: Record<string, unknown>[] = [];
  for (const kernel of m.kernels) {
    const isDefault = kernel === defaultKernel;
    const image = find(kernel.image);
    if (!image) {
      check.add("kernel_missing", isDefault ? "failed" : "warning", kernel.version, {
        version: kernel.version,
        path: kernel.image,
        default: isDefault,
      });
    } else if (image.size !== null && image.size !== kernel.imageBytes) {
      check.add("kernel_size_mismatch", "warning", kernel.version, {
        version: kernel.version,
        path: kernel.image,
        expected: kernel.imageBytes,
        actual: image.size,
      });
    }
    let initramfs: CheckNode | undefined;
    if (kernel.initramfs) {
      initramfs = find(kernel.initramfs);
      if (!initramfs) {
        check.add("initramfs_missing", "warning", kernel.version, {
          version: kernel.version,
          path: kernel.initramfs,
        });
      } else if (
        kernel.initramfsBytes !== null &&
        initramfs.size !== null &&
        initramfs.size !== kernel.initramfsBytes
      ) {
        check.add("kernel_size_mismatch", "warning", kernel.version, {
          version: kernel.version,
          path: kernel.initramfs,
          expected: kernel.initramfsBytes,
          actual: initramfs.size,
        });
      }
    }
    kernels.push({
      version: kernel.version,
      default: isDefault,
      image: kernel.image,
      found: image !== undefined,
      initramfs: kernel.initramfs,
      initramfsFound: kernel.initramfs ? initramfs !== undefined : null,
    });
  }
  evidence.kernels = kernels;

  // The loader file of every active boot entry on the ESP.
  if (m.firmware.mode === "uefi") {
    const loaders: Record<string, unknown>[] = [];
    for (const entry of m.firmware.entries) {
      if (!entry.active) continue;
      const path = loaderPathOf(m, entry);
      if (!path) continue;
      const found = find(path) !== undefined;
      if (!found) {
        check.add(
          "loader_missing",
          "failed",
          `Boot${entry.num.toString(16).toUpperCase().padStart(4, "0")}`,
          {
            entry: entry.num,
            path,
          },
        );
      }
      loaders.push({ entry: entry.num, path, found });
    }
    evidence.bootEntries = loaders;
  }

  // GRUB configuration, BLS and loader entries.
  if (m.bootloader.kind === "grub" && m.bootloader.grubCfg && !m.bootloader.bls) {
    const present = find(m.bootloader.grubCfg) !== undefined;
    if (!present) {
      check.add("grub_cfg_missing", "warning", m.bootloader.grubCfg, {
        path: m.bootloader.grubCfg,
      });
    }
    evidence.grubCfg = { path: m.bootloader.grubCfg, present };
  }
  const entryFiles = loaderEntryFiles(input.nodes);
  const blsEntries: Record<string, unknown>[] = [];
  for (const path of entryFiles) {
    const content = textOf(input.files.get(path));
    if (content === null) {
      blsEntries.push({ path, read: false });
      continue;
    }
    // Paths in an entry are relative to the file system the entries lie on.
    const root = path.replace(/\/loader\/entries\/[^/]+$/i, "") || "/";
    const missing: string[] = [];
    for (const reference of loaderEntryPaths(content)) {
      const candidates = [posix.join(root, reference.path), normalisePath(reference.path)];
      if (!candidates.some((candidate) => find(candidate) !== undefined)) {
        missing.push(reference.path);
      }
    }
    for (const reference of missing) {
      check.add("bls_kernel_missing", "warning", path, { entry: path, path: reference });
    }
    blsEntries.push({ path, read: true, missing: missing.length });
  }
  if (entryFiles.length > 0) evidence.loaderEntries = blsEntries;

  // The default kernel's module lists (what the planner checks drivers against).
  if (defaultKernel) {
    const alias = firstPresent(
      input.nodes,
      modulesCandidates(defaultKernel.version, "modules.alias"),
    );
    const builtin = firstPresent(
      input.nodes,
      modulesCandidates(defaultKernel.version, "modules.builtin"),
    );
    if (!alias || !builtin) {
      check.add("modules_alias_missing", "warning", defaultKernel.version, {
        version: defaultKernel.version,
        alias: alias !== null,
        builtin: builtin !== null,
      });
    }
    evidence.modules = {
      version: defaultKernel.version,
      alias: alias !== null,
      builtin: builtin !== null,
    };
  }

  // The initramfs generator and the boot loader tools.
  const generator = m.initramfs.generator;
  const tools: string[] = [];
  if (generator && GENERATORS[generator]) tools.push(...(GENERATORS[generator] as string[]));
  const uki = m.kernels.some((kernel) => kernel.uki) || m.initramfs.ukiPresets;
  if (uki && generator !== "mkinitcpio") tools.push("kernel-install");
  const generatorEvidence: Record<string, unknown>[] = [];
  for (const tool of tools) {
    const path = firstPresent(input.nodes, binCandidates(tool));
    if (!path) {
      check.add("generator_missing", "failed", tool, { tool, generator });
    }
    generatorEvidence.push({ tool, path });
  }
  if (tools.length > 0) evidence.generator = generatorEvidence;
  const bootTools =
    m.bootloader.kind === "grub"
      ? ["grub-install", "grub2-install"]
      : m.bootloader.kind === "systemd-boot"
        ? ["bootctl"]
        : [];
  if (bootTools.length > 0) {
    const path =
      bootTools.map((tool) => firstPresent(input.nodes, binCandidates(tool))).find(Boolean) ?? null;
    if (!path) {
      const bios = m.firmware.mode === "bios";
      check.add("bootloader_tool_missing", bios ? "failed" : "warning", bootTools[0] as string, {
        tools: bootTools,
        bios,
      });
    }
    evidence.bootloaderTool = { tools: bootTools, path };
  }

  // The keyboard layout the initramfs asks for the passphrase with.
  const keymap = m.initramfs.keymap;
  if (keymap.layout && keymap.source?.startsWith("/")) {
    const vars = shellVars(textOf(input.files.get(normalisePath(keymap.source))));
    const key = keymap.source.endsWith("vconsole.conf") ? "KEYMAP" : "XKBLAYOUT";
    const actual = vars.get(key) ?? null;
    if (actual !== null && actual !== keymap.layout) {
      check.add("keymap_mismatch", "warning", keymap.source, {
        path: keymap.source,
        expected: keymap.layout,
        actual,
      });
    }
    evidence.keymap = { source: keymap.source, layout: keymap.layout, inSnapshot: actual };
  }

  // Device names in configuration files, which the restore rewrites (10.13).
  if (m.deviceNameRefs.length > 0) {
    check.add("device_name_refs", "info", null, {
      count: m.deviceNameRefs.length,
      paths: [...new Set(m.deviceNameRefs.map((ref) => ref.path))].slice(0, 10),
    });
  }
  check.evidence = evidence;
}

function plannerIncomplete(outcome: PlannerOutcome): CheckIncompleteReason | null {
  if (outcome.kind === "incomplete") return outcome.reason;
  if (outcome.kind === "refused") {
    return outcome.error.code === "manifest_invalid" ||
      outcome.error.code === "platform_unsupported"
      ? "planner_refused_valid_manifest"
      : "planner_crashed";
  }
  return null;
}

function checkL3(runs: PlannerRuns | null, check: CheckBuilder): CheckIncompleteReason | null {
  if (!runs) {
    check.skipped = true;
    return null;
  }
  let incomplete: CheckIncompleteReason | null = null;
  const evidence: Record<string, unknown> = {};
  const entries: [keyof PlannerRuns, string][] = [
    ["same", "same"],
    ["minimal", "minimal"],
    ["otherController", "other-controller"],
  ];
  let ran = 0;
  for (const [key, target] of entries) {
    const outcome = runs[key];
    const reason = plannerIncomplete(outcome);
    if (reason) {
      // A refused valid manifest is the planner's verdict on this layout; anything else proves nothing.
      if (reason === "planner_refused_valid_manifest") {
        check.add(reason, "failed", target, {
          target,
          code: outcome.kind === "refused" ? outcome.error.code : null,
        });
        incomplete = reason;
      } else if (incomplete === null) {
        incomplete = reason;
      }
      evidence[target] = { ran: false, reason };
      continue;
    }
    if (outcome.kind !== "plan") continue;
    ran += 1;
    const plan = outcome.plan;
    // Only the same and the minimal hardware are known; on another controller a problem is a hint.
    const decisive = key !== "otherController";
    for (const problem of plan.problems) {
      check.add(problem.code, decisive ? "failed" : "warning", problem.ref, {
        target,
        ...problem.params,
      });
    }
    for (const warning of plan.warnings) {
      check.add(warning.code, "warning", warning.ref, { target, ...warning.params });
    }
    evidence[target] = {
      ran: true,
      ok: plan.ok,
      problems: plan.problems.length,
      warnings: plan.warnings.length,
      steps: plan.steps.length,
    };
  }
  if (ran === 0 && !check.findings.some((finding) => finding.severity === "failed")) {
    check.skipped = true;
  }
  check.evidence = evidence;
  return incomplete;
}

function checkL7(
  m: LinuxLayoutManifest,
  consistency: RunConsistency | null,
  check: CheckBuilder,
): void {
  if (!consistency) {
    check.add("consistency_missing", "warning", null, {});
    return;
  }
  const live = consistency.liveFilesystems ?? [];
  if (
    live.includes("/") ||
    (consistency.state === "unavailable" && m.mounts.some((mount) => mount.target === "/"))
  ) {
    check.add("consistency_live_root", "warning", "/", {
      state: consistency.state,
      method: consistency.method ?? null,
    });
  }
  check.evidence = {
    state: consistency.state,
    method: consistency.method ?? null,
    liveFilesystems: live.slice(0, 32),
  };
}

/**
 * Rate a whole machine snapshot by the checks L1 to L8 (12.1). Red when a check failed (with its
 * proof in the findings); yellow when the planner could not answer and nothing failed; green
 * otherwise. A manifest that does not parse fails L1, and the checks that need it are skipped.
 */
export function judgeLayoutCheck(input: LayoutCheckInput): LayoutCheckResult {
  const builders = Object.fromEntries(
    LAYOUT_CHECK_IDS.map((id) => [id, new CheckBuilder(id)]),
  ) as Record<LayoutCheckId, CheckBuilder>;
  const parsed = parseLayoutManifest(input.manifest);
  let incomplete: CheckIncompleteReason | null = null;

  // L4 needs no parsed manifest: the agent's copy in the snapshot is the same bytes or not.
  const l4 = builders.L4;
  if (input.manifestInSnapshot.state === "missing") {
    l4.add("manifest_missing", "failed", LINUX_MANIFEST_PATH, { path: LINUX_MANIFEST_PATH });
    l4.evidence = { path: LINUX_MANIFEST_PATH, present: false, expected: input.layoutSha256 };
  } else {
    const actual = input.manifestInSnapshot.sha256;
    if (actual !== input.layoutSha256) {
      l4.add("manifest_mismatch", "failed", LINUX_MANIFEST_PATH, {
        expected: input.layoutSha256,
        actual,
      });
    }
    l4.evidence = {
      path: LINUX_MANIFEST_PATH,
      present: true,
      bytes: input.manifestInSnapshot.bytes,
      expected: input.layoutSha256,
      actual,
    };
  }

  if (!parsed.ok || parsed.manifest.platform !== "linux") {
    builders.L1.add("manifest_invalid", "failed", null, {
      reason: parsed.ok ? "not a Linux manifest" : parsed.reason,
    });
    for (const id of ["L2", "L3", "L5", "L6", "L7", "L8"] as const) builders[id].skipped = true;
  } else {
    const m = parsed.manifest;
    builders.L1.evidence = {
      format: m.format,
      schemaVersion: m.schemaVersion,
      sha256: parsed.sha256,
    };

    const l2 = builders.L2;
    if (m.verdict === "unsupported") {
      l2.add("verdict_unsupported", "failed", null, {
        codes: m.unsupported
          .filter((item) => item.severity === "unsupported")
          .map((item) => item.code),
      });
    }
    l2.evidence = {
      verdict: m.verdict,
      unsupported: m.unsupported.filter((item) => item.severity === "unsupported").length,
      warnings: m.unsupported.filter((item) => item.severity === "warning").length,
    };

    incomplete = checkL3(input.planner, builders.L3);
    checkL5(m, input, builders.L5);
    checkL6(m, input, builders.L6);
    checkL7(m, input.consistency, builders.L7);

    const targets = restoreSizeTargets(m);
    const total = Object.values(input.restoreSizes).reduce((sum, size) => sum + size.bytes, 0);
    builders.L8.add("restore_sizes", "info", null, { mounts: targets.length, bytes: total });
    builders.L8.evidence = { mounts: targets };
  }

  const checks = LAYOUT_CHECK_IDS.map((id) => builders[id].build());
  const failed = checks.some((check) => check.status === "failed");
  return {
    readiness: failed ? "red" : incomplete ? "yellow" : "green",
    checks,
    incomplete,
  };
}

/**
 * The input of the boot chain fingerprint (12.4) from what stage 1 found: kernels, initramfs
 * images, the loader files of the manifest with their Authenticode hash and SBAT, GRUB's
 * configuration and the loader entries, and the hashes of the configuration files.
 */
export function bootChainInputOf(
  m: LinuxLayoutManifest,
  nodes: ReadonlyMap<string, CheckNode>,
  files: ReadonlyMap<string, DumpedFile>,
): {
  files: {
    path: string;
    size: number;
    mtime: string;
    authenticodeSha256?: string;
    sbat?: string[];
  }[];
  configs: { path: string; sha256: string | null }[];
} {
  const out: {
    path: string;
    size: number;
    mtime: string;
    authenticodeSha256?: string;
    sbat?: string[];
  }[] = [];
  const seen = new Set<string>();
  const add = (path: string, extra: { authenticodeSha256?: string; sbat?: string[] } = {}) => {
    const normalised = normalisePath(path);
    const node = nodes.get(normalised);
    if (!node || seen.has(normalised)) return;
    seen.add(normalised);
    out.push({ path: normalised, size: node.size ?? 0, mtime: node.mtime ?? "", ...extra });
  };
  for (const kernel of m.kernels) {
    add(kernel.image);
    if (kernel.initramfs) add(kernel.initramfs);
  }
  for (const loader of m.loaders) {
    add(loader.path, { authenticodeSha256: loader.authenticodeSha256, sbat: loader.sbat });
  }
  if (m.bootloader.grubCfg) add(m.bootloader.grubCfg);
  for (const path of loaderEntryFiles(nodes)) add(path);
  const configs = FINGERPRINT_CONFIGS.map((path) => ({
    path,
    sha256: nodes.has(path) ? sha256Of(files.get(path)) : null,
  }));
  return { files: out, configs };
}
