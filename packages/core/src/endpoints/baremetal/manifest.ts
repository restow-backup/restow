/**
 * The layout manifest of a whole machine backup (`restow-layout-v1`, docs/BAREMETAL.md 4): what
 * the agent records about a machine's disks, storage stack, file systems, firmware and boot chain
 * before it backs the machine up. It lies in the snapshot (`/var/lib/restow-agent/baremetal/
 * layout.json`) and the agent sends it with the finish of the run; the server checks it here,
 * stores it (`endpoint_layouts`) and shows a summary on the machine's page.
 *
 * The manifest is flat and discriminated by `platform`. The schema is forward compatible: a key
 * this release does not know passes and is kept as received, but each platform refuses the
 * reserved top-level keys of the other (a manifest cannot be both). Every field this release knows
 * is checked: the required ones present (nullable ones as `null`, lists as `[]`), enums, id
 * patterns, that every block reference resolves and the references form no cycle, and the limits.
 * Every string is free of control characters (canonical.ts), every number an integer.
 *
 * The Go side (agent/internal/baremetal/manifest.go) implements the same rules; both read the same
 * test data (agent/internal/baremetal/testdata/manifests).
 */
import { z } from "zod";
import {
  CanonicalEncodingError,
  canonicalLayoutJson,
  canonicalSha256,
  noControlChars,
} from "./canonical.js";

export const LAYOUT_FORMAT = "restow-layout-v1";
export const LAYOUT_SCHEMA_VERSION = 1;
/** The largest canonical encoding a manifest may have (512 KiB). */
export const MAX_LAYOUT_BYTES = 524288;

export const LAYOUT_PLATFORMS = ["linux", "darwin"] as const;
export type LayoutPlatform = (typeof LAYOUT_PLATFORMS)[number];

/** The top-level keys of a Linux manifest besides the header. */
export const LINUX_LAYOUT_KEYS = [
  "os",
  "firmware",
  "loaders",
  "disks",
  "md",
  "luks",
  "plainCrypt",
  "lvm",
  "filesystems",
  "swap",
  "mounts",
  "fstab",
  "bootloader",
  "initramfs",
  "kernels",
  "dkms",
  "mokFiles",
  "configs",
  "network",
  "netConfigs",
  "deviceNameRefs",
  "backup",
  "agent",
  "unsupported",
  "verdict",
  "raw",
] as const;

/** The top-level keys of a macOS manifest besides the header (provisional until M6). */
export const DARWIN_LAYOUT_KEYS = [
  "macos",
  "users",
  "applications",
  "backup",
  "agent",
  "unsupported",
  "verdict",
  "raw",
] as const;

const SHARED_KEYS = new Set<string>(["backup", "agent", "unsupported", "verdict", "raw"]);
/** Keys only a macOS manifest may carry. */
const DARWIN_ONLY_KEYS = DARWIN_LAYOUT_KEYS.filter((key) => !SHARED_KEYS.has(key));
/** Keys only a Linux manifest may carry. */
const LINUX_ONLY_KEYS = LINUX_LAYOUT_KEYS.filter((key) => !SHARED_KEYS.has(key));

/** The codes `Assess` puts on a manifest, by severity (docs/BAREMETAL.md 4.4). */
export const LAYOUT_UNSUPPORTED_CODES = [
  "fs_type_unsupported",
  "lvm_type_unsupported",
  "md_container_unsupported",
  "md_journal_unsupported",
  "md_reshape_in_progress",
  "multipath_unsupported",
  "integrity_unsupported",
  "luks_detached_header",
  "network_root_unsupported",
  "xfs_external_log",
  "bootloader_unsupported",
  "initramfs_unsupported",
  "uki_without_generator",
  "unknown_device_in_boot_path",
  "container",
  "fstab_unresolvable",
] as const;

export const LAYOUT_WARNING_CODES = [
  "luks_token",
  "snapshot_subvolumes",
  "lvm_snapshot_lvs",
  "raw_lvs",
  "pve_guest_volumes",
  "docker_btrfs_many",
  "data_fs_unsupported",
  "untested_distribution",
  "non_systemd_init",
  "secure_boot_own_keys",
  "dkms_mok",
  "bios_needs_csm",
  "dual_boot_windows",
  "lvm_device_ids",
  "device_name_refs",
  "md_degraded",
  "capture_failed",
] as const;

