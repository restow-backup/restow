import { randomFill } from "node:crypto";
import { open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { diskThreshold } from "./disk-threshold.js";

/**
 * The emergency disk reserve (#98, docs/DATABASE.md "Disk full"). A disk that fills up to the
 * last byte stops PostgreSQL (it cannot even write `postmaster.pid`), the api with it, and the
 * edge shows its maintenance page; getting it back used to need a shell or a rescue console.
 * So Restow keeps a file of real blocks (default 2 GiB) on the disk of the `restow-data` volume,
 * which in the standard installation is also the disk of PostgreSQL's volume `pgdata` and of
 * Docker's data directory:
 *
 *   - Below a hard floor of free space (default 1 GiB) the api frees it by itself: every 30 s
 *     while it runs, and once before the migrations whenever its container starts (the
 *     entrypoint runs `restow disk-reserve guard`, which needs no database), so a server whose
 *     database stopped on a full disk gets the room to start it again. The release leaves a
 *     marker next to the reserve; the disk watch (disk-watch.ts) turns it into the alert
 *     `installation.disk_reserve_released` as soon as the database is reachable.
 *   - Once the disk has room again for the low-space threshold plus the reserve, the reserve is
 *     written again and `installation.disk_reserve_restored` says so.
 *   - By hand: `docker compose exec api restow disk-reserve release` (or `docker compose run
 *     --rm --no-deps --entrypoint restow api disk-reserve release` while the api is down), or
 *     simply deleting the file on the host.
 *
 * The file is written with random bytes, not zeros, so a file system that compresses or
 * deduplicates (btrfs, ZFS) still has to keep real blocks for it; never sparse. Known limits:
 * a copy-on-write file system with snapshots of the volume does not give the blocks back when
 * the file is deleted, and a database that was moved to another disk (Installation > Database)
 * is not on the reserve's disk: the reserve does not protect it there.
 *
 *   RESTOW_DISK_RESERVE_MB          size in MiB, default 2048; 0 switches the reserve off
 *   RESTOW_DISK_RESERVE_FLOOR_MB    free space below which it is freed, default 1024
 *   RESTOW_DISK_RESERVE_PATH        the file, default /data/restow-disk-reserve (the volume
 *                                   restow-data in the api container); its directory must exist
 */

const MIB = 1024 * 1024;
export const DEFAULT_DISK_RESERVE_MB = 2048;
export const DEFAULT_DISK_RESERVE_FLOOR_MB = 1024;
export const DEFAULT_DISK_RESERVE_PATH = "/data/restow-disk-reserve";
/** The marker a release leaves next to the reserve (JSON, see {@link ReserveMarker}). */
export const RELEASE_MARKER_SUFFIX = ".released";
/** The name a reserve is written under before it is renamed into place. */
const WRITING_SUFFIX = ".writing";
/** A write that has not touched its file for this long is taken as abandoned. */
const STALE_WRITE_MS = 10 * 60_000;
/** How much is written at a time. */
const WRITE_CHUNK_BYTES = 8 * MIB;

export interface DiskReserveConfig {
  /** The reserve file. */
  readonly path: string;
  /** Its size; 0 when the reserve is switched off. */
  readonly bytes: number;
  /** Free space below which the reserve is freed. */
  readonly floorBytes: number;
}

function mib(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim() ?? "";
  return /^\d+$/.test(trimmed) ? Number(trimmed) : fallback;
}

/** The reserve from the environment; empty or invalid values take the defaults. */
export function diskReserveConfig(
  env: Record<string, string | undefined> = process.env,
): DiskReserveConfig {
  const path = env.RESTOW_DISK_RESERVE_PATH?.trim();
  return {
    path: path?.startsWith("/") ? path : DEFAULT_DISK_RESERVE_PATH,
    bytes: mib(env.RESTOW_DISK_RESERVE_MB, DEFAULT_DISK_RESERVE_MB) * MIB,
    floorBytes: mib(env.RESTOW_DISK_RESERVE_FLOOR_MB, DEFAULT_DISK_RESERVE_FLOOR_MB) * MIB,
  };
}

/**
 * Where the api reads the database's disk without the updater (#98): PostgreSQL keeps its data
 * in the named volume `pgdata` unless it was moved to a directory of the host
 * (RESTOW_POSTGRES_DATA_TYPE=bind, written by the updater, docs/DATABASE.md). A named volume lies
 * in Docker's volume directory, like `restow-data`, which the api mounts at the reserve's
 * directory: the same disk. Null for a moved database, and where that directory does not exist
 * (development outside the container).
 */
export async function databaseDiskPath(
  env: Record<string, string | undefined> = process.env,
): Promise<{ measure: string; location: string } | null> {
  const type = env.RESTOW_POSTGRES_DATA_TYPE?.trim() || "volume";
  if (type !== "volume") {
    return null;
  }
  const measure = dirname(diskReserveConfig(env).path);
  if (!(await isDirectory(measure))) {
    return null;
  }
  return { measure, location: env.RESTOW_POSTGRES_DATA?.trim() || "pgdata" };
}

/** What a release wrote next to the reserve; `restoredAt` once the reserve is back. */
export interface ReserveMarker {
  releasedAt: string;
  /** `automatic` (below the floor), `start` (the entrypoint's check), `manual` (by hand). */
  reason: "automatic" | "start" | "manual";
  freeBytes: number | null;
  totalBytes: number | null;
  /** Free space right after the release. */
  freeAfterBytes?: number | null;
  restoredAt?: string | null;
}

/**
 * `off`          switched off (RESTOW_DISK_RESERVE_MB=0)
 * `unavailable`  its directory does not exist (development outside the container)
 * `present`      the file is there
 * `released`     it was freed (a marker says when) and is not back yet
 * `missing`      it is not there and no release is known: not created yet, or deleted by hand
 */
export type ReserveState = "off" | "unavailable" | "present" | "released" | "missing";

export interface ReserveStatus {
  readonly state: ReserveState;
  readonly path: string;
  readonly bytes: number;
  readonly floorBytes: number;
  /** Bytes of the file as it is (0 when it is not there). */
  readonly presentBytes: number;
  /** The disk under the reserve; null when it cannot be read. */
  readonly freeBytes: number | null;
  readonly totalBytes: number | null;
  /** Free space the disk needs before the reserve is written (again). */
  readonly createAtBytes: number | null;
  readonly marker: ReserveMarker | null;
}

export type ReserveAction =
  | "none"
  | "released"
  | "created"
  | "no_room"
  | "failed"
  | "busy"
  | "off"
  | "unavailable";

export interface DiskReserveDeps {
  readonly config: DiskReserveConfig;
  /** Free and total bytes of the file system under `path` (tests fake it). */
  readonly statfs?: (path: string) => Promise<{ freeBytes: number; totalBytes: number }>;
  readonly now?: () => Date;
}

async function defaultStatfs(path: string): Promise<{ freeBytes: number; totalBytes: number }> {
  const stats = await statfs(path);
  return {
    freeBytes: Number(stats.bavail) * Number(stats.bsize),
    totalBytes: Number(stats.blocks) * Number(stats.bsize),
  };
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Free space the disk must have before the reserve is written: the low threshold plus the reserve. */
export function reserveCreateAt(totalBytes: number, reserveBytes: number): number {
  return diskThreshold(totalBytes) + reserveBytes;
}

export class DiskReserve {
  constructor(private readonly deps: DiskReserveDeps) {}

  get config(): DiskReserveConfig {
    return this.deps.config;
  }

  private get markerPath(): string {
    return `${this.config.path}${RELEASE_MARKER_SUFFIX}`;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async disk(): Promise<{ freeBytes: number; totalBytes: number } | null> {
    try {
      return await (this.deps.statfs ?? defaultStatfs)(dirname(this.config.path));
    } catch {
      return null;
    }
  }

  async readMarker(): Promise<ReserveMarker | null> {
    try {
      const parsed = JSON.parse(await readFile(this.markerPath, "utf8")) as ReserveMarker;
      return typeof parsed?.releasedAt === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeMarker(marker: ReserveMarker): Promise<void> {
    await writeFile(this.markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  }

  async status(): Promise<ReserveStatus> {
    const { path, bytes, floorBytes } = this.config;
    const base = { path, bytes, floorBytes };
    if (bytes <= 0) {
      return {
        ...base,
        state: "off",
        presentBytes: 0,
        freeBytes: null,
        totalBytes: null,
        createAtBytes: null,
        marker: null,
      };
    }
    if (!(await isDirectory(dirname(path)))) {
      return {
        ...base,
        state: "unavailable",
        presentBytes: 0,
        freeBytes: null,
        totalBytes: null,
        createAtBytes: null,
        marker: null,
      };
    }
    const [size, disk, marker] = await Promise.all([
      fileSize(path),
      this.disk(),
      this.readMarker(),
    ]);
    const state: ReserveState =
      size !== null ? "present" : marker && !marker.restoredAt ? "released" : "missing";
    return {
      ...base,
      state,
      presentBytes: size ?? 0,
      freeBytes: disk?.freeBytes ?? null,
      totalBytes: disk?.totalBytes ?? null,
      createAtBytes: disk ? reserveCreateAt(disk.totalBytes, bytes) : null,
      marker,
    };
  }

  /** Free the reserve now; false when there was none. Leaves the marker for the alert. */
  async release(reason: ReserveMarker["reason"]): Promise<boolean> {
    const before = await this.disk();
    if ((await fileSize(this.config.path)) === null) {
      return false;
    }
    await rm(this.config.path, { force: true });
    const after = await this.disk();
    await this.writeMarker({
      releasedAt: this.now().toISOString(),
      reason,
      freeBytes: before?.freeBytes ?? null,
      totalBytes: before?.totalBytes ?? null,
      freeAfterBytes: after?.freeBytes ?? null,
      restoredAt: null,
    }).catch(() => undefined);
    return true;
  }

  /**
   * Write the reserve when it is not there and the disk has room for it above the low-space
   * threshold (`force` writes it whenever it fits at all, for the operator's `create`). The
   * file is written under a temporary name and renamed, so a half-written reserve is never
   * taken for one.
   */
  async create(options: { force?: boolean } = {}): Promise<ReserveAction> {
    const status = await this.status();
    if (status.state === "off" || status.state === "unavailable") {
      return status.state;
    }
    if (status.state === "present" && status.presentBytes >= status.bytes) {
      return "none";
    }
    if (status.freeBytes === null || status.totalBytes === null) {
      return "failed";
    }
    // A file that is too small (a write that was cut off before the rename cannot leave one,
    // but an operator's can) counts as room that comes back when it is replaced.
    const free = status.freeBytes + status.presentBytes;
    const needed = options.force
      ? status.bytes + status.floorBytes
      : (status.createAtBytes ?? Number.POSITIVE_INFINITY);
    if (free < needed) {
      return "no_room";
    }
    const temporary = `${status.path}${WRITING_SUFFIX}`;
    // Another writer (the installer's `create` while the api's loop runs) has it: leave it be,
    // unless it is left over from a writer that died.
    const writing = await stat(temporary).catch(() => null);
    if (writing && this.now().getTime() - writing.mtimeMs < STALE_WRITE_MS) {
      return "busy";
    }
    await rm(temporary, { force: true }).catch(() => undefined);
    try {
      await fillFile(temporary, status.bytes);
      await rename(temporary, status.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        return "busy";
      }
      await rm(temporary, { force: true }).catch(() => undefined);
      return "failed";
    }
    if (status.marker && !status.marker.restoredAt) {
      await this.writeMarker({ ...status.marker, restoredAt: this.now().toISOString() }).catch(
        () => undefined,
      );
    }
    return "created";
  }

  /**
   * One check: free the reserve below the floor; with `create`, write it again once there is
   * room. What it did, and the status after it.
   */
  async check(options: {
    create: boolean;
    reason?: ReserveMarker["reason"];
  }): Promise<{ action: ReserveAction; status: ReserveStatus }> {
    const status = await this.status();
    if (status.state === "off" || status.state === "unavailable") {
      return { action: status.state, status };
    }
    if (
      status.state === "present" &&
      status.freeBytes !== null &&
      status.freeBytes < status.floorBytes
    ) {
      const released = await this.release(options.reason ?? "automatic");
      return { action: released ? "released" : "none", status: await this.status() };
    }
    if (status.state !== "present" && options.create) {
      const action = await this.create();
      return { action, status: action === "created" ? await this.status() : status };
    }
    return { action: "none", status };
  }
}

/** `bytes` of random data in `path` (random, so no file system can store it as a hole). */
async function fillFile(path: string, bytes: number): Promise<void> {
  // "wx": never two writers in one file.
  const handle = await open(path, "wx", 0o600);
  try {
    const buffer = Buffer.allocUnsafe(Math.min(WRITE_CHUNK_BYTES, Math.max(bytes, 1)));
    let written = 0;
    while (written < bytes) {
      const length = Math.min(buffer.length, bytes - written);
      await new Promise<void>((resolve, reject) =>
        randomFill(buffer, 0, length, (error) => (error ? reject(error) : resolve())),
      );
      let offset = 0;
      while (offset < length) {
        const { bytesWritten } = await handle.write(buffer, offset, length - offset);
        offset += bytesWritten;
      }
      written += length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** One line per state, for the operator's command and the installer. */
export function describeReserve(status: ReserveStatus): string {
  const gib = (value: number) => `${(value / 1024 ** 3).toFixed(1)} GiB`;
  const disk =
    status.freeBytes !== null && status.totalBytes !== null
      ? ` The disk has ${gib(status.freeBytes)} of ${gib(status.totalBytes)} free.`
      : "";
  switch (status.state) {
    case "off":
      return "The disk reserve is switched off (RESTOW_DISK_RESERVE_MB=0).";
    case "unavailable":
      return `The disk reserve is not used: the directory of ${status.path} does not exist.`;
    case "present":
      return `Disk reserve: ${gib(status.presentBytes)} at ${status.path}. It is freed below ${gib(status.floorBytes)} free.${disk}`;
    case "released":
      return `The disk reserve was freed on ${status.marker?.releasedAt ?? "an unknown date"} and is written again once ${status.createAtBytes !== null ? gib(status.createAtBytes) : "enough"} are free.${disk}`;
    case "missing":
      return `There is no disk reserve at ${status.path} yet; it is written once ${status.createAtBytes !== null ? gib(status.createAtBytes) : "enough"} are free.${disk}`;
  }
}
