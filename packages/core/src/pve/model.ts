/**
 * Restore points of Proxmox VE guests: building the synthetic-full block map
 * of a disk from its base and the blocks a run staged, the manifest of a
 * restore point, archive names, and the sample of blocks the weekly verify
 * reads back (docs/PROXMOX.md 2.3, 2.4).
 */
import { MANIFEST_VERSION, type ManifestObject, type SnapshotManifest } from "../manifest.js";
import { nextRunAt } from "../schedule/cadence.js";
import {
  BLOCK_FLAG_PRESENT,
  type BlockMap,
  type MapEntry,
  blockCount,
  blockLength,
  zeroEntry,
} from "./formats.js";

/** A block a run staged: data stored as `chunks`, or a zero block. */
export interface StagedBlock {
  index: number;
  zero: boolean;
  sha256: string;
  chunks: string[];
  length: number;
}

export class IncompleteDiskError extends Error {
  constructor(
    readonly device: string,
    readonly missing: number,
  ) {
    super(`${device}: ${missing} block(s) were neither uploaded nor in the base restore point`);
    this.name = "IncompleteDiskError";
  }
}

/**
 * The full map of a disk after a backup: every block of the base, replaced
 * by what the run staged. Without a base (first backup, size changed) every
 * block must be staged. Throws IncompleteDiskError otherwise, and on staged
 * blocks outside the disk or of the wrong length.
 */
export function buildBlockMap(
  device: string,
  diskSize: number,
  base: BlockMap | null,
  staged: Iterable<StagedBlock>,
): BlockMap {
  const count = blockCount(diskSize);
  const usable = base && base.diskSize === diskSize ? base : null;
  const entries: (MapEntry | undefined)[] = usable
    ? usable.entries.map((e) => ({ ...e, chunks: [...e.chunks] }))
    : new Array(count).fill(undefined);
  for (const block of staged) {
    if (block.index < 0 || block.index >= count) {
      throw new Error(`${device}: block ${block.index} lies outside a disk of ${diskSize} bytes`);
    }
    if (block.length !== blockLength(diskSize, block.index)) {
      throw new Error(
        `${device}: block ${block.index} has ${block.length} bytes, expected ${blockLength(diskSize, block.index)}`,
      );
    }
    entries[block.index] = block.zero
      ? zeroEntry()
      : { flags: BLOCK_FLAG_PRESENT, sha256: block.sha256, chunks: [...block.chunks] };
  }
  const missing = entries.filter((e) => e === undefined).length;
  if (missing > 0) {
    throw new IncompleteDiskError(device, missing);
  }
  return { diskSize, entries: entries as MapEntry[] };
}

/** How many blocks of a map hold data and how many are zero. */
export function mapStats(map: BlockMap): { dataBlocks: number; zeroBlocks: number } {
  let dataBlocks = 0;
  for (const e of map.entries) {
    if (e.flags & BLOCK_FLAG_PRESENT) {
      dataBlocks++;
    }
  }
  return { dataBlocks, zeroBlocks: map.entries.length - dataBlocks };
}

export type PveGuestKind = "vm" | "ct";

const ARCHIVE_NAME = /^(?:backup\/)?(vm|ct)\/(\d{1,9})\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/;

/** Parse an archive name or PVE volume name of a restore point. */
export function parseArchiveName(
  value: string,
): { kind: PveGuestKind; vmid: number; time: Date; archiveName: string } | null {
  const m = ARCHIVE_NAME.exec(value);
  if (!m) {
    return null;
  }
  const time = new Date(m[3] as string);
  if (Number.isNaN(time.getTime())) {
    return null;
  }
  return {
    kind: m[1] as PveGuestKind,
    vmid: Number(m[2]),
    time,
    archiveName: `${m[1]}/${m[2]}/${m[3]}`,
  };
}

