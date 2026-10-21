import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  describeStorageLocation,
  type InstallationDefaultStorage,
  type StorageLocation,
} from "@restow/core";
import { type Database, storageTargets } from "@restow/db";
import { and, eq } from "drizzle-orm";
import { currentInstallationDefault } from "../../lib/installation-default.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { locationOf } from "./dto.js";

/**
 * Where a tenant's backups land right now (docs/STORAGE.md, "Where backups land"): the
 * effective primary target, which is the tenant's own primary or, without one, the
 * installation default. Machines, file shares and containers keep their restic repositories
 * there (`endpoints/<id>/`, `file-shares/<id>/`, `pve-guests/<id>/`), next to the chunk store
 * of mail and VM disks. Shown wherever a backup is started or configured.
 *
 * `onServerDisk` warns of a primary that is a directory on a disk of the server itself (the
 * installation default `/data/chunks` in the app volume, say): a failure of the server then
 * takes the backups with it. A directory on a network file system (NFS, SMB, ...) does not
 * count; the file system is read from `/proc/self/mountinfo`.
 */
export interface BackupDestinationDto {
  /** The tenant's primary target, or null for the installation default. */
  targetId: string | null;
  /** The target's name; null for the installation default (the UI names it). */
  name: string | null;
  installationDefault: boolean;
  kind: StorageLocation["kind"] | null;
  /**
   * A path or `s3://bucket/prefix (host)`. Null for the installation default unless the viewer
   * is a provider admin (its paths stay with the provider, as on the storage page).
   */
  location: string | null;
  /** A directory on a disk of the server itself (not a network share). */
  onServerDisk: boolean;
  /** The installation default is not usable (no tenant primary either). */
  misconfigured: boolean;
}

/** File system types of network shares: a directory on one of these is not the server's disk. */
const NETWORK_FILESYSTEMS = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smb3",
  "smbfs",
  "fuse.sshfs",
  "fuse.rclone",
  "fuse.s3fs",
  "glusterfs",
  "fuse.glusterfs",
  "ceph",
  "fuse.ceph",
  "9p",
  "afs",
  "lustre",
  "beegfs",
  "gpfs",
  "davfs",
  "fuse.davfs",
]);

/** `\040` and friends in mountinfo paths. */
function unescapeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

/** The file system type of the mount that holds `path` (longest mount point), from mountinfo. */
export function filesystemTypeOf(mountinfo: string, path: string): string | null {
  const target = resolve(path);
  let best: { mountPoint: string; type: string } | null = null;
  for (const line of mountinfo.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) {
      continue;
    }
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    const mountPoint = before[4] ? unescapeMountPath(before[4]) : null;
    const type = after[0];
    if (!mountPoint || !type) {
      continue;
    }
    const inside =
      mountPoint === "/" || target === mountPoint || target.startsWith(`${mountPoint}/`);
    if (inside && (!best || mountPoint.length >= best.mountPoint.length)) {
      best = { mountPoint, type };
    }
  }
  return best?.type ?? null;
}

export type MountinfoReader = () => Promise<string | null>;

const readMountinfo: MountinfoReader = () =>
  readFile("/proc/self/mountinfo", "utf8").catch(() => null);

/**
 * Whether a location is a directory on a disk of the server itself. Unknown file system (no
 * mountinfo, e.g. not Linux): the installation default counts as the server's disk, a target
 * an administrator chose does not.
 */
export async function isOnServerDisk(
  location: StorageLocation,
  installationDefault: boolean,
  mountinfo: MountinfoReader = readMountinfo,
): Promise<boolean> {
  if (location.kind !== "local") {
    return false;
  }
  const info = await mountinfo();
  const type = info ? filesystemTypeOf(info, location.basePath) : null;
  if (type === null) {
    return installationDefault;
  }
  return !NETWORK_FILESYSTEMS.has(type) && !type.startsWith("nfs");
}

export interface DestinationDeps {
  /** The installation default (tests); the saved one or the environment otherwise. */
  defaults?: () => Promise<InstallationDefaultStorage | null>;
  mountinfo?: MountinfoReader;
}

/** The tenant's own primary target row, if any. */
async function primaryRow(tx: DbExecutor, tenantId: string) {
  const [row] = await tx
    .select()
    .from(storageTargets)
    .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.role, "primary")))
    .limit(1);
  return row ?? null;
}

/** Where the tenant's backups land right now. */
export async function backupDestination(
  db: Database,
  tenantId: string,
  viewer: { readonly isProviderAdmin: boolean },
  deps: DestinationDeps = {},
): Promise<BackupDestinationDto> {
  const row = await withTenantTx(db, tenantId, (tx) => primaryRow(tx, tenantId));
  // A placeholder row standing for a retired installation default is never the primary.
  if (row && (row.kind === "local" || row.kind === "s3")) {
    const location = locationOf(row);
    return {
      targetId: row.id,
      name: row.name,
      installationDefault: false,
      kind: row.kind,
      location: location ? describeStorageLocation(location) : null,
      onServerDisk: location ? await isOnServerDisk(location, false, deps.mountinfo) : false,
      misconfigured: false,
    };
  }
  const defaults = await (deps.defaults ?? currentInstallationDefault)().catch(() => null);
  if (!defaults) {
    return {
      targetId: null,
      name: null,
      installationDefault: true,
      kind: null,
      location: null,
      onServerDisk: false,
      misconfigured: true,
    };
  }
  return {
    targetId: null,
    name: null,
    installationDefault: true,
    kind: defaults.primary.kind,
    location: viewer.isProviderAdmin ? describeStorageLocation(defaults.primary) : null,
    onServerDisk: await isOnServerDisk(defaults.primary, true, deps.mountinfo),
    misconfigured: false,
  };
}

/**
 * The effective primary as a record kept with a container's new backup chain
 * (`pve_guests.repository_chains`): the installation default without its path.
 */
export async function destinationRecord(
  db: Database,
  tenantId: string,
  deps: DestinationDeps = {},
): Promise<{
  name: string;
  kind: string | null;
  location: string | null;
  installationDefault: boolean;
}> {
  const destination = await backupDestination(db, tenantId, { isProviderAdmin: false }, deps);
  return {
    name: destination.name ?? "Installation default",
    kind: destination.kind,
    location: destination.location,
    installationDefault: destination.installationDefault,
  };
}
