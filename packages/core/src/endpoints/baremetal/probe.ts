/**
 * The boot probe (docs/BAREMETAL.md 12.3), stage 2 of "green is proof": the lab restores the
 * newest whole machine snapshot with the recovery ISO into a virtual machine, through the same code,
 * session and credentials a person uses, and boots the restored disks on another disk controller.
 * This module holds what the server decides about a probe, without I/O:
 *
 *   - whether a machine gets one and when ({@link bootProbeDue}),
 *   - the hardware of the probe ({@link probeHardware}) and what it restores in full and what it
 *     only creates empty ({@link probeSelection}),
 *   - the answers file the ISO reads through fw_cfg ({@link probeAnswers}),
 *   - the reading of the serial console of the restored system ({@link classifyProbeSerial}) and
 *     the rating of a finished probe ({@link judgeBootProbe}).
 *
 * The lab (apps/worker/src/endpoints/lab) only reports facts; the worker rates them here.
 */
import { z } from "zod";
import { noControlChars } from "./canonical.js";
import type { LinuxLayoutManifest } from "./manifest.js";
import type { PlanProblemCode, RestoreSize } from "./plan.js";
import type { RecoverProblemCode, RecoveryVerification } from "./verification.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const GIB = 1024 ** 3;

/** A green probe proves the boot of the same layout and boot chain for this long (12.4). */
export const PROBE_VALID_MS = 8 * DAY_MS;
/** A machine whose fingerprints did not change is probed again after this long. */
export const PROBE_INTERVAL_MS = 7 * DAY_MS;
/** After a probe that proved nothing (lab error, time limit), the next one waits this long. */
export const PROBE_RETRY_MS = 6 * HOUR_MS;
/** How long the recovery row of a probe lives: planned, leased and run (2 hours of work). */
export const PROBE_EXPIRY_MS = 3 * HOUR_MS;
/** The whole probe, from the lease to the result (12.3). */
export const PROBE_TIMEOUT_MS = 2 * HOUR_MS;
/** The boot of the restored disks until `RESTOW-PROBE-OK` (with KVM). */
export const PROBE_BOOT_TIMEOUT_MS = 10 * 60 * 1000;
/** A lab that asked for work within this time counts as present. */
export const LAB_FRESH_MS = 10 * 60 * 1000;
/** `RESTOW_LAB_MAX_RESTORE_GIB`: what a probe restores at most (24.8). */
export const LAB_MAX_RESTORE_GIB_DEFAULT = 64;
/** The address the VM reaches the lab's CONNECT proxy at (a `guestfwd` rule of QEMU). */
export const PROBE_PROXY_URL = "http://10.0.2.100:3128";

/** The lines the probe writes on a serial console. */
export const PROBE_OK_MARKER = "RESTOW-PROBE-OK";
export const PROBE_RELEASED_MARKER = "RESTOW-PROBE phase=released";

/** The mount points a probe always restores in full: what the system needs to start. */
export const PROBE_SYSTEM_MOUNTS: readonly string[] = ["/", "/boot", "/usr", "/var"];
/** Folders whose large children a probe may leave empty to stay under the limit. */
export const PROBE_FOLDER_ROOTS: readonly string[] = ["/var/lib", "/srv", "/home"];
/**
 * Never left empty, whatever their size (25.C10): without the package and systemd databases the
 * probe would boot a different system and prove the wrong thing.
 */
export const PROBE_PROTECTED_DIRS: readonly string[] = [
  "/var/lib/dkms",
  "/var/lib/dpkg",
  "/var/lib/pacman",
  "/var/lib/restow-agent",
  "/var/lib/rpm",
  "/var/lib/selinux",
  "/var/lib/shim-signed",
  "/var/lib/systemd",
];
/** How many folder sizes stage 1 keeps for the probe (the largest). */
export const MAX_PROBE_FOLDERS = 200;

/** Why a machine gets no boot probe. */
export const PROBE_NOT_POSSIBLE = ["not_systemd", "too_large", "no_disks"] as const;
export type ProbeNotPossible = (typeof PROBE_NOT_POSSIBLE)[number];

