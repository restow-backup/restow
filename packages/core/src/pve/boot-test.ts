/**
 * Boot tests of Proxmox VE restore points (docs/PVE.md, "Boot test"), the counterpart of a
 * SureBackup: the guest's node restores a restore point to a temporary guest with its network
 * cut, starts it, waits for the QEMU guest agent (a container: for its init), and destroys it
 * again. Pure rules shared by the API (readiness, "Boot test now"), the worker (planning,
 * alerts) and the web app: when a test is due, which node may run one, and how a result rates
 * a restore point. Green only for proof: the guest agent (or a container's init) answered.
 */

import { PVE_BLOCK_SIZE } from "./formats.js";

/** The capability a node announces in its heartbeat when it can run boot tests. */
export const PVE_BOOT_TEST_CAPABILITY = "boot_test";

/** Without a job's own limit, a guest that needs more memory than this (MiB) is not booted. */
export const DEFAULT_BOOT_TEST_MAX_MEMORY_MIB = 8192;
/** Without a job's own wait, the node waits this long for the guest agent. */
export const DEFAULT_BOOT_TEST_TIMEOUT_SECONDS = 300;
export const MIN_BOOT_TEST_TIMEOUT_SECONDS = 60;
export const MAX_BOOT_TEST_TIMEOUT_SECONDS = 3600;
export const MIN_BOOT_TEST_MEMORY_MIB = 256;
export const MAX_BOOT_TEST_MEMORY_MIB = 1024 * 1024;
/** A weekly boot test of a guest is due this long after its last one. */
export const BOOT_TEST_WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

export type PveBootTestScheduleKind = "off" | "weekly" | "after_backup";
export type PveBootTestOutcomeKind = "green" | "yellow" | "red" | "skipped" | "error";

/** The job setting as stored (any field may be missing). */
export interface PveBootTestSettingsInput {
  readonly schedule?: PveBootTestScheduleKind;
  readonly maxMemoryMiB?: number;
  readonly timeoutSeconds?: number;
}

export interface PveBootTestPlan {
  readonly schedule: PveBootTestScheduleKind;
  readonly maxMemoryMiB: number;
  readonly timeoutSeconds: number;
}

/** A job's boot test setting with its defaults: off unless the job turned it on. */
export function pveBootTestPlan(
  settings: PveBootTestSettingsInput | null | undefined,
): PveBootTestPlan {
  const schedule =
    settings?.schedule === "weekly" || settings?.schedule === "after_backup"
      ? settings.schedule
      : "off";
  const memory = settings?.maxMemoryMiB;
  const timeout = settings?.timeoutSeconds;
  return {
    schedule,
    maxMemoryMiB:
      typeof memory === "number" && Number.isFinite(memory)
        ? Math.min(Math.max(Math.round(memory), MIN_BOOT_TEST_MEMORY_MIB), MAX_BOOT_TEST_MEMORY_MIB)
        : DEFAULT_BOOT_TEST_MAX_MEMORY_MIB,
    timeoutSeconds:
      typeof timeout === "number" && Number.isFinite(timeout)
        ? Math.min(
            Math.max(Math.round(timeout), MIN_BOOT_TEST_TIMEOUT_SECONDS),
            MAX_BOOT_TEST_TIMEOUT_SECONDS,
          )
        : DEFAULT_BOOT_TEST_TIMEOUT_SECONDS,
  };
}

/** Whether a node declared a capability in its last heartbeat (older nodes declare none). */
export function pveNodeDeclares(
  facts: { readonly capabilities?: readonly string[] | null } | null | undefined,
  capability: string,
): boolean {
  return Array.isArray(facts?.capabilities) && facts.capabilities.includes(capability);
}

/** What the planner knows about a guest when it decides whether a boot test is due. */
export interface PveBootTestDueInput {
  readonly schedule: PveBootTestScheduleKind;
  /** When the guest's last boot test was planned or asked for; null: never. */
  readonly lastBootTestAt: Date | null;
  /** The newest restore point; null: nothing to test. */
  readonly newest: { readonly backupAt: Date; readonly tested: boolean } | null;
}

/**
 * Whether the newest restore point of a guest should be booted now: after every backup, as soon
 * as the newest point has no boot test yet (never twice the same point); weekly, a week after
 * the last test. Without a restore point, nothing is due.
 */