/** The archive name of a backup started at `time`. */
export function archiveNameOf(kind: PveGuestKind, vmid: number, time: Date): string {
  return `${kind}/${vmid}/${time.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

/** Object types of a PVE restore point manifest. */
export const PVE_OBJECT_TYPES = {
  config: "pve-config",
  blockMap: "pve-block-map",
} as const;

/** What the manifest state of a PVE restore point records. */
export interface PveManifestState {
  kind: "pve-vm" | "pve-ct";
  clusterId: string;
  vmid: number;
  node: string;
  archiveName: string;
  storageId: string;
  pveVersion?: string;
  baseSnapshotId?: string | null;
  bitmapModes?: Record<string, string>;
  /** Containers: the restic snapshot in the guest's repository and its storage prefix. */
  resticSnapshotId?: string;
  resticRoot?: string;
  resticPrefix?: string;
}

export interface PveDiskObject {
  device: string;
  diskSize: number;
  /** The stored block map object. */
  map: { chunks: string[]; size: number; sha256: string };
  changedBlocks: number;
  zeroBlocks: number;
  bitmapMode: string;
}

/** Build the manifest of a PVE restore point (sealed and stored by the caller). */
export function buildPveManifest(input: {
  tenantId: string;
  snapshotId: string;
  guestId: string;
  createdAt: Date;
  sequence: number;
  state: PveManifestState;
  config: { chunks: string[]; size: number; sha256: string };
  firewall: { chunks: string[]; size: number; sha256: string } | null;
  disks: PveDiskObject[];
  packs: string[];
}): SnapshotManifest {
  const mtime = input.createdAt.getTime();
  const configName = input.state.kind === "pve-vm" ? "qemu-server.conf" : "pct.conf";
  const objects: ManifestObject[] = [
    {
      path: `config/${configName}`,
      size: input.config.size,
      mtime,
      type: PVE_OBJECT_TYPES.config,
      sha256: input.config.sha256,
      chunks: input.config.chunks,
    },
  ];
  if (input.firewall) {
    objects.push({
      path: "config/firewall.fw",
      size: input.firewall.size,
      mtime,
      type: PVE_OBJECT_TYPES.config,
      sha256: input.firewall.sha256,
      chunks: input.firewall.chunks,
    });
  }
  for (const d of [...input.disks].sort((a, b) => (a.device < b.device ? -1 : 1))) {
    objects.push({
      path: `disks/${d.device}.map`,
      size: d.map.size,
      mtime,
      type: PVE_OBJECT_TYPES.blockMap,
      sha256: d.map.sha256,
      chunks: d.map.chunks,
      metadata: {
        device: d.device,
        diskSize: String(d.diskSize),
        blockSize: String(4 * 1024 * 1024),
        changedBlocks: String(d.changedBlocks),
        zeroBlocks: String(d.zeroBlocks),
        bitmapMode: d.bitmapMode,
      },
    });
  }
  return {
    version: MANIFEST_VERSION,
    tenantId: input.tenantId,
    snapshotId: input.snapshotId,
    createdAt: input.createdAt.getTime(),
    source: { type: "pve", id: input.guestId, kind: input.state.kind },
    sequence: input.sequence,
    packs: input.packs,
    state: input.state as unknown as Record<string, unknown>,
    objects,
  };
}

/** The disks a PVE manifest holds (block map objects). */
export function pveDisksOf(
  manifest: SnapshotManifest,
): { device: string; diskSize: number; object: ManifestObject }[] {
  return manifest.objects
    .filter((o) => o.type === PVE_OBJECT_TYPES.blockMap)
    .map((o) => ({
      device: o.metadata?.device ?? o.path,
      diskSize: Number(o.metadata?.diskSize ?? 0),
      object: o,
    }));
}

/**
 * A random sample of data blocks of a map for the verify read-back (zero
 * blocks hold nothing to read). `random` returns [0, 1).
 */
export function sampleDataBlocks(
  map: BlockMap,
  count: number,
  random: () => number = Math.random,
): number[] {
  const data: number[] = [];
  map.entries.forEach((e, i) => {
    if (e.flags & BLOCK_FLAG_PRESENT) {
      data.push(i);
    }
  });
  for (let i = data.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [data[i], data[j]] = [data[j] as number, data[i] as number];
  }
  return data.slice(0, count).sort((a, b) => a - b);
}

/** When a PVE job runs: a daily local time, or every N minutes. */
export interface PveSchedule {
  kind: "daily" | "interval";
  timeOfDay?: string;
  intervalMinutes?: number;
  timeZone: string;
}

/** The next run of a PVE job after `now` (an interval counts from the last run). */
export function pveNextRunAt(schedule: PveSchedule, now: Date, lastRunAt: Date | null): Date {
  if (schedule.kind === "interval") {
    return nextRunAt(
      { intervalMinutes: schedule.intervalMinutes ?? 24 * 60, timezone: schedule.timeZone },
      { now, lastRunAt },
    );
  }
  const [hh, mm] = (schedule.timeOfDay ?? "22:00").split(":");
  return nextRunAt(
    { cron: `${Number(mm)} ${Number(hh)} * * *`, timezone: schedule.timeZone },
    { now },
  );
}
