/**
 * The end-to-end cases of the bare metal restore (docs/BAREMETAL.md 21.2): which source
 * machine is built and backed up, onto which hardware the recovery ISO restores it, and
 * what the answers file says. E1 and E2 run on every pull request that touches the
 * restore (CI job recovery-e2e), the others every night and before a release
 * (.github/workflows/recovery-nightly.yml).
 *
 * A disk is `{ serial, size, bus, sectorSize?, eui64? }`; `bus` is the controller QEMU puts it
 * on (virtio, ahci, nvme, scsi). An NVMe disk needs a fixed EUI-64 (16 hex digits): the ISO
 * identifies it by that (eui.<hex>, recovery.Identity), never by its serial number. The source machines of the factory are built by the shell
 * scripts of the recovery ISO's own test folder (`factory`); the others start from a pinned
 * cloud image (`cloud`, images.json). `answers` holds only keys of the answers file
 * (restow-answers-v1); run.mjs adds the rest.
 */

/** @typedef {{ serial: string, size: string, bus: "virtio" | "ahci" | "nvme" | "scsi", sectorSize?: 512 | 4096, eui64?: string }} Disk */

const GiB = (n) => `${n}G`;

/** @type {readonly object[]} */
export const CASES = Object.freeze([
  {
    id: "E1",
    perPR: true,
    title: "Debian 12, BIOS, MBR, mdadm RAID1 of two disks onto one larger disk (degraded)",
    source: {
      kind: "factory",
      script: "e1-debian12-bios-md.sh",
      mirror: "debian",
      firmware: "bios",
      disks: [
        { serial: "e2e-src0", size: GiB(8), bus: "virtio" },
        { serial: "e2e-src1", size: GiB(8), bus: "virtio" },
      ],
    },
    target: {
      firmware: "bios",
      disks: [{ serial: "restow-e2e-target0", size: GiB(12), bus: "ahci" }],
    },
    // d1 names the second source disk, which the target lacks: recover maps it as missing and
    // starts the arrays degraded (an unnamed disk would be mapped automatically and fail).
    answers: { diskMapping: { d0: "serial.restow-e2e-target0", d1: "serial.e2e-src1" } },
  },
  {
    id: "E1b",
    perPR: false,
    title: "Ubuntu 22.04, BIOS, GPT with a BIOS boot partition per disk, RAID1, one disk missing",
    source: {
      kind: "factory",
      script: "e1b-ubuntu2204-bios-gpt-md.sh",
      mirror: "ubuntu",
      firmware: "bios",
      disks: [
        { serial: "e2e-src0", size: GiB(8), bus: "virtio" },
        { serial: "e2e-src1", size: GiB(8), bus: "virtio" },
      ],
    },
    target: {
      firmware: "bios",
      disks: [{ serial: "restow-e2e-target0", size: GiB(8), bus: "ahci" }],
    },
    // d1 is missing on the target, as in E1.
    answers: { diskMapping: { d0: "serial.restow-e2e-target0", d1: "serial.e2e-src1" } },
  },
  {
    id: "E2",
    perPR: true,
    title:
      "Ubuntu 24.04, UEFI Secure Boot, LUKS2 and LVM, NVMe instead of virtio, smaller, other MAC",
    source: {
      kind: "factory",
      script: "e2-ubuntu2404-uefi-sb-luks-lvm.sh",
      mirror: "ubuntu",
      firmware: "uefi-sb",
      passphrase: true,
      disks: [{ serial: "e2e-src0", size: GiB(20), bus: "virtio" }],
    },
    target: {
      firmware: "uefi-sb",
      // A second boot of the restored disks with empty NVRAM variables (the fallback path).
      alsoEmptyNvram: true,
      newMac: true,
      disks: [
        { serial: "restow-e2e-target0", size: GiB(16), bus: "nvme", eui64: "525400e2e0000002" },
      ],
    },
    // QEMU's NVMe namespace shows no EUI-64 in Linux (NVME_QUIRK_BOGUS_NID): serial and nsid.
    answers: { diskMapping: { d0: "serial.restow-e2e-target0-1" } },
  },
  {
    id: "E3",
    perPR: false,
    title:
      "AlmaLinux 9, UEFI, LVM with system.devices, XFS, dracut hostonly, SELinux, BLS, de keymap",
    source: {
      kind: "cloud",
      image: "almalinux9",
      firmware: "uefi",
      disks: [{ serial: "e2e-src0", size: GiB(20), bus: "virtio" }],
    },
    target: {
      firmware: "uefi",
      disks: [{ serial: "restow-e2e-other0", size: GiB(20), bus: "ahci" }],
    },
    answers: { keymap: "de" },
  },
  {
    id: "E4",
    perPR: false,
    title:
      "Fedora, UEFI, btrfs subvolumes with a nested one and docker's btrfs driver, zstd, larger",
    source: {
      kind: "cloud",
      image: "fedora",
      firmware: "uefi",
      disks: [{ serial: "e2e-src0", size: GiB(20), bus: "virtio" }],
    },
    target: {
      firmware: "uefi",
      disks: [{ serial: "restow-e2e-target0", size: GiB(30), bus: "virtio" }],
    },
    answers: {},
  },
  {
    id: "E5",
    perPR: false,
    title: "openSUSE Leap 15.6, btrfs with Snapper after a rollback, quota on, GRUB2",
    source: {
      kind: "cloud",
      image: "opensuse-leap-15.6",
      firmware: "uefi",
      disks: [{ serial: "e2e-src0", size: GiB(24), bus: "virtio" }],
    },
    target: {
      firmware: "uefi",
      disks: [{ serial: "restow-e2e-target0", size: GiB(24), bus: "virtio" }],
    },
    answers: {},
  },
  {
    id: "E6",
    perPR: false,
    title: "Debian 13, UEFI without Secure Boot, LVM thin, systemd-boot, onto a 4Kn disk",
    source: {
      kind: "factory",
      script: "e6-debian13-thin-sdboot.sh",
      mirror: "debian",
      firmware: "uefi",
      disks: [{ serial: "e2e-src0", size: GiB(16), bus: "virtio" }],
    },
    target: {
      firmware: "uefi",
      disks: [{ serial: "restow-e2e-target0", size: GiB(16), bus: "scsi", sectorSize: 4096 }],
    },
    answers: {},
  },
  {
    id: "E6b",
    perPR: false,
    title: "Arch Linux, systemd-boot with a UKI (mkinitcpio), ESP with x-systemd.automount, NVMe",
    source: {
      kind: "cloud",
      image: "arch",
      firmware: "uefi",
      disks: [{ serial: "e2e-src0", size: GiB(16), bus: "virtio" }],
    },
    target: {
      firmware: "uefi",
      disks: [
        { serial: "restow-e2e-target0", size: GiB(16), bus: "nvme", eui64: "525400e2e000006b" },
      ],
    },
    answers: {},
  },
  {
    id: "E7",
    perPR: false,
    title: "Debian 12, LUKS1 with an encrypted /boot that GRUB unlocks, BIOS with GPT",
    source: {
      kind: "factory",
      script: "e7-debian12-luks1-boot.sh",
      mirror: "debian",
      firmware: "bios",
      passphrase: true,
      // z, y and - sit on other keys of a German keyboard (docs/BAREMETAL.md 27.12).
      passphraseText: "zyx-restow-e2e-yz",
      unlockAtBoot: true,
      disks: [{ serial: "e2e-src0", size: GiB(12), bus: "virtio" }],
    },
    target: {
      firmware: "bios",
      disks: [{ serial: "restow-e2e-target0", size: GiB(12), bus: "virtio" }],
    },
    answers: {},
  },
  {
    id: "E8",
    perPR: false,
    title:
      "Cancel during the restore and resume; a second code after a power loss (--overwrite always)",
    source: {
      kind: "factory",
      script: "e1-debian12-bios-md.sh",
      mirror: "debian",
      firmware: "bios",
      disks: [
        { serial: "e2e-src0", size: GiB(8), bus: "virtio" },
        { serial: "e2e-src1", size: GiB(8), bus: "virtio" },
      ],
    },
    target: {
      firmware: "bios",
      disks: [{ serial: "restow-e2e-target0", size: GiB(12), bus: "ahci" }],
    },
    interrupt: ["cancel", "power-loss"],
    answers: { diskMapping: { d0: "serial.restow-e2e-target0" } },
  },
  {
    id: "E9",
    perPR: false,
    title:
      "System disk plus a data RAID5 with LVM: new system disk, the data RAID kept, the old disk still there",
    source: {
      kind: "factory",
      script: "e9-system-plus-raid5.sh",
      mirror: "debian",
      firmware: "bios",
      disks: [
        { serial: "e2e-src0", size: GiB(8), bus: "virtio" },
        { serial: "e2e-data0", size: GiB(4), bus: "virtio" },
        { serial: "e2e-data1", size: GiB(4), bus: "virtio" },
        { serial: "e2e-data2", size: GiB(4), bus: "virtio" },
      ],
    },
    target: {
      firmware: "bios",
      // The data disks stay, the old system disk stays connected, a new system disk comes in.
      keepSourceDisks: ["e2e-src0", "e2e-data0", "e2e-data1", "e2e-data2"],
      disks: [{ serial: "restow-e2e-target0", size: GiB(10), bus: "ahci" }],
    },
    // The old system disk carries the identities of the backup: it is wiped (typed in the
    // dialog, here named in confirmErase) after the conflict is found.
    eraseAlso: ["serial.e2e-src0"],
    answers: { diskMapping: { d0: "serial.restow-e2e-target0" }, adopt: ["md0"] },
  },
  {
    id: "E10",
    perPR: false,
    title: "Debian 12 with a plain dm-crypt swap and a data file system, disks in another order",
    source: {
      kind: "factory",
      script: "e10-plaincrypt-swap.sh",
      mirror: "debian",
      firmware: "bios",
      disks: [
        { serial: "e2e-src0", size: GiB(8), bus: "virtio" },
        { serial: "e2e-src1", size: GiB(4), bus: "virtio" },
        { serial: "e2e-src2", size: GiB(4), bus: "virtio" },
      ],
    },
    target: {
      firmware: "bios",
      disks: [
        { serial: "restow-e2e-target2", size: GiB(4), bus: "virtio" },
        { serial: "restow-e2e-target0", size: GiB(8), bus: "virtio" },
        { serial: "restow-e2e-target1", size: GiB(4), bus: "virtio" },
      ],
    },
    answers: {
      diskMapping: {
        d0: "serial.restow-e2e-target0",
        d1: "serial.restow-e2e-target1",
        d2: "serial.restow-e2e-target2",
      },
    },
  },
]);

