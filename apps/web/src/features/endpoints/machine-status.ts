import type { EndpointSummary } from "./api.js";

/**
 * The state of a machine in one place (Inventory, 0.4.5, after the guests of 0.4.3): what the
 * table's State cell shows as ONE badge, what the detail panel lists in full and how the State
 * column sorts.
 *
 * Every fact about a machine becomes a {@link MachineStatus}; `machineStatuses` returns them by
 * priority (the order of {@link MACHINE_STATUS_ORDER}), the first one is the badge of the row.
 * What happens right now comes first, then what failed, then what only warns, then the quiet
 * states.
 *
 * Adding a state is three steps: a key in {@link MACHINE_STATUS_ORDER} at its priority, its tone
 * in {@link MACHINE_STATUS_META}, and a label `machineStatus.<key>` in en and de
 * (packages/i18n/resources/<lang>/endpoints.json).
 *
 * Green is proof (green-is-proof.test.ts): only `verified`, a newest backup a restore test or a
 * repository check rated green, is green, and not while the machine is in no job (an old backup
 * nothing renews). A backup that merely completed is the neutral outline.
 */

export const MACHINE_STATUS_ORDER = [
  "cancelling",
  "running",
  "busy",
  "revoked",
  "failed",
  "restore_failed",
  "repository_damaged",
  "silent",
  "backup_overdue",
  "partial",
  "no_job",
  "never_seen",
  "never",
  "restore_warning",
  "check_overdue",
  "interrupted",
  "offline",
  "unverified",
  "verified",
  "succeeded",
  "unknown",
] as const;

export type MachineStatusKey = (typeof MACHINE_STATUS_ORDER)[number];

/** Badge variants a state may use (components/ui/badge.tsx). */
export type MachineStatusTone =
  | "success"
  | "outline"
  | "info"
  | "warning"
  | "destructive"
  | "muted";

export const MACHINE_STATUS_META: Record<
  MachineStatusKey,
  { tone: MachineStatusTone; problem: boolean }
> = {
  cancelling: { tone: "warning", problem: false },
  running: { tone: "info", problem: false },
  // The agent works on something else (a restore, a restore test).
  busy: { tone: "info", problem: false },
  revoked: { tone: "muted", problem: false },
  failed: { tone: "destructive", problem: true },
  restore_failed: { tone: "destructive", problem: true },
  repository_damaged: { tone: "destructive", problem: true },
  silent: { tone: "warning", problem: true },
  backup_overdue: { tone: "warning", problem: true },
  partial: { tone: "warning", problem: true },
  no_job: { tone: "warning", problem: true },
  never_seen: { tone: "warning", problem: true },
  never: { tone: "warning", problem: true },
  restore_warning: { tone: "warning", problem: true },
  check_overdue: { tone: "warning", problem: false },
  // The agent restarted during the backup and carries on: neither failed nor done.
  interrupted: { tone: "info", problem: false },
  offline: { tone: "muted", problem: false },
  unverified: { tone: "muted", problem: false },
  verified: { tone: "success", problem: false },
  succeeded: { tone: "outline", problem: false },
  unknown: { tone: "muted", problem: false },
};

export interface MachineStatus {
  key: MachineStatusKey;
  tone: MachineStatusTone;
  problem: boolean;
}

type StatusMachine = Pick<
  EndpointSummary,
  | "status"
  | "connection"
  | "agentState"
  | "lastBackupAt"
  | "latestRun"
  | "readiness"
  | "attention"
  | "job"
>;

/** Every state that applies to the machine, highest priority first (never empty). */
export function machineStatuses(machine: StatusMachine): MachineStatus[] {
  const keys = new Set<MachineStatusKey>();
  const run = machine.latestRun;
  const active = machine.status === "active";
  const attention = new Set<string>(machine.attention);
  if (!active) {
    keys.add("revoked");
  }
  if (active && run?.status === "running") {
    if (run.kind === "backup" && run.cancelRequestedAt) {
      keys.add("cancelling");
    } else {
      keys.add(run.kind === "backup" ? "running" : "busy");
    }
  } else if (active && machine.agentState === "running") {
    keys.add("busy");
  }
  const lastBackup = run?.kind === "backup" ? run : null;
  if (lastBackup?.status === "failed") {
    keys.add(lastBackup.interruptedOnly ? "interrupted" : "failed");
  } else if (attention.has("last_backup_failed")) {
    keys.add("failed");
  }
  if (lastBackup?.status === "partial") {
    keys.add("partial");
  }
  if (attention.has("restore_test_failed") || machine.readiness.state === "red") {
    keys.add("restore_failed");
  }
  if (attention.has("repository_damaged")) {
    keys.add("repository_damaged");
  }
  if (active && attention.has("silent")) {
    keys.add("silent");
  }
  if (active && attention.has("backup_overdue")) {
    keys.add("backup_overdue");
  }
  if (active && (attention.has("no_job") || machine.job === null)) {
    keys.add("no_job");
  }
  if (active && (attention.has("never_seen") || machine.connection === "never")) {
    keys.add("never_seen");
  }
  if (!machine.lastBackupAt && run?.status !== "running") {
    keys.add("never");
  }
  if (machine.readiness.state === "yellow") {
    keys.add("restore_warning");
  }
  if (machine.readiness.overdue && machine.readiness.state !== "no_backup") {
    keys.add("check_overdue");
  }
  if (active && machine.connection === "offline" && !keys.has("silent")) {
    keys.add("offline");
  }
  // A machine in no job keeps an old rating nothing renews: never green then.
  // (`job` is absent on servers before 0.2.0: not known to be in no job.)
  const inJob = machine.job !== null;
  if (machine.readiness.state === "green" && inJob && active) {
    keys.add("verified");
  } else if (machine.readiness.state === "unverified" && machine.lastBackupAt) {
    keys.add("unverified");
  }
  if (machine.lastBackupAt && !keys.has("failed") && !keys.has("partial")) {
    keys.add("succeeded");
  }
  if (keys.size === 0) {
    keys.add("unknown");
  }
  return MACHINE_STATUS_ORDER.filter((key) => keys.has(key)).map((key) => ({
    key,
    ...MACHINE_STATUS_META[key],
  }));
}

/** Sort rank of a machine's state: its primary state's priority (lower is more urgent). */
export function machineStatusRank(statuses: readonly MachineStatus[]): number {
  const first = statuses[0];
  return first ? MACHINE_STATUS_ORDER.indexOf(first.key) : MACHINE_STATUS_ORDER.length;
}
