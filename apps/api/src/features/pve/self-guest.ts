import { readFile } from "node:fs/promises";

/**
 * Which guest this Restow installation runs in (docs/PVE.md, "The Restow server's own VM").
 *
 * A VM on Proxmox VE carries an SMBIOS UUID in its configuration (`smbios1: uuid=...`), and the
 * guest's kernel shows the same UUID as /sys/class/dmi/id/product_uuid; containers of the image
 * see that file too (the API runs as root in its container). restow-pve reports each VM's UUID
 * with the inventory, and a match marks the guest as the Restow server.
 * `RESTOW_HOST_SMBIOS_UUID` overrides the file (a host that hides /sys, or a test).
 *
 * A container (LXC) has no SMBIOS UUID of its own: it sees the host's. Its volumes carry its
 * VMID instead, and the mount table shows them as the source of its root and of every volume
 * mounted from it, also inside the Docker container the API runs in (a Docker volume lies on the
 * container's root): `rpool/data/subvol-105-disk-0` (ZFS), `/dev/mapper/pve-vm--105--disk--0`
 * (LVM, LVM-thin), `/dev/rbd-pve/<fsid>/<pool>/vm-105-disk-0` (Ceph). {@link mountinfoVmids}
 * collects those VMIDs, and a container is detected only when exactly one results; a container
 * on directory storage (a loop device) shows none. `RESTOW_HOST_PVE_VMID` overrides the mount
 * table. The VMID alone is no proof: the same VMID can exist in two clusters, so a match counts
 * only when it is unique among the connected clusters (node-service.ts). A VM is never matched
 * by its VMID. Without either, the admin flags the guest by hand.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What VMs without their own UUID and some firmware report: never a match. */
const PLACEHOLDERS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
]);

let cached: Promise<string | null> | null = null;

export function normalizeSmbiosUuid(value: string | null | undefined): string | null {
  const text = (value ?? "").trim().toLowerCase();
  return UUID.test(text) && !PLACEHOLDERS.has(text) ? text : null;
}

async function readOwnUuid(): Promise<string | null> {
  const fromEnv = normalizeSmbiosUuid(process.env.RESTOW_HOST_SMBIOS_UUID);
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return normalizeSmbiosUuid(await readFile("/sys/class/dmi/id/product_uuid", "utf8"));
  } catch {
    return null;
  }
}

/** The SMBIOS UUID of the machine the API runs on, or null when it cannot be read. */
export function ownSmbiosUuid(): Promise<string | null> {
  cached ??= readOwnUuid();
  return cached;
}

/** Forget the cached UUID (tests). */
export function resetOwnSmbiosUuid(): void {
  cached = null;
}

/** A VMID as PVE gives them: 100 to 999999999. */
export function normalizePveVmid(value: string | number | null | undefined): number | null {
  const text = String(value ?? "").trim();
  if (!/^\d{3,9}$/.test(text)) {
    return null;
  }
  const vmid = Number(text);
  return vmid >= 100 ? vmid : null;
}

/** A mount table field with its octal escapes (`\040` for a space) undone. */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

/** ZFS: `<pool>/<path>/subvol-105-disk-0`, the dataset of a container's root or volume. */
const ZFS_SUBVOL = /(?:^|\/)subvol-(\d+)-disk-\d+$/;
/** LVM: device mapper names double the dashes of the volume group and the volume. */
const DM_VOLUME = /^\/dev\/mapper\/(?:[^/]*[^-/])?-vm--(\d+)--disk--\d+$/;
/** LVM (`/dev/<vg>/vm-105-disk-0`), Ceph RBD and image files: the volume's own name. */
const VOLUME_NAME = /^\/dev\/(?:[^/]+\/)+vm-(\d+)-disk-\d+(?:\.raw)?$/;

/** The VMID a mount source names as a PVE guest volume, or null. */
export function volumeVmid(source: string): number | null {
  const match = ZFS_SUBVOL.exec(source) ?? DM_VOLUME.exec(source) ?? VOLUME_NAME.exec(source);
  return match ? normalizePveVmid(match[1]) : null;
}

/**
 * The VMIDs the mount sources of a mount table (/proc/self/mountinfo) name as PVE guest volumes,
 * sorted. Field 10 of a line, the first after the fstype that follows the " - " separator, is
 * the source; anything that names no guest volume (overlay, proc, tmpfs, a disk of a VM, a loop
 * device) is left out.
 */
export function mountinfoVmids(text: string): number[] {
  const vmids = new Set<number>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) {
      continue;
    }
    const [, source] = line.slice(separator + 3).split(" ");
    const vmid = source ? volumeVmid(unescapeMountField(source)) : null;
    if (vmid !== null) {
      vmids.add(vmid);
    }
  }
  return [...vmids].sort((a, b) => a - b);
}

let cachedVmid: Promise<number | null> | null = null;

async function readOwnVmid(): Promise<number | null> {
  const fromEnv = normalizePveVmid(process.env.RESTOW_HOST_PVE_VMID);
  if (fromEnv !== null) {
    return fromEnv;
  }
  try {
    const vmids = mountinfoVmids(await readFile("/proc/self/mountinfo", "utf8"));
    // Volumes of two guests (a volume of another container mounted in): not decidable.
    return vmids.length === 1 ? (vmids[0] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * The VMID of the container (LXC) the API runs in, from `RESTOW_HOST_PVE_VMID` or the mount
 * table; null when it cannot be told (a VM, hardware, directory storage, several guests).
 */
export function ownPveVmid(): Promise<number | null> {
  cachedVmid ??= readOwnVmid();
  return cachedVmid;
}

/** Forget the cached VMID (tests). */
export function resetOwnPveVmid(): void {
  cachedVmid = null;
}

/**
 * Whether a reported guest is the container the API runs in: a container (never a VM) with the
 * API's VMID, and no container with that VMID in another connected cluster
 * (`otherClusterContainers`). An ambiguous match marks nothing; the admin marks it by hand.
 */
export function containerIsOwn(
  ownVmid: number | null,
  guest: { kind: string; vmid: number },
  otherClusterContainers: number,
): boolean {
  return (
    ownVmid !== null &&
    guest.kind === "ct" &&
    guest.vmid === ownVmid &&
    otherClusterContainers === 0
  );
}