/**
 * The boot probe of the recovery lab (docs/BAREMETAL.md 12.3, M5): a source machine of the
 * factory is backed up, and the lab (its own container, the image of this checkout) restores it
 * through the recovery flow onto other hardware and boots it; the driver judges by the API alone
 * (the machine's bare metal state and its newest probe report). P1 and P2 run per pull request
 * next to E1 and E2, P3 at night.
 *
 *   P1  Debian 12, BIOS, md RAID1 (the source of E1): green.
 *   P2  Ubuntu 24.04, UEFI Secure Boot with the current DBX, LUKS2 and LVM on NVMe instead of
 *       virtio (the source of E2), with a GRUB default that starts the emergency target: the
 *       machine itself still starts (its grub.cfg was written before), the restore writes a new
 *       one: red with the pattern `emergency_mode`.
 *   P3  Debian 13, LVM thin, systemd-boot on an NVMe source, probed on AHCI, with a 3 GiB data
 *       folder under /var/lib and a restore limit of 2.5 GiB: the folder stays empty, green.
 */
export const PROBE_CASES = Object.freeze([
  {
    id: "P1",
    perPR: true,
    title: "Boot probe: Debian 12, BIOS, md RAID1 (E1's source) starts on other hardware",
    source: CASES.find((item) => item.id === "E1").source,
    probe: { expect: "green" },
  },
  {
    id: "P2",
    perPR: true,
    title:
      "Boot probe: Ubuntu 24.04, Secure Boot, LUKS2 and LVM (E2's source) with a GRUB default that starts the emergency target",
    source: {
      ...CASES.find((item) => item.id === "E2").source,
      env: { FACTORY_PROBE_EMERGENCY: "1" },
    },
    probe: { expect: "red", pattern: "emergency_mode" },
  },
  {
    id: "P3",
    perPR: false,
    title:
      "Boot probe: Debian 13, LVM thin, systemd-boot, NVMe source on AHCI, a data folder left empty",
    source: {
      ...CASES.find((item) => item.id === "E6").source,
      disks: [{ serial: "e2e-src0", size: GiB(16), bus: "nvme", eui64: "525400e2e00000f3" }],
      env: { FACTORY_PROBE_BULK: "1" },
    },
    probe: { expect: "green", maxRestoreGiB: 2.5, emptyDirs: ["/var/lib/e2e-bulk"] },
  },
]);

/** Every case a run can select: the restores and the boot probes. */
export const ALL_CASES = Object.freeze([...CASES, ...PROBE_CASES]);

/**
 * The cases of a run: `per-pr` (E1, E2, P1, P2), `nightly` (the rest), `all`, or a
 * comma-separated list of ids (case-insensitive). An unknown id is an error, so a typo never
 * runs nothing.
 */
export function selectCases(filter, cases = ALL_CASES) {
  const wanted = (filter ?? "per-pr").trim();
  if (wanted === "per-pr") return cases.filter((item) => item.perPR);
  if (wanted === "nightly") return cases.filter((item) => !item.perPR);
  if (wanted === "all") return [...cases];
  const ids = wanted
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const known = new Map(cases.map((item) => [item.id.toLowerCase(), item]));
  const unknown = ids.filter((id) => !known.has(id.toLowerCase()));
  if (unknown.length > 0 || ids.length === 0) {
    throw new Error(
      `unknown case ${unknown.join(", ") || "(none given)"}; known: ${cases.map((item) => item.id).join(", ")}`,
    );
  }
  return ids.map((id) => known.get(id.toLowerCase()));
}
