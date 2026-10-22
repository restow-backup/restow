import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Whether a directory repository lies on the system disk of the Restow server: the disk under
 * the operating system and Docker's data directory (images, container layers, logs, the named
 * volumes, usually PostgreSQL's data too). Backups that fill that disk stop the database and
 * every service with it (the incident of 16 October 2026: a repository in the default volume
 * filled the system disk). The warning never blocks; it says so on the repositories page, in
 * the "Backups land in" line and on the dashboard.
 *
 * Everything is read from inside the api container, which sees the repository at the same path
 * as the worker (both mount the same volumes, docker-compose.yml, and the mounter's NFS shares
 * at /mnt/restow/<name>, docs/MOUNTS.md). The container cannot see the host's mounts, but it can
 * see the disk under Docker's data directory: `/etc/hostname`, `/etc/hosts` and
 * `/etc/resolv.conf` are bind mounts of files in `/var/lib/docker/containers/<id>/`, and `/` is
 * an overlay of `/var/lib/docker/overlay2`. A path is on the system disk when it is on the same
 * device as one of them:
 *
 *   - the same `st_dev` (stat): a named volume of the default data directory, the container's own
 *     layer (a path that is no volume at all, e.g. a mount point under /mnt/restow whose share is
 *     not mounted), a bind mount of a host directory on the root disk;
 *   - or the same block device in /proc/self/mountinfo (the mount source `/dev/...`): a btrfs or
 *     LVM setup gives every subvolume a device number of its own while the disk is the same.
 *
 * A network share (NFS, the mounter's shares) or a bind mount of a second disk is on another
 * device and does not count. Outside a container (development) the same files are on the root
 * file system, so the rule reads the same. A path that does not exist yet counts by the nearest
 * directory above it that does (that is where it would be created).
 */

export interface SystemDiskDeps {
  /** `st_dev` of a path; null when it does not exist. */
  deviceOf?: (path: string) => Promise<number | null>;
  /** /proc/self/mountinfo; null when it cannot be read (not Linux). */
  mountinfo?: () => Promise<string | null>;
}

/** The files whose device is the disk under Docker's data directory (or the root disk). */
export const SYSTEM_DISK_PROBES = ["/", "/etc/hostname", "/etc/hosts", "/etc/resolv.conf"];

const defaultDeviceOf = async (path: string): Promise<number | null> => {
  try {
    return (await stat(path)).dev;
  } catch {
    return null;
  }
};

const defaultMountinfo = () => readFile("/proc/self/mountinfo", "utf8").catch(() => null);

interface MountLine {
  mountPoint: string;
  /** The mount source after the separator, e.g. `/dev/sda1`, `overlay`, `nas:/export`. */
  source: string;
}

function unescapeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function parseMountinfo(mountinfo: string): MountLine[] {
  const lines: MountLine[] = [];
  for (const line of mountinfo.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) {
      continue;
    }
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    const mountPoint = before[4] ? unescapeMountPath(before[4]) : null;
    const source = after[1] ? unescapeMountPath(after[1]) : null;
    if (mountPoint && source) {
      lines.push({ mountPoint, source });
    }
  }
  return lines;
}

/** The mount that holds `path` (the longest mount point that contains it; the last one wins). */
export function mountOf(mountinfo: string, path: string): MountLine | null {
  const target = resolve(path);
  let best: MountLine | null = null;
  for (const mount of parseMountinfo(mountinfo)) {
    const inside =
      mount.mountPoint === "/" ||
      target === mount.mountPoint ||
      target.startsWith(`${mount.mountPoint}/`);
    if (inside && (!best || mount.mountPoint.length >= best.mountPoint.length)) {
      best = mount;
    }
  }
  return best;
}

/** A block device as a mount source (the only kind two mounts can be compared by). */
function blockDevice(source: string | undefined): string | null {
  return source?.startsWith("/dev/") ? source : null;
}

/** The device of `path`, or of the nearest directory above it that exists. */
async function deviceOfExisting(
  deviceOf: (path: string) => Promise<number | null>,
  path: string,
): Promise<{ device: number; path: string } | null> {
  let current = resolve(path);
  for (;;) {
    const device = await deviceOf(current);
    if (device !== null) {
      return { device, path: current };
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Reads, once per call of {@link onSystemDisk}, what the system disk is. */
export async function onSystemDisk(path: string, deps: SystemDiskDeps = {}): Promise<boolean> {
  const deviceOf = deps.deviceOf ?? defaultDeviceOf;
  const existing = await deviceOfExisting(deviceOf, path);
  if (!existing) {
    return false;
  }
  const systemDevices = new Set<number>();
  for (const probe of SYSTEM_DISK_PROBES) {
    const device = await deviceOf(probe);
    if (device !== null) {
      systemDevices.add(device);
    }
  }
  if (systemDevices.has(existing.device)) {
    return true;
  }
  const info = await (deps.mountinfo ?? defaultMountinfo)();
  if (!info) {
    return false;
  }
  const source = blockDevice(mountOf(info, existing.path)?.source);
  if (!source) {
    return false;
  }
  return SYSTEM_DISK_PROBES.some((probe) => blockDevice(mountOf(info, probe)?.source) === source);
}