export function pveBootTestDue(input: PveBootTestDueInput, now: Date): boolean {
  if (input.schedule === "off" || !input.newest) {
    return false;
  }
  if (input.schedule === "after_backup") {
    return !input.newest.tested;
  }
  return (
    input.lastBootTestAt === null ||
    now.getTime() - input.lastBootTestAt.getTime() >= BOOT_TEST_WEEKLY_MS
  );
}

/** The parts of a boot test result the rating reads. */
export interface PveBootTestFact {
  readonly outcome: string;
  readonly checkedAt: string;
}

/**
 * The rating a boot test gives its restore point: green only when the guest agent answered (or
 * a container's init ran), yellow when the guest started and kept running without anything
 * inside answering, red when restore, start or boot failed. A skipped test, or one the node
 * could not carry out, rates nothing.
 */
export function pveBootTestRating(
  test: PveBootTestFact | null | undefined,
): "green" | "yellow" | "red" | null {
  if (!test || typeof test.checkedAt !== "string") {
    return null;
  }
  return test.outcome === "green" || test.outcome === "yellow" || test.outcome === "red"
    ? test.outcome
    : null;
}

/** The read-back check of a restore point (`pve_snapshots.verify`). */
export interface PveVerifyRating {
  readonly checkedAt: string;
  readonly mismatched: number;
  readonly errors: readonly string[];
}

export interface PveRestorePointRating {
  readonly readiness: "green" | "yellow" | "red" | null;
  /** When the deciding check ran; null while unrated. */
  readonly checkedAt: string | null;
  readonly basis: "verify" | "boot_test" | null;
}

/**
 * The rating of a guest's newest restore point from both checks Restow runs on it: the read-back
 * of a sample of its blocks and its boot test. Either one failing makes it red; a boot test
 * that proved the guest boots makes it green, one that saw the guest start without an answer
 * yellow; without a rated boot test, the read-back decides as before.
 */
export function pveRestorePointRating(
  verify: PveVerifyRating | null | undefined,
  bootTest: PveBootTestFact | null | undefined,
): PveRestorePointRating {
  const boot = pveBootTestRating(bootTest);
  const read =
    verify && typeof verify.checkedAt === "string"
      ? verify.mismatched > 0 || (verify.errors?.length ?? 0) > 0
        ? "red"
        : "green"
      : null;
  if (boot === "red" && bootTest) {
    return { readiness: "red", checkedAt: bootTest.checkedAt, basis: "boot_test" };
  }
  if (read === "red" && verify) {
    return { readiness: "red", checkedAt: verify.checkedAt, basis: "verify" };
  }
  if (boot && bootTest) {
    return { readiness: boot, checkedAt: bootTest.checkedAt, basis: "boot_test" };
  }
  if (read && verify) {
    return { readiness: read, checkedAt: verify.checkedAt, basis: "verify" };
  }
  return { readiness: null, checkedAt: null, basis: null };
}

/** The restore point fields a boot test task is built from (a subset of `pve_snapshots`). */
export interface PveBootTestPoint {
  readonly archiveName: string;
  readonly kind: "vm" | "ct";
  readonly byteSize: number;
  readonly disks: readonly { readonly size: number; readonly dataBlocks?: number }[];
}

/** The parameters of a node's `boot_test` task (docs/PVE-PROTOCOL.md). */
export interface PveBootTestTaskParams {
  readonly volname: string;
  readonly kind: "vm" | "ct";
  readonly vmid: number;
  readonly maxMemoryMiB: number;
  readonly timeoutSeconds: number;
  /** What the restore writes: a VM's stored (non-zero) blocks, a container's files. */
  readonly dataBytes: number;
  /** The size of all disks of a VM (a container: what it holds). */
  readonly diskBytes: number;
  readonly snapshotId: string;
}

export function pveBootTestTaskParams(
  point: PveBootTestPoint & { readonly id: string },
  vmid: number,
  plan: PveBootTestPlan,
): PveBootTestTaskParams {
  const diskBytes =
    point.kind === "vm" ? point.disks.reduce((sum, disk) => sum + disk.size, 0) : point.byteSize;
  const dataBytes =
    point.kind === "vm"
      ? Math.min(
          diskBytes,
          point.disks.reduce((sum, disk) => sum + (disk.dataBlocks ?? 0) * PVE_BLOCK_SIZE, 0),
        )
      : point.byteSize;
  return {
    volname: point.archiveName,
    kind: point.kind,
    vmid,
    maxMemoryMiB: plan.maxMemoryMiB,
    timeoutSeconds: plan.timeoutSeconds,
    dataBytes,
    diskBytes,
    snapshotId: point.id,
  };
}