/** The btrfs checksum types `mkfs.btrfs --csum` accepts (`filesystems[].btrfs.csum`). */
export const BTRFS_CSUM_TYPES = ["crc32c", "xxhash", "sha256", "blake2"] as const;

export const LAYOUT_VERDICTS = ["supported", "supported_with_warnings", "unsupported"] as const;
export type LayoutVerdict = (typeof LAYOUT_VERDICTS)[number];

/** Why a backup source was read without a snapshot (`backup.liveReasons`). */
export const LIVE_REASONS = [
  "off",
  "partition",
  "md",
  "vfat",
  "luks_on_lv",
  "vg_no_space",
  "thin_pool_busy",
  "unsupported_fs",
  "no_helper",
] as const;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const MAX_STRING_BYTES = 4096;
const MAX_CMDLINE_BYTES = 8192;

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** A string of at most `max` UTF-8 bytes without control characters. */
function text(max = MAX_STRING_BYTES) {
  return z
    .string()
    .refine(noControlChars, { message: "control character" })
    .refine((value) => utf8Length(value) <= max, { message: `longer than ${max} bytes` });
}

const S = text();
const SN = S.nullable();
/** An integer from 0 to 2^53-1. */
const I = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const IN = I.nullable();
const B = z.boolean();
const list = <T extends z.ZodType>(item: T, max: number) => z.array(item).max(max);
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/, { message: "not a lowercase hex SHA-256" });

const DISK_ID = /^d\d{1,3}$/;
const MD_ID = /^m\d{1,3}$/;
const LUKS_ID = /^c\d{1,3}$/;
const PLAIN_ID = /^p\d{1,3}$/;
const FS_ID = /^f\d{1,4}$/;
const LVM_NAME = /^[A-Za-z0-9+_.-]{1,127}$/;

const diskId = z.string().regex(DISK_ID);
const lvmName = z.string().regex(LVM_NAME);

export const blockRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("disk"), disk: diskId }),
  z.strictObject({ kind: z.literal("partition"), disk: diskId, number: I }),
  z.strictObject({ kind: z.literal("md"), id: z.string().regex(MD_ID) }),
  z.strictObject({ kind: z.literal("luks"), id: z.string().regex(LUKS_ID) }),
  z.strictObject({ kind: z.literal("plain"), id: z.string().regex(PLAIN_ID) }),
  z.strictObject({ kind: z.literal("lv"), vg: lvmName, lv: lvmName }),
]);
export type BlockRef = z.infer<typeof blockRefSchema>;

const unsupportedSchema = z.looseObject({
  code: S,
  ref: SN,
  message: S,
  severity: z.enum(["unsupported", "warning"]),
});
export type LayoutUnsupported = z.infer<typeof unsupportedSchema>;

const rawSchema = z.looseObject({ name: S, sha256: SHA256 });

const headerShape = {
  format: z.literal(LAYOUT_FORMAT),
  schemaVersion: z.literal(LAYOUT_SCHEMA_VERSION),
  capturedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, { message: "not RFC 3339 UTC in seconds" }),
  agentVersion: S,
  hostname: S,
};

const backupSchema = z.looseObject({
  sources: list(S, 4096),
  excludes: list(S, 1000),
  fsSnapshots: z.record(S, z.enum(["lvm", "btrfs", "live"])),
  liveReasons: z.record(S, z.enum(LIVE_REASONS)),
});

const agentSchema = z.looseObject({ hooks: z.enum(["off", "scripts", "any"]) });

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

const osSchema = z.looseObject({
  id: S,
  idLike: list(S, 64),
  versionId: SN,
  prettyName: SN,
  arch: S,
  kernel: S,
  cmdline: text(MAX_CMDLINE_BYTES),
  selinux: z.enum(["enforcing", "permissive", "disabled"]).nullable(),
  init: z.enum(["systemd", "other"]),
  proxmoxVE: B,
  machineId: B,
});

