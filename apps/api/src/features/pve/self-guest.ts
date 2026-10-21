import { readFile } from "node:fs/promises";

/**
 * Which VM this Restow installation runs in (docs/PVE.md, "The Restow server's own VM").
 *
 * A VM on Proxmox VE carries an SMBIOS UUID in its configuration (`smbios1: uuid=...`), and the
 * guest's kernel shows the same UUID as /sys/class/dmi/id/product_uuid; containers of the image
 * see that file too (the API runs as root in its container). restow-pve reports each VM's UUID
 * with the inventory, and a match marks the guest as the Restow server.
 *
 * `RESTOW_HOST_SMBIOS_UUID` overrides the file (a host that hides /sys, or a test). Without
 * either, nothing is detected: Restow in a container (LXC) or on hardware has no such UUID in
 * PVE, and the admin flags the guest by hand instead.
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