/** Why a machine is `layout_checked` and not green, as the page names it. */
export const PROBE_PENDING_REASONS = [
  "no_lab",
  "no_kvm",
  "planned",
  "running",
  "incomplete",
  ...PROBE_NOT_POSSIBLE,
] as const;
export type ProbePendingReason = (typeof PROBE_PENDING_REASONS)[number];

function isUnder(path: string, parent: string): boolean {
  return parent === "/" || path === parent || path.startsWith(`${parent}/`);
}

function cleanPath(path: string): string {
  const collapsed = path.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

/**
 * Whether `path` may be left empty by a probe. The agent checks the same before it excludes
 * anything (agent/internal/baremetal `ProbeEmptyAllowed`): an absolute, clean path that is no
 * system mount, no parent of one and no protected folder or a parent of one.
 */
export function probeEmptyAllowed(path: string, systemMounts: readonly string[]): boolean {
  if (!path.startsWith("/") || path !== cleanPath(path) || path.split("/").includes("..")) {
    return false;
  }
  if (path === "/" || !noControlChars(path)) return false;
  for (const mount of systemMounts) {
    if (path === mount || isUnder(mount, path)) return false;
  }
  for (const dir of PROBE_PROTECTED_DIRS) {
    if (isUnder(path, dir) || isUnder(dir, path)) return false;
  }
  return true;
}

/** The mount points of the EFI system partitions and XBOOTLDR: restored in full like /boot. */
function bootMounts(manifest: LinuxLayoutManifest): string[] {
  const fsIds = new Set(manifest.bootloader.esps);
  if (manifest.bootloader.xbootldr) fsIds.add(manifest.bootloader.xbootldr);
  return manifest.mounts
    .filter((mount) => mount.fs !== null && fsIds.has(mount.fs))
    .map((mount) => cleanPath(mount.target));
}

/** Every mount point a probe restores in full on this machine. */
export function probeSystemMounts(manifest: LinuxLayoutManifest): string[] {
  return [...new Set([...PROBE_SYSTEM_MOUNTS, ...bootMounts(manifest)])].sort();
}

export interface ProbeSelectionInput {
  manifest: LinuxLayoutManifest;
  /** Stage 1: the restore size of every mount target (12.1 L8). */
  restoreSizes: Record<string, RestoreSize>;
  /** Stage 1: the sizes of the children of {@link PROBE_FOLDER_ROOTS} (largest first). */
  folderSizes: Record<string, number>;
  maxBytes: number;
}

export type ProbeSelection =
  | {
      possible: true;
      /** Mount points restored in full. */
      fullRestore: string[];
      /** Mount points of file systems that are created with their identity, but empty. */
      emptyFilesystems: string[];
      /** Folders inside a restored file system that are left empty (largest first). */
      emptyDirs: string[];
      /** What the probe restores. */
      restoreBytes: number;
    }
  | { possible: false; reason: ProbeNotPossible; restoreBytes: number };

/**
 * What a probe restores (12.3): the system file systems in full, every other file system empty
 * with its identity (it mounts, the system starts, the data prove the restore test and stage 1).
 * Above `maxBytes` the largest folders under /var/lib, /srv and /home of a restored file system
 * stay empty, never a protected one; if even that is not enough, no probe is possible.
 */
export function probeSelection(input: ProbeSelectionInput): ProbeSelection {
  const system = probeSystemMounts(input.manifest);
  const targets = Object.keys(input.restoreSizes)
    .map(cleanPath)
    .sort((a, b) => b.length - a.length);
  const targetOf = (path: string): string | null =>
    targets.find((target) => isUnder(path, target)) ?? null;
  const fullRestore = targets.filter((target) => system.includes(target)).sort();
  const emptyFilesystems = targets
    .filter((target) => !system.includes(target) && probeEmptyAllowed(target, system))
    .sort();
  // A target that may neither be restored in full nor left empty (a parent of a system mount
  // that is no system mount itself, e.g. a separate /var/lib/systemd) is restored in full.
  for (const target of targets) {
    if (!fullRestore.includes(target) && !emptyFilesystems.includes(target)) {
      fullRestore.push(target);
    }
  }
  fullRestore.sort();
  let restoreBytes = fullRestore.reduce(
    (sum, target) => sum + (input.restoreSizes[target]?.bytes ?? 0),
    0,
  );
  const emptyDirs: string[] = [];
  if (restoreBytes > input.maxBytes) {
    const candidates = Object.entries(input.folderSizes)
      .map(([path, bytes]) => [cleanPath(path), bytes] as const)
      .filter(([path, bytes]) => {
        if (!(bytes > 0)) return false;
        const root = PROBE_FOLDER_ROOTS.find((r) => path.startsWith(`${r}/`));
        if (!root || path.slice(root.length + 1).includes("/")) return false;
        const target = targetOf(path);
        // Only inside a file system the probe restores, and never a mount point itself.
        return (
          target !== null &&
          target !== path &&
          fullRestore.includes(target) &&
          probeEmptyAllowed(path, system)
        );
      })
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [path, bytes] of candidates) {
      if (restoreBytes <= input.maxBytes) break;
      emptyDirs.push(path);
      restoreBytes -= bytes;
    }
  }
  if (restoreBytes > input.maxBytes) {
    return { possible: false, reason: "too_large", restoreBytes };
  }
  return { possible: true, fullRestore, emptyFilesystems, emptyDirs, restoreBytes };
}