const firmwareSchema = z.looseObject({
  mode: z.enum(["uefi", "bios"]),
  secureBoot: B.nullable(),
  setupMode: B.nullable(),
  entries: list(
    z.looseObject({
      num: I,
      label: S,
      partuuid: SN,
      partNumber: IN,
      loader: SN,
      active: B,
    }),
    128,
  ),
  bootOrder: list(I, 128),
  bootCurrent: IN,
  sbatLevel: list(text(256), 64),
  db: list(z.looseObject({ subject: S, sha256: SHA256 }), 64),
  dbxSha256: SHA256.nullable(),
  mok: list(z.looseObject({ subject: SN, sha256: SHA256 }), 64),
});

const loaderSchema = z.looseObject({
  path: S,
  bytes: I,
  authenticodeSha256: SHA256,
  signer: z.looseObject({ issuer: S, subject: S, serial: S }).nullable(),
  sbat: list(S, 64),
  uki: B,
  ukiCmdline: SN,
});

const partitionSchema = z.looseObject({
  number: I,
  startBytes: I,
  sizeBytes: I,
  type: S,
  uuid: SN,
  name: SN,
  attrs: S,
  bootable: B,
  grow: z.literal(true).optional(),
});

const diskSchema = z.looseObject({
  id: diskId,
  kname: S,
  sizeBytes: I,
  logicalSectorSize: I,
  physicalSectorSize: I,
  model: SN,
  serial: SN,
  wwn: SN,
  eui64: SN,
  nguid: SN,
  nsid: IN,
  transport: SN,
  rotational: B,
  removable: B,
  readOnly: B,
  zoned: S,
  majMin: S,
  bootCode: z.enum(["grub", "none", "other"]),
  pmbrBoot: B,
  driverChain: list(S, 64),
  driverModaliases: list(S, 64),
  table: z
    .looseObject({
      type: z.enum(["gpt", "dos"]),
      id: S,
      sectorSize: I,
      firstLba: IN,
      lastLba: IN,
      tableLength: IN,
      partitions: list(partitionSchema, 256),
    })
    .nullable(),
});

const mdSchema = z.looseObject({
  id: z.string().regex(MD_ID),
  name: SN,
  kname: S,
  uuid: S,
  level: S,
  metadata: S,
  chunkBytes: IN,
  layout: SN,
  raidDevices: I,
  sizeBytes: I,
  members: list(z.looseObject({ device: blockRefSchema, role: IN, writeMostly: B, state: S }), 256),
  spares: list(blockRefSchema, 256),
  bitmap: z.enum(["internal", "none", "external"]),
  homehost: SN,
  state: S,
  journal: B,
});

const luksSchema = z.looseObject({
  id: z.string().regex(LUKS_ID),
  device: blockRefSchema,
  version: z.union([z.literal(1), z.literal(2)]),
  uuid: S,
  label: SN,
  subsystem: SN,
  cipher: S,
  keyBits: I,
  sectorSize: I,
  pbkdf: z.looseObject({ type: S, iterations: IN, memoryKiB: IN, time: IN, parallel: IN }),
  keyslots: I,
  tokenTypes: list(S, 64),
  flags: list(S, 64),
  requirements: list(S, 64),
  integrity: SN,
  keyFile: SN,
  mappedName: SN,
  crypttabName: SN,
});

const plainCryptSchema = z.looseObject({
  id: z.string().regex(PLAIN_ID),
  device: blockRefSchema,
  partuuid: SN,
  mappedName: S,
  cipher: S,
  keyBits: I,
  purpose: z.enum(["swap", "tmp", "plain"]),
  keySource: S,
  crypttabName: SN,
});

const lvSchema = z.looseObject({
  name: lvmName,
  uuid: S,
  type: S,
  sizeBytes: I,
  stripes: IN,
  stripeBytes: IN,
  pool: SN,
  origin: SN,
  virtualBytes: IN,
  chunkBytes: IN,
  metadataBytes: IN,
  tags: list(S, 64),
  active: B,
  raw: B,
  grow: z.literal(true).optional(),
});

