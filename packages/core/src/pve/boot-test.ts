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
/** The longest wait after skips for the same reason in a row (a week). */
export const PVE_RESTORE_TEST_SKIP_RETRY_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a skipped restore check waits before it is tried again: a day after the first skip,
 * then doubling while the node skips it for the same reason (1, 2, 4, then every 7 days). A
 * target storage that is missing stays missing until an admin acts, and each try writes a run
 * "Not checked" into the guest's history. `inARow` counts this skip and the ones for the same
 * reason right before it.
 */
export function pveRestoreCheckSkipRetryMs(inARow: number): number {
  const n = Math.max(1, Math.floor(inARow));
  return Math.min(
    PVE_RESTORE_TEST_SKIP_RETRY_MS * 2 ** (n - 1),
    PVE_RESTORE_TEST_SKIP_RETRY_MAX_MS,
  );
}
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

/**
 * Whether a restore point is of a privileged container. Restow restores containers only as
 * unprivileged (the node sends `unprivileged=1`): files with ids above 65535 and device nodes
 * of a privileged one would not restore, so its restore, restore check and boot test are not
 * started. Decided by the restore point's own configuration (`unprivileged: 1` in its main
 * section, before any `[snapshot]` section), not by what the guest is now; `fallback` (the
 * inventory's flag) only when the restore point carries no configuration.
 */
export function pveRestorePointPrivileged(
  point: { readonly kind: string; readonly guestConfig: string },
  fallback: boolean,
): boolean {
  if (point.kind !== "ct") {
    return false;
  }
  const main = point.guestConfig.split(/^\[/m)[0] ?? "";
  if (main.trim() === "") {
    return fallback;
  }
  const line = /^unprivileged:\s*(\S+)\s*$/m.exec(main);
  return line?.[1] !== "1";
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
 * node was short of memory or space at that moment, the boot test storage paused the copy with
 * an I/O error): the test is tried again. The other reasons (the guest needs more memory than
 * the job allows, the storage holds no guests of its kind, restores or boot tests are off on the
 * node) stay until someone changes something. A test the node could not carry out at all
 * (outcome `error`) is tried again as well.
 */
export const PVE_BOOT_TEST_TRANSIENT_REASONS: readonly string[] = [
  "backup_running",
  "boot_test_running",
  "node_memory",
  "storage_space",
  "node_resources",
  "storage_io_error",
];

/**
 * What a boot test's `reason` stands for (docs/PVE-PROTOCOL.md, "Task boot_test"), whatever
 * `outcome` the node sent beside it: every reason restow-pve sends (the constants of
 * agent/internal/pve/bootreasons.go; the test checks this table against them), the ones a node
 * before 0.5.0 still sends (`init_running`), and `node_error`, which the server records for a
 * test the node reported failed. Green is proof only: a reason that proves nothing never reads
 * green.
 *
 *   - green: the copy booted (its QEMU guest agent answered, systemd reports it running);
 *   - skipped: the node did not boot the copy, for a reason that says nothing about the restore
 *     point (it would reach out of the test: custom QEMU arguments, a host disk, a bridge that is
 *     not isolated; the node lacked memory, hugepages or space; an I/O error of the boot test
 *     storage paused the copy);
 *   - error: the test could not be carried out: grey, tried again, rates nothing;
 *   - yellow: it started, but nothing proved it booted to its services;
 *   - red: it did not boot (a restore or start that failed, a guest that stopped, panicked or
 *     failed in its virtual CPU, a container in systemd's emergency or rescue mode).
 *
 * A reason not listed here keeps the node's outcome (a newer node may know more).
 */
export const PVE_BOOT_TEST_REASON_OUTCOMES: Readonly<Record<string, PveBootTestOutcomeKind>> = {
  // proof that it booted
  agent_answered: "green",
  system_running: "green",
  // restow-pve before 0.5.0: a container whose init ran
  init_running: "green",
  // skipped before or instead of booting
  memory_limit: "skipped",
  node_memory: "skipped",
  node_resources: "skipped",
  storage_space: "skipped",
  storage_content: "skipped",
  storage_io_error: "skipped",
  no_storage: "skipped",
  backup_running: "skipped",
  boot_test_running: "skipped",
  restores_off: "skipped",
  boot_tests_off: "skipped",
  custom_qemu_args: "skipped",
  host_disk: "skipped",
  bridge_not_isolated: "skipped",
  // not carried out (the server's own reason)
  node_error: "error",
  // started, no proof
  no_guest_agent: "yellow",
  agent_not_answering: "yellow",
  guest_paused: "yellow",
  system_degraded: "yellow",
  system_starting: "yellow",
  system_unknown: "yellow",
  init_running_unverified: "yellow",
  init_unknown: "yellow",
  // did not boot
  restore_failed: "red",
  start_failed: "red",
  guest_stopped: "red",
  guest_panicked: "red",
  guest_internal_error: "red",
  system_maintenance: "red",
};

/**
 * The outcome a boot test result stands for ({@link PVE_BOOT_TEST_REASON_OUTCOMES}): a skipped
 * or error reason rates nothing, a red reason is red, a yellow reason takes a green down to
 * yellow (it never makes a red any better), and a green reason keeps the node's outcome (a
 * proof never makes anything better either). A reason not listed keeps the node's outcome.
 */
export function pveBootTestOutcomeOf(
  outcome: PveBootTestOutcomeKind,
  reason: string,
): PveBootTestOutcomeKind {
  const meant = PVE_BOOT_TEST_REASON_OUTCOMES[reason];
  if (meant === undefined || meant === "green") {
    return outcome;
  }
  if (meant === "yellow") {
    return outcome === "green" ? "yellow" : outcome;
  }
  return meant;
}
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