/** The firmware the probe boots with: as backed up (12.3). */
export type ProbeFirmware = "uefi-sb" | "uefi" | "bios";
/** The disk controllers of the probe. */
export type ProbeController = "nvme" | "sata";

export interface ProbeDisk {
  /** The disk's id in the manifest. */
  id: string;
  sizeBytes: number;
  logicalSectorSize: 512 | 4096;
  controller: ProbeController;
  /** The serial number the probe gives the disk; the ISO identifies it as `serial.<serial>`. */
  serial: string;
}

export interface ProbeHardware {
  firmware: ProbeFirmware;
  disks: ProbeDisk[];
  nic: "e1000e" | "virtio-net";
  memoryMiB: number;
  cpus: number;
}

/**
 * The hardware of a probe (12.3), on purpose not the source's: the other disk controller (NVMe
 * becomes AHCI, everything else NVMe) and serial numbers on every disk, so device names and
 * missing drivers show; the network card of the other kind; disk sizes, sector sizes and the
 * firmware (Secure Boot as backed up) like the source.
 */
export function probeHardware(manifest: LinuxLayoutManifest): ProbeHardware {
  const firmware: ProbeFirmware =
    manifest.firmware.mode === "bios"
      ? "bios"
      : manifest.firmware.secureBoot === true
        ? "uefi-sb"
        : "uefi";
  const disks = manifest.disks
    .filter((disk) => !disk.removable && !disk.readOnly && disk.sizeBytes > 0)
    .map((disk, index) => ({
      id: disk.id,
      sizeBytes: disk.sizeBytes,
      logicalSectorSize: disk.logicalSectorSize === 4096 ? (4096 as const) : (512 as const),
      controller: (disk.transport === "nvme" ? "sata" : "nvme") as ProbeController,
      serial: `RESTOWPROBE${index}`,
    }));
  const virtio = manifest.network.some(
    (nic) => nic.physical && (nic.driver === "virtio_net" || nic.driver === "virtio-pci"),
  );
  return { firmware, disks, nic: virtio ? "e1000e" : "virtio-net", memoryMiB: 4096, cpus: 2 };
}

/** Whether a machine can be probed at all (before sizes count). */
export function probeNotPossible(manifest: LinuxLayoutManifest): ProbeNotPossible | null {
  if (manifest.os.init !== "systemd") return "not_systemd";
  if (probeHardware(manifest).disks.length === 0) return "no_disks";
  return null;
}