const lvmSchema = z.looseObject({
  useDevicesFile: B,
  devicesFileIdTypes: list(S, 64),
  filterHasDeviceNames: B,
  allowMixedBlockSizes: B,
  pvs: list(z.looseObject({ device: blockRefSchema, uuid: S, sizeBytes: I, vg: SN }), 256),
  vgs: list(
    z.looseObject({
      name: lvmName,
      uuid: S,
      extentBytes: I,
      sizeBytes: I,
      freeBytes: I,
      systemId: SN,
      lvs: list(lvSchema, 1024),
    }),
    64,
  ),
});

const subvolumeSchema = z.looseObject({
  id: I,
  path: S,
  parentId: I,
  uuid: S,
  parentUuid: SN,
  readOnly: B,
  mounted: list(S, 256),
  kind: z.enum(["normal", "snapper", "timeshift", "docker", "machines", "restow"]),
});

const filesystemSchema = z.looseObject({
  id: z.string().regex(FS_ID),
  devices: list(blockRefSchema, 256).min(1),
  type: S,
  uuid: SN,
  uuidSub: SN,
  label: SN,
  sizeBytes: I,
  usedBytes: I,
  inodesUsed: IN,
  ext: z
    .looseObject({
      blockSize: I,
      inodeSize: I,
      inodeCount: I,
      features: list(S, 128),
      reservedPercent: I,
      flexBgSize: IN,
      journalBytes: IN,
    })
    .optional(),
  xfs: z
    .looseObject({
      blockSize: I,
      sectorSize: I,
      agCount: I,
      features: list(S, 128),
      logBytes: I,
      externalLog: B,
      realtime: B,
    })
    .optional(),
  btrfs: z
    .looseObject({
      dataProfile: S,
      metadataProfile: S,
      systemProfile: S,
      nodeSize: I,
      sectorSize: I,
      features: list(S, 128),
      // The checksum type (`csum_type` of dump-super), since M2; older manifests have none and the
      // planner assumes crc32c. Not part of the layout fingerprint.
      csum: z.enum(BTRFS_CSUM_TYPES).nullable().optional(),
      quota: B,
      defaultSubvolume: z.looseObject({ id: I, path: S }),
      subvolumes: list(subvolumeSchema, 4096),
      noCowDirs: list(S, 4096),
    })
    .optional(),
  vfat: z
    .looseObject({ fatBits: I, volumeId: S, sectorsPerCluster: I, logicalSectorSize: I })
    .optional(),
});

const swapSchema = z.looseObject({
  kind: z.enum(["partition", "file", "plain"]),
  device: blockRefSchema.nullable(),
  path: SN,
  fs: SN,
  uuid: SN,
  label: SN,
  sizeBytes: I,
  // Decimal text: a swap priority may be negative, and the manifest has no negative numbers.
  priority: z.string().regex(/^-?\d{1,6}$/),
  resumeOffset: IN,
});

const mountSchema = z.looseObject({
  target: S,
  fs: SN,
  source: S,
  type: S,
  options: S,
  subvol: SN,
  subvolId: IN,
  autofs: B,
});

const fstabSchema = z.looseObject({
  source: S,
  target: S,
  type: S,
  options: S,
  origin: z.enum(["fstab", "unit"]),
  unit: SN,
  noauto: B,
  nofail: B,
  automount: B,
  resolved: z
    .union([
      z.strictObject({ fs: S }),
      z.strictObject({ swap: I }),
      z.strictObject({ block: blockRefSchema }),
    ])
    .nullable(),
});

const bootloaderSchema = z.looseObject({
  kind: z.enum(["grub", "systemd-boot", "none", "other"]),
  platform: SN,
  bls: B,
  shim: B,
  esps: list(S, 16),
  xbootldr: SN,
  efiDirectory: SN,
  bootloaderId: SN,
  grubCfg: SN,
  biosDisks: list(S, 64),
  deviceMap: B,
  proxmoxBootTool: B,
  fallbackChain: B,
});

