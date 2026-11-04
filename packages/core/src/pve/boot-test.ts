/**
 * Boot tests of Proxmox VE restore points (docs/PVE.md, "Boot test"): the guest's node restores a restore point to a temporary guest with its network
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

/** A job's restore check (docs/PVE.md): one guest a month is restored, checked and removed. */
export const PVE_RESTORE_TEST_EVERY_MS = 30 * 24 * 60 * 60 * 1000;
/** A restore check the node could not carry out (skipped, with its reason) is tried again after. */
export const PVE_RESTORE_TEST_SKIP_RETRY_MS = 24 * 60 * 60 * 1000;
/** A node silent for longer than this gets no new restore check or boot test. */
export const PVE_NODE_SEEN_FOR_CHECKS_MS = 10 * 60 * 1000;

/**
 * Why a node cannot run a guest's restore check now: restores are switched off on it, or it
 * has not been seen lately (it would only wait and expire). Null: it can.
 */
export function pveRestoreCheckBlocker(
  node: { facts: { restoresAllowed?: boolean }; lastSeenAt: Date | null } | null,
  now: Date,
): "no_node" | "restores_off" | "node_offline" | null {
  if (!node) {
    return "no_node";
  }
  if (node.facts.restoresAllowed === false) {
    return "restores_off";
  }
  if (!node.lastSeenAt || now.getTime() - node.lastSeenAt.getTime() > PVE_NODE_SEEN_FOR_CHECKS_MS) {
    return "node_offline";
  }
  return null;
}

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

/**
 * Why a node skipped a boot test, when the reason passes (another backup or boot test ran, the
 * node was short of memory or space at that moment): the test is tried again. The other reasons
 * (the guest needs more memory than the job allows, the storage holds no guests of its kind,
 * restores or boot tests are off on the node) stay until someone changes something. A test the
 * node could not carry out at all (outcome `error`) is tried again as well.
 */
export const PVE_BOOT_TEST_TRANSIENT_REASONS: readonly string[] = [
  "backup_running",
  "boot_test_running",
  "node_memory",
  "storage_space",
];
/** The first retry of a boot test that did not come to a result waits this long, then doubling. */
export const PVE_BOOT_TEST_RETRY_FIRST_MS = 30 * 60 * 1000;
/** No retry waits longer than this. */
export const PVE_BOOT_TEST_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
/** Attempts per restore point before the planner gives up on it (its next one is tried anew). */
export const PVE_BOOT_TEST_MAX_ATTEMPTS = 5;

/** A boot test run of one restore point, as the planner reads it. */
export interface PveBootTestAttempt {
  /** Its outcome; null while it runs, or for a run closed without one. */
  readonly outcome: string | null;
  readonly reason: string;
  readonly startedAt: Date;
}

/** Whether a boot test attempt passes without a result that the next attempt may change. */
export function pveBootTestTransient(attempt: Pick<PveBootTestAttempt, "outcome" | "reason">) {
  return (
    attempt.outcome === "error" ||
    (attempt.outcome === "skipped" && PVE_BOOT_TEST_TRANSIENT_REASONS.includes(attempt.reason))
  );
}

/**
 * What the boot test runs of a restore point (newest first) say for the planner: `tested` when
 * one came to an outcome that stands (green, yellow, red, a permanent skip), one is going, or
 * the attempts are used up; otherwise, after a transient skip or an error, `retryAt` is when the
 * next attempt is due (30 minutes, doubling, at most 6 hours). Only the attempts since the last
 * outcome that stands count.
 */
export function pveBootTestRetry(
  attempts: readonly PveBootTestAttempt[],
  limits: { firstMs?: number; maxMs?: number; maxAttempts?: number } = {},
): { tested: boolean; retryAt: Date | null; attempts: number; gaveUp: boolean } {
  const first = limits.firstMs ?? PVE_BOOT_TEST_RETRY_FIRST_MS;
  const max = limits.maxMs ?? PVE_BOOT_TEST_RETRY_MAX_MS;
  const most = limits.maxAttempts ?? PVE_BOOT_TEST_MAX_ATTEMPTS;
  const lead: PveBootTestAttempt[] = [];
  for (const attempt of attempts) {
    if (!pveBootTestTransient(attempt)) {
      break;
    }
    lead.push(attempt);
  }
  const latest = lead[0];
  if (!latest) {
    return { tested: attempts.length > 0, retryAt: null, attempts: 0, gaveUp: false };
  }
  if (lead.length >= most) {
    return { tested: true, retryAt: null, attempts: lead.length, gaveUp: true };
  }
  const wait = Math.min(first * 2 ** (lead.length - 1), max);
  return {
    tested: false,
    retryAt: new Date(latest.startedAt.getTime() + wait),
    attempts: lead.length,
    gaveUp: false,
  };
}

/**
 * How long a guest whose job boot-tests it may go without a boot test that came to an outcome
 * before `boot_test.skipped` is raised: two days after every backup, eight days weekly.
 */
export function pveBootTestOverdueMs(schedule: PveBootTestScheduleKind): number | null {
  if (schedule === "after_backup") {
    return 2 * 24 * 60 * 60 * 1000;
  }
  if (schedule === "weekly") {
    return 8 * 24 * 60 * 60 * 1000;
  }
  return null;
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
  readonly checkedAt?: string | null;
  readonly mismatched: number;
  readonly errors: readonly string[];
  /** The check could not run (the repository was locked); `gaveUpAt` once the worker gave up. */
  readonly notChecked?: { readonly gaveUpAt?: string | null } | null;
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
 * yellow; without a rated boot test, the read-back decides as before (yellow when it could not
 * run at all because the repository stayed locked).
 */
export function pveRestorePointRating(
  verify: PveVerifyRating | null | undefined,
  bootTest: PveBootTestFact | null | undefined,
): PveRestorePointRating {
  const boot = pveBootTestRating(bootTest);
  // A check that could not run (the repository stayed locked) is yellow: nothing is known.
  const gaveUpAt = verify?.notChecked?.gaveUpAt;
  const readAt = typeof gaveUpAt === "string" ? gaveUpAt : verify?.checkedAt;
  const read =
    typeof gaveUpAt === "string"
      ? "yellow"
      : verify && typeof verify.checkedAt === "string"
        ? verify.mismatched > 0 || (verify.errors?.length ?? 0) > 0
          ? "red"
          : "green"
        : null;
  if (boot === "red" && bootTest) {
    return { readiness: "red", checkedAt: bootTest.checkedAt, basis: "boot_test" };
  }
  if (read === "red" && typeof readAt === "string") {
    return { readiness: "red", checkedAt: readAt, basis: "verify" };
  }
  if (boot && bootTest) {
    return { readiness: boot, checkedAt: bootTest.checkedAt, basis: "boot_test" };
  }
  if (read && typeof readAt === "string") {
    return { readiness: read, checkedAt: readAt, basis: "verify" };
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