export interface ProbeAnswersInput {
  origin: string;
  /** The one-time recovery code of the probe's session. */
  code: string;
  /** The instance check value (XXXX-XXXX-XXXX-XXXX), as a code dialog shows it. */
  spkiCheck: string | null;
  snapshotId: string;
  hardware: ProbeHardware;
  selection: Extract<ProbeSelection, { possible: true }>;
  /** The passphrase of the probe's LUKS volumes (random; the lab types it at the boot). */
  passphrase: string;
  proxyUrl?: string;
}

/**
 * The answers file of a probe (`restow-answers-v1`, read by `recover` from fw_cfg): the same
 * unattended recovery a person can run, with the code, the disks of the probe mapped by their
 * serial numbers, the network through the lab's proxy only and the `probe` block that tells
 * `recover` what to leave empty (agent/internal/recovery answers.go).
 */
export function probeAnswers(input: ProbeAnswersInput): Record<string, unknown> {
  const mapping: Record<string, string> = {};
  for (const disk of input.hardware.disks) {
    mapping[disk.id] = `serial.${disk.serial}`;
  }
  return {
    format: "restow-answers-v1",
    instanceUrl: input.origin,
    code: input.code,
    ...(input.spkiCheck ? { spkiCheck: input.spkiCheck } : {}),
    snapshotId: input.snapshotId,
    language: "en",
    network: { mode: "dhcp", proxy: input.proxyUrl ?? PROBE_PROXY_URL },
    diskMapping: mapping,
    confirmErase: input.hardware.disks.map((disk) => `serial.${disk.serial}`),
    shrink: "none",
    passphrase: input.passphrase,
    keyFiles: "regenerate",
    rawLvs: "skip",
    afterSuccess: "poweroff",
    probe: {
      fullRestore: input.selection.fullRestore,
      emptyFilesystems: input.selection.emptyFilesystems,
      emptyDirs: input.selection.emptyDirs,
    },
  };
}

/** What the serial console of the restored system shows. */
export type ProbeSerialReading =
  | { outcome: "ok"; bootId: string; kernel: string; line: string }
  | { outcome: "failed"; pattern: ProbeFailurePattern; line: string }
  | { outcome: "none" };

/** The boot failures the probe recognises on the serial console (fixed patterns, 12.3). */
export const PROBE_FAILURE_PATTERNS = {
  kernel_panic: /Kernel panic - not syncing/,
  root_not_found:
    /Gave up waiting for root (file system )?device|ALERT! .{1,200} does not exist\. +Dropping to a shell|dracut-initqueue\[\d+\]: Warning: Could not boot|Cannot find root device|unable to find root|VFS: Unable to mount root fs/i,
  emergency_mode: /You are in emergency mode|Welcome to emergency mode|You are in rescue mode/,
  secure_boot_refused:
    /Security Violation|bad shim signature|SBAT self-check failed|Verification failed: \(0x1A\)|BdsDxe: failed to load .{1,200}: Access Denied/,
  no_bootable_device:
    /BdsDxe: No bootable option or device was found|No bootable device\.|error: no such device|grub rescue>/,
} as const;
export type ProbeFailurePattern = keyof typeof PROBE_FAILURE_PATTERNS;

const OK_LINE = /RESTOW-PROBE-OK ([0-9a-f-]{32,36}) (\S{1,128})/;

/**
 * The outcome of the restored system's boot as its serial console shows it: `ok` with the line
 * `restow-probe.service` writes once multi-user.target is reached, `failed` with the first fixed
 * failure pattern, `none` when the console shows neither (then the probe proves nothing).
 */
export function classifyProbeSerial(text: string): ProbeSerialReading {
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.slice(0, 500);
    const ok = OK_LINE.exec(line);
    if (ok) {
      return {
        outcome: "ok",
        bootId: ok[1] as string,
        kernel: ok[2] as string,
        line: line.trim(),
      };
    }
  }
  for (const raw of lines) {
    const line = raw.slice(0, 500);
    for (const [pattern, re] of Object.entries(PROBE_FAILURE_PATTERNS)) {
      if (re.test(line)) {
        return { outcome: "failed", pattern: pattern as ProbeFailurePattern, line: line.trim() };
      }
    }
  }
  return { outcome: "none" };
}