const initramfsSchema = z.looseObject({
  generator: z.enum(["initramfs-tools", "dracut", "mkinitcpio", "other"]).nullable(),
  hostonly: B.nullable(),
  modules: SN,
  ukiPresets: B,
  kernelInstallLayout: SN,
  addDevices: list(S, 64),
  keymap: z.looseObject({
    layout: SN,
    variant: SN,
    source: SN,
    inInitramfs: B,
    grubCryptodisk: B,
  }),
});

const kernelSchema = z.looseObject({
  version: S,
  image: S,
  initramfs: SN,
  imageBytes: I,
  initramfsBytes: IN,
  default: B,
  signer: SN,
  uki: B,
});

const dkmsSchema = z.looseObject({
  module: S,
  version: S,
  kernel: S,
  signer: SN,
  kind: z.enum(["net", "storage", "other"]),
});

const pathHash = z.looseObject({ path: S, sha256: SHA256 });

const networkSchema = z.looseObject({
  name: S,
  mac: SN,
  driver: SN,
  modalias: SN,
  pciPath: SN,
  physical: B,
});

const linuxShape = {
  ...headerShape,
  platform: z.literal("linux"),
  os: osSchema,
  firmware: firmwareSchema,
  loaders: list(loaderSchema, 256),
  disks: list(diskSchema, 64),
  md: list(mdSchema, 64),
  luks: list(luksSchema, 256),
  plainCrypt: list(plainCryptSchema, 64),
  lvm: lvmSchema,
  filesystems: list(filesystemSchema, 1024),
  swap: list(swapSchema, 64),
  mounts: list(mountSchema, 4096),
  fstab: list(fstabSchema, 1024),
  bootloader: bootloaderSchema,
  initramfs: initramfsSchema,
  kernels: list(kernelSchema, 64),
  dkms: list(dkmsSchema, 512),
  mokFiles: list(pathHash, 16),
  configs: list(pathHash, 64),
  network: list(networkSchema, 64),
  netConfigs: list(z.looseObject({ path: S, macs: list(S, 64) }), 256),
  deviceNameRefs: list(z.looseObject({ path: S, line: I, device: S }), 512),
  backup: backupSchema,
  agent: agentSchema,
  unsupported: list(unsupportedSchema, 512),
  verdict: z.enum(LAYOUT_VERDICTS),
  raw: list(rawSchema, 512),
};

type RefinementContext = z.core.$RefinementCtx<unknown>;

function issue(ctx: RefinementContext, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

function refuseKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  ctx: RefinementContext,
  other: string,
): void {
  for (const key of keys) {
    if (Object.hasOwn(value, key)) {
      issue(ctx, [key], `a key of a ${other} manifest`);
    }
  }
}

