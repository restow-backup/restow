/**
 * What replacement hardware needs for a bare metal restore (docs/BAREMETAL.md 2.2, 10.5, 10.8,
 * 14.6 step 2): derived from the layout manifest of the chosen backup and the stage 1 report of
 * its snapshot. Pure; the API hands the result to the wizard, which only words it.
 */
import type { LinuxLayoutManifest } from "./manifest.js";

/** The memory the ISO needs at least (8.2); restic keeps its index in memory on top of that. */
export const RECOVERY_RAM_MIN_BYTES = 2 * 1024 * 1024 * 1024;
/** The memory recommended for large repositories (8.2). */
export const RECOVERY_RAM_RECOMMENDED_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Drivers of controllers that present virtual disks of a hardware RAID (the virtual disk must be
 * created in the controller before the restore, 2.2, 21.4).
 */
export const HARDWARE_RAID_DRIVERS: readonly string[] = [
  "aacraid",
  "hpsa",
  "megaraid_sas",
  "mpi3mr",
  "smartpqi",
];

export interface ReplacementDisk {
  id: string;
  kname: string;
  sizeBytes: number;
  /** The smallest target that holds the data (stage 1 L3), or null when the check has not run. */
  minBytes: number | null;
  transport: string | null;
  logicalSectorSize: number;
  model: string | null;
}

export interface ReplacementHardware {
  firmwareMode: "uefi" | "bios";
  /** The machine ran with Secure Boot; null when that was not known. */
  secureBoot: boolean | null;
  /** The issuers that signed the boot chain's loaders: the target's firmware must trust them. */
  requiredCAs: string[];
  disks: ReplacementDisk[];
  ramMinBytes: number;
  ramRecommendedBytes: number;
  keymap: {
    layout: string | null;
    variant: string | null;
    inInitramfs: boolean;
    grubCryptodisk: boolean;
  };
  luksVolumes: number;
  /** Token types bound to the old hardware (`systemd-tpm2`, `systemd-fido2`): enrolled again. */
  tokenTypes: string[];
  tpm: boolean;
  /**
   * The storage drivers the planner looked for on another disk controller (stage 1 L3,
   * `other-controller`): `ok` when the backed-up kernel has the driver. Empty for a report
   * written before M4.
   */
  storageDriversOtherController: { module: string; ok: boolean }[];
  /** Disks behind a hardware RAID controller: the virtual disk must exist before the restore. */
  hardwareRaidHint: { disk: string; minBytes: number | null }[];
  /** A BIOS machine needs a replacement with a legacy (CSM) boot mode. */
  biosNeedsCsm: boolean;
  /** Wired network cards the machine had (only their count is a hint). */
  nics: number;
}

/** The parts of the stage 1 report this reads (`BaremetalCheckDto` of the API). */
export interface ReplacementCheckInput {
  minimumSizes: Record<string, unknown> | null;
  planner: Record<string, unknown> | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function minimumByDisk(check: ReplacementCheckInput | null): Map<string, number> {
  const out = new Map<string, number>();
  const disks = record(check?.minimumSizes)?.disks;
  if (!Array.isArray(disks)) return out;
  for (const entry of disks) {
    const disk = record(entry);
    if (typeof disk?.disk === "string" && typeof disk.minBytes === "number") {
      out.set(disk.disk, disk.minBytes);
    }
  }
  return out;
}

function otherControllerDrivers(check: ReplacementCheckInput | null) {
  const run = record(record(check?.planner)?.otherController);
  const storage = run?.storage;
  if (!Array.isArray(storage)) return [];
  const seen = new Map<string, boolean>();
  for (const entry of storage) {
    const driver = record(entry);
    if (typeof driver?.module !== "string" || driver.module === "") continue;
    const ok = driver.found === true || driver.builtin === true;
    seen.set(driver.module, (seen.get(driver.module) ?? false) || ok);
  }
  return [...seen]
    .map(([module, ok]) => ({ module, ok }))
    .sort((a, b) => (a.module < b.module ? -1 : 1));
}

/** What the wizard's step "Replacement hardware" shows for a backup. */
export function replacementHardware(
  manifest: LinuxLayoutManifest,
  check: ReplacementCheckInput | null,
): ReplacementHardware {
  const minimums = minimumByDisk(check);
  const disks: ReplacementDisk[] = manifest.disks.map((disk) => ({
    id: disk.id,
    kname: disk.kname,
    sizeBytes: disk.sizeBytes,
    minBytes: minimums.get(disk.id) ?? null,
    transport: disk.transport,
    logicalSectorSize: disk.logicalSectorSize,
    model: disk.model,
  }));
  // The first stage the firmware checks (shim, or the fallback loader that is a copy of it):
  // the firmware of the target must trust its issuer. Without a shim, every signed loader.
  const firstStage = manifest.loaders.filter((loader) =>
    /^(shim[a-z0-9]*|boot(x64|aa64))\.efi$/i.test(loader.path.split("/").pop() ?? ""),
  );
  const requiredCAs = [
    ...new Set(
      (firstStage.length > 0 ? firstStage : manifest.loaders)
        .map((loader) => loader.signer?.issuer ?? "")
        .filter((issuer) => issuer !== ""),
    ),
  ].sort();
  const tokenTypes = [...new Set(manifest.luks.flatMap((volume) => volume.tokenTypes))].sort();
  const hardwareRaidHint = manifest.disks
    .filter((disk) => disk.driverChain.some((driver) => HARDWARE_RAID_DRIVERS.includes(driver)))
    .map((disk) => ({ disk: disk.id, minBytes: minimums.get(disk.id) ?? null }));
  return {
    firmwareMode: manifest.firmware.mode,
    secureBoot: manifest.firmware.secureBoot,
    requiredCAs: manifest.firmware.secureBoot === false ? [] : requiredCAs,
    disks,
    ramMinBytes: RECOVERY_RAM_MIN_BYTES,
    ramRecommendedBytes: RECOVERY_RAM_RECOMMENDED_BYTES,
    keymap: {
      layout: manifest.initramfs.keymap.layout,
      variant: manifest.initramfs.keymap.variant,
      inInitramfs: manifest.initramfs.keymap.inInitramfs,
      grubCryptodisk: manifest.initramfs.keymap.grubCryptodisk,
    },
    luksVolumes: manifest.luks.length,
    tokenTypes,
    tpm: tokenTypes.includes("systemd-tpm2"),
    storageDriversOtherController: otherControllerDrivers(check),
    hardwareRaidHint,
    biosNeedsCsm: manifest.firmware.mode === "bios",
    nics: manifest.network.filter((nic) => nic.physical).length,
  };
}