/** What the lab reports when a probe ends (`POST /internal/lab/:probeId/result`). */
export const LAB_RESULT_OUTCOMES = [
  // The ISO ran and powered off; the restored disks were booted.
  "booted",
  // The ISO ran, but its VM did not power off within the time limit, or crashed.
  "restore_stopped",
  // The restored disks did not show the marker or a failure within the boot time limit.
  "boot_timeout",
  // The lab could not run the probe (no KVM, no space, ISO not loadable, QEMU failed).
  "lab_error",
] as const;
export type LabResultOutcome = (typeof LAB_RESULT_OUTCOMES)[number];

const LAB_TEXT = z.string().max(500).refine(noControlChars, "control character in string");
const MS = z
  .number()
  .int()
  .min(0)
  .max(24 * HOUR_MS);

export const labResultSchema = z.strictObject({
  outcome: z.enum(LAB_RESULT_OUTCOMES),
  /** The serial console of the restored system (its tail), when it was booted. */
  bootSerial: z
    .string()
    .max(64 * 1024)
    .default(""),
  /** For `lab_error`: a code and an English message for the report. */
  error: z
    .strictObject({ code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), message: LAB_TEXT })
    .nullable()
    .default(null),
  kvm: z.boolean(),
  firmware: z.enum(["uefi-sb", "uefi", "bios"]),
  controllers: z.array(z.enum(["nvme", "sata"])).max(16),
  restoreMs: MS.nullable().default(null),
  bootMs: MS.nullable().default(null),
  labVersion: z.string().max(64).refine(noControlChars).default(""),
});
export type LabResult = z.infer<typeof labResultSchema>;

/** The recovery the probe's ISO ran, as the server stored it. */
export interface ProbeRecoveryFacts {
  status: string;
  verification: RecoveryVerification | null;
  warnings: { code: string; message: string }[];
}

/**
 * Codes of a failed recovery that prove a problem of the backup (or of the boot chain against the
 * current revocations), not of the lab: what the planner refuses for the snapshot itself, a
 * manifest that does not match, missing system files, a failed check after the restore. Codes the
 * probe's own hardware could cause (sizes, mapping, identities, a disk that went away) prove nothing.
 */
const BACKUP_PROBLEMS: ReadonlySet<string> = new Set<string>([
  "layout_unsupported",
  "manifest_invalid",
  "manifest_mismatch",
  "mkfs_feature_unknown",
  "mkfs_unsupported_type",
  "mok_key_missing",
  "secure_boot_ca_missing",
  "secure_boot_revoked",
  "secure_boot_sbat_revoked",
  "storage_driver_missing",
  "system_files_incomplete",
  "verify_failed",
] satisfies (PlanProblemCode | RecoverProblemCode)[]);

export type BootProbeCause =
  | { kind: "booted"; bootId: string; kernel: string; line: string }
  | { kind: "boot_failed"; pattern: ProbeFailurePattern; line: string }
  | { kind: "recovery_failed"; codes: string[] }
  | { kind: "verification_failed"; checks: string[] }
  | { kind: "incomplete"; reason: string };

export interface BootProbeJudgement {
  /** `green`, `red`, or null: the probe proved nothing and is repeated. */
  readiness: "green" | "red" | null;
  cause: BootProbeCause;
}

/**
 * The rating of a finished probe (12.3): green only when the ISO's recovery succeeded with a
 * verification that bears it out and the restored disks printed `RESTOW-PROBE-OK`; red only with
 * evidence (a problem of the backup in the recovery, a failed verification, a fixed failure pattern
 * of the boot); everything else (the lab, a time limit without a pattern, an ISO that did not end)
 * proves nothing.
 */