function blockKey(ref: BlockRef): string {
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

/** The cross-field rules of a Linux manifest: unique ids, references, no cycle, totals. */
function refineLinux(value: z.infer<z.ZodObject<typeof linuxShape>>, ctx: RefinementContext): void {
  const nodes = new Set<string>();
  const duplicate = (path: (string | number)[], key: string) => {
    if (nodes.has(key)) {
      issue(ctx, path, "duplicate id");
    }
    nodes.add(key);
  };
  value.disks.forEach((disk, index) => {
    duplicate(["disks", index, "id"], `disk:${disk.id}`);
    const numbers = new Set<number>();
    for (const [p, partition] of (disk.table?.partitions ?? []).entries()) {
      if (numbers.has(partition.number)) {
        issue(ctx, ["disks", index, "table", "partitions", p, "number"], "duplicate partition");
      }
      numbers.add(partition.number);
      nodes.add(`partition:${disk.id}:${partition.number}`);
    }
  });
  for (const [index, md] of value.md.entries()) {
    duplicate(["md", index, "id"], `md:${md.id}`);
  }
  for (const [index, luks] of value.luks.entries()) {
    duplicate(["luks", index, "id"], `luks:${luks.id}`);
  }
  for (const [index, plain] of value.plainCrypt.entries()) {
    duplicate(["plainCrypt", index, "id"], `plain:${plain.id}`);
  }
  let lvs = 0;
  const vgNames = new Set<string>();
  value.lvm.vgs.forEach((vg, index) => {
    if (vgNames.has(vg.name)) {
      issue(ctx, ["lvm", "vgs", index, "name"], "duplicate volume group");
    }
    vgNames.add(vg.name);
    vg.lvs.forEach((lv, l) => {
      lvs++;
      duplicate(["lvm", "vgs", index, "lvs", l, "name"], `lv:${vg.name}/${lv.name}`);
    });
  });
  if (lvs > 1024) {
    issue(ctx, ["lvm", "vgs"], "more than 1024 logical volumes");
  }
  const fsIds = new Set<string>();
  let subvolumes = 0;
  value.filesystems.forEach((fs, index) => {
    if (fsIds.has(fs.id)) {
      issue(ctx, ["filesystems", index, "id"], "duplicate id");
    }
    fsIds.add(fs.id);
    subvolumes += fs.btrfs?.subvolumes.length ?? 0;
  });
  if (subvolumes > 4096) {
    issue(ctx, ["filesystems"], "more than 4096 subvolumes");
  }

  // Every reference resolves; the edges point from a holder to the device it lies on.
  const edges = new Map<string, string[]>();
  const edge = (from: string | null, ref: BlockRef, path: (string | number)[]) => {
    const to = blockKey(ref);
    if (!nodes.has(to)) {
      issue(ctx, path, `unknown device ${to}`);
      return;
    }
    if (from) {
      const list = edges.get(from) ?? [];
      list.push(to);
      edges.set(from, list);
    }
  };
  for (const [index, md] of value.md.entries()) {
    for (const [m, member] of md.members.entries()) {
      edge(`md:${md.id}`, member.device, ["md", index, "members", m, "device"]);
    }
    for (const [sp, spare] of md.spares.entries()) {
      edge(`md:${md.id}`, spare, ["md", index, "spares", sp]);
    }
  }
  for (const [index, luks] of value.luks.entries()) {
    edge(`luks:${luks.id}`, luks.device, ["luks", index, "device"]);
  }
  for (const [index, plain] of value.plainCrypt.entries()) {
    edge(`plain:${plain.id}`, plain.device, ["plainCrypt", index, "device"]);
  }
  const lvsOf = new Map(value.lvm.vgs.map((vg) => [vg.name, vg.lvs.map((lv) => lv.name)]));
  value.lvm.pvs.forEach((pv, index) => {
    const path = ["lvm", "pvs", index, "device"];
    if (pv.vg !== null && !lvsOf.has(pv.vg)) {
      issue(ctx, ["lvm", "pvs", index, "vg"], "unknown volume group");
    }
    const holders = pv.vg === null ? [] : (lvsOf.get(pv.vg) ?? []);
    if (holders.length === 0) {
      edge(null, pv.device, path);
    }
    for (const lv of holders) {
      edge(`lv:${pv.vg}/${lv}`, pv.device, path);
    }
  });
  for (const [index, fs] of value.filesystems.entries()) {
    for (const [d, device] of fs.devices.entries()) {
      edge(null, device, ["filesystems", index, "devices", d]);
    }
  }
  value.swap.forEach((swap, index) => {
    if (swap.device) edge(null, swap.device, ["swap", index, "device"]);
  });
  value.fstab.forEach((entry, index) => {
    const resolved = entry.resolved;
    if (resolved && "block" in resolved) {
      edge(null, resolved.block, ["fstab", index, "resolved", "block"]);
    } else if (resolved && "fs" in resolved && !fsIds.has(resolved.fs)) {
      issue(ctx, ["fstab", index, "resolved", "fs"], "unknown file system");
    } else if (resolved && "swap" in resolved && resolved.swap >= value.swap.length) {
      issue(ctx, ["fstab", index, "resolved", "swap"], "unknown swap");
    }
  });
  value.mounts.forEach((mount, index) => {
    if (mount.fs !== null && !fsIds.has(mount.fs)) {
      issue(ctx, ["mounts", index, "fs"], "unknown file system");
    }
  });
  value.bootloader.esps.forEach((esp, index) => {
    if (!fsIds.has(esp)) issue(ctx, ["bootloader", "esps", index], "unknown file system");
  });
  const diskIds = new Set(value.disks.map((disk) => disk.id));
  value.bootloader.biosDisks.forEach((disk, index) => {
    if (!diskIds.has(disk)) issue(ctx, ["bootloader", "biosDisks", index], "unknown disk");
  });
  // A partition lies on its disk.
  for (const node of nodes) {
    if (node.startsWith("partition:")) {
      edges.set(node, [...(edges.get(node) ?? []), `disk:${node.split(":")[1]}`]);
    }
  }
  if (hasCycle(edges)) {
    issue(ctx, [], "the block device references form a cycle");
  }
}

function hasCycle(edges: Map<string, string[]>): boolean {
  const state = new Map<string, 1 | 2>();
  const visit = (node: string): boolean => {
    const seen = state.get(node);
    if (seen === 1) return true;
    if (seen === 2) return false;
    state.set(node, 1);
    for (const next of edges.get(node) ?? []) {
      if (visit(next)) return true;
    }
    state.set(node, 2);
    return false;
  };
  return [...edges.keys()].some((node) => visit(node));
}

export const linuxLayoutSchema = z.looseObject(linuxShape).superRefine((value, ctx) => {
  refuseKeys(value as Record<string, unknown>, DARWIN_ONLY_KEYS, ctx, "macOS");
  refineLinux(value, ctx);
});

/**
 * macOS (provisional until M6, docs/BAREMETAL.md 13.2): the header and the system, its users and
 * applications, loosely typed. The server stores no macOS layout before M6.
 */
export const darwinLayoutSchema = z
  .looseObject({
    ...headerShape,
    platform: z.literal("darwin"),
    macos: z.looseObject({}),
    users: list(z.looseObject({}), 1024),
    applications: list(z.looseObject({}), 8192),
    backup: backupSchema.optional(),
    agent: agentSchema.optional(),
    unsupported: list(unsupportedSchema, 512).optional(),
    verdict: z.enum(LAYOUT_VERDICTS).optional(),
    raw: list(rawSchema, 512).optional(),
  })
  .superRefine((value, ctx) =>
    refuseKeys(value as Record<string, unknown>, LINUX_ONLY_KEYS, ctx, "Linux"),
  );

export const layoutManifestSchema = z.discriminatedUnion("platform", [
  linuxLayoutSchema,
  darwinLayoutSchema,
]);

export type LinuxLayoutManifest = z.infer<typeof linuxLayoutSchema>;
export type DarwinLayoutManifest = z.infer<typeof darwinLayoutSchema>;
export type LayoutManifest = z.infer<typeof layoutManifestSchema>;
export type LinuxDisk = LinuxLayoutManifest["disks"][number];
export type LinuxFilesystem = LinuxLayoutManifest["filesystems"][number];

export type ParsedLayout =
  | { ok: true; manifest: LayoutManifest; canonical: string; sha256: string }
  | { ok: false; reason: string };

/**
 * Check a manifest as the agent sent it. The answer carries the canonical encoding of the value
 * as received (unknown keys included) and its SHA-256, which equal what the agent wrote into the
 * snapshot; or why the manifest is refused.
 */
export function parseLayoutManifest(value: unknown): ParsedLayout {
  let canonical: string;
  try {
    canonical = canonicalLayoutJson(value);
  } catch (error) {
    if (error instanceof CanonicalEncodingError) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
  if (Buffer.byteLength(canonical, "utf8") > MAX_LAYOUT_BYTES) {
    return { ok: false, reason: `larger than ${MAX_LAYOUT_BYTES} bytes` };
  }
  const parsed = layoutManifestSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? first.path.join(".") : "manifest";
    return {
      ok: false,
      reason: `${where}: ${first?.message ?? "invalid"}`.slice(0, 300),
    };
  }
  return { ok: true, manifest: parsed.data, canonical, sha256: canonicalSha256(canonical) };
}