export function judgeBootProbe(
  recovery: ProbeRecoveryFacts | null,
  lab: LabResult,
): BootProbeJudgement {
  if (recovery && recovery.status === "failed") {
    if (recovery.verification?.result === "failed") {
      const checks = recovery.verification.checks
        .filter((check) => check.result === "failed")
        .map((check) => check.id);
      return { readiness: "red", cause: { kind: "verification_failed", checks } };
    }
    const codes = recovery.warnings.map((w) => w.code).filter((code) => BACKUP_PROBLEMS.has(code));
    if (codes.length > 0) {
      return { readiness: "red", cause: { kind: "recovery_failed", codes: [...new Set(codes)] } };
    }
    return { readiness: null, cause: { kind: "incomplete", reason: "recovery_failed" } };
  }
  if (lab.outcome === "lab_error") {
    return {
      readiness: null,
      cause: { kind: "incomplete", reason: lab.error?.code ?? "lab_error" },
    };
  }
  if (recovery?.status !== "succeeded") {
    return {
      readiness: null,
      cause: { kind: "incomplete", reason: `recovery_${recovery?.status ?? "missing"}` },
    };
  }
  if (recovery.verification === null || recovery.verification.result === "failed") {
    return { readiness: null, cause: { kind: "incomplete", reason: "verification_missing" } };
  }
  const reading = classifyProbeSerial(lab.bootSerial);
  if (reading.outcome === "ok" && lab.outcome === "booted") {
    return {
      readiness: "green",
      cause: { kind: "booted", bootId: reading.bootId, kernel: reading.kernel, line: reading.line },
    };
  }
  if (reading.outcome === "failed") {
    return {
      readiness: "red",
      cause: { kind: "boot_failed", pattern: reading.pattern, line: reading.line },
    };
  }
  return { readiness: null, cause: { kind: "incomplete", reason: lab.outcome } };
}

/** A boot probe report of a machine, as far as the due rule and the rating need it. */
export interface ProbeReportFacts {
  readiness: "green" | "red" | null;
  layoutFingerprint: string | null;
  bootChainFingerprint: string | null;
  checkedAt: Date;
  /** The worker found that these fingerprints cannot be probed (a report without a rating). */
  notPossible?: string | null;
}

export interface BootProbeDueInput {
  /** The fingerprints of the newest green stage 1 report. */
  layoutFingerprint: string;
  bootChainFingerprint: string;
  /** The machine's boot probe reports, newest first (any fingerprints). */
  probes: readonly ProbeReportFacts[];
  /** Someone asked for a probe on the machine's page. */
  requested: boolean;
  now: Date;
}

export type BootProbeDue =
  | { due: true; reason: "requested" | "fingerprint_changed" | "weekly" | "retry" }
  | { due: false };

function sameFingerprints(report: ProbeReportFacts, input: BootProbeDueInput): boolean {
  return (
    report.layoutFingerprint === input.layoutFingerprint &&
    report.bootChainFingerprint === input.bootChainFingerprint
  );
}

/**
 * When a machine with a green stage 1 gets a probe (12.3): at once when no probe was rated for its
 * current fingerprints, again a week after the last rated one, six hours after one that proved
 * nothing, and whenever someone asks.
 */
export function bootProbeDue(input: BootProbeDueInput): BootProbeDue {
  if (input.requested) return { due: true, reason: "requested" };
  const now = input.now.getTime();
  const same = input.probes.filter((report) => sameFingerprints(report, input));
  const rated = same.find((report) => report.readiness !== null);
  const latest = same[0];
  // Not possible for these fingerprints (too large, no systemd): only new ones change that.
  if (latest?.notPossible) return { due: false };
  if (latest && latest.readiness === null && now - latest.checkedAt.getTime() < PROBE_RETRY_MS) {
    return { due: false };
  }
  if (!rated) {
    return latest ? { due: true, reason: "retry" } : { due: true, reason: "fingerprint_changed" };
  }
  if (now - rated.checkedAt.getTime() >= PROBE_INTERVAL_MS) {
    return { due: true, reason: "weekly" };
  }
  return { due: false };
}

/** The rating input of the boot probe (12.4). */
export interface BaremetalProbeFacts {
  /** The machine's boot probe reports with the fingerprints of the newest stage 1, newest first. */
  probes: readonly ProbeReportFacts[];
  /** Why the newest stage 1 cannot be probed, or null. */
  notPossible: ProbeNotPossible | null;
  /** The lab: present (asked within {@link LAB_FRESH_MS}) and whether it has KVM. */
  lab: { present: boolean; kvm: boolean };
  /** A probe of the machine is planned (not leased) or runs now. */
  pending: "planned" | "running" | null;
}

export type ProbeRating =
  | { state: "green"; checkedAt: Date }
  | { state: "red"; checkedAt: Date }
  | { state: "overdue"; checkedAt: Date }
  | { state: "layout_checked"; reason: ProbePendingReason };

/**
 * What the boot probe makes of a machine whose stage 1 is green (table 12.4): `red` when the newest
 * rated probe with these fingerprints was red, `green` when it was green and at most 8 days old,
 * `overdue` when it was green but older, else `layout_checked` with the reason no probe proves the
 * boot yet.
 */
export function probeRating(facts: BaremetalProbeFacts, now: Date): ProbeRating {
  const rated = facts.probes.find((report) => report.readiness !== null);
  const recorded = facts.probes[0]?.notPossible;
  const notPossible =
    facts.notPossible ??
    ((PROBE_NOT_POSSIBLE as readonly string[]).includes(recorded ?? "")
      ? (recorded as ProbeNotPossible)
      : null);
  if (rated?.readiness === "red") return { state: "red", checkedAt: rated.checkedAt };
  if (rated?.readiness === "green") {
    return now.getTime() - rated.checkedAt.getTime() <= PROBE_VALID_MS
      ? { state: "green", checkedAt: rated.checkedAt }
      : { state: "overdue", checkedAt: rated.checkedAt };
  }
  if (notPossible) return { state: "layout_checked", reason: notPossible };
  if (facts.pending) return { state: "layout_checked", reason: facts.pending };
  if (!facts.lab.present) return { state: "layout_checked", reason: "no_lab" };
  if (!facts.lab.kvm) return { state: "layout_checked", reason: "no_kvm" };
  if (facts.probes[0]) return { state: "layout_checked", reason: "incomplete" };
  return { state: "layout_checked", reason: "planned" };
}

/** Whether the lab state an installation stored counts as present. */
export function labPresent(
  state: { seenAt: string; kvm: boolean } | null | undefined,
  now: Date,
): { present: boolean; kvm: boolean } {
  if (!state) return { present: false, kvm: false };
  const seen = Date.parse(state.seenAt);
  const present = Number.isFinite(seen) && now.getTime() - seen <= LAB_FRESH_MS;
  return { present, kvm: present && state.kvm };
}

/** The maximum restore size of a probe in bytes from `RESTOW_LAB_MAX_RESTORE_GIB`. */
export function labMaxRestoreBytes(gib: number | undefined): number {
  const value =
    gib !== undefined && Number.isFinite(gib) && gib > 0 ? gib : LAB_MAX_RESTORE_GIB_DEFAULT;
  return Math.floor(value * GIB);
}

/**
 * Sizes of the folders a probe may leave empty, from the same walk as the restore sizes: each
 * direct child of {@link PROBE_FOLDER_ROOTS}, all bytes below it. Hard links count every time
 * (only the order matters); at most {@link MAX_PROBE_FOLDERS} entries, the largest, are kept.
 */
export class ProbeFolderCounter {
  private readonly sizes = new Map<string, number>();

  add(node: { path: string; type: string; size: number | null }): void {
    if (node.type !== "file") return;
    for (const root of PROBE_FOLDER_ROOTS) {
      if (!node.path.startsWith(`${root}/`)) continue;
      const rest = node.path.slice(root.length + 1);
      const slash = rest.indexOf("/");
      if (slash <= 0) return; // a file directly in the root is no folder
      const folder = `${root}/${rest.slice(0, slash)}`;
      this.sizes.set(folder, (this.sizes.get(folder) ?? 0) + Math.max(0, node.size ?? 0));
      return;
    }
  }

  result(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [path, bytes] of [...this.sizes.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_PROBE_FOLDERS)) {
      out[path] = bytes;
    }
    return out;
  }
}
