import { Ban, type LucideIcon, Moon, ShieldEllipsis, UserX, WifiOff } from "lucide-react";

import {
  READINESS_CATEGORY_META,
  READINESS_FLAG_META,
  RUN_STATUS_META,
  STATUS_TONE_ICON,
  STORAGE_INTEGRITY_META,
  type StatusMeta,
  type StatusTone,
  toneOf,
} from "@/components/kit";

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
 * Adding a state is three steps: a key in {@link MACHINE_STATUS_ORDER} at its priority, its look
 * in {@link MACHINE_STATUS_META}, and a label `machineStatus.<key>` in en and de
 * (packages/i18n/resources/<lang>/endpoints.json).
 *
 * The look of a state is the status meta's (components/kit/status-meta.ts) wherever the state is
 * one of its facts (UI rework, phase 1): a readiness category, a readiness flag, a run, a storage
 * check. Needs attention (orange) and Unverified (amber) differ by tone and icon, as everywhere;
 * the attention list of the machine (presenters.ts) takes its tones from this table, so the two
 * cannot drift apart.
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
  "revoke_suggested",
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

/** The tone of a state (status-badge.tsx); the badge maps it to its variant. */
export type MachineStatusTone = StatusTone;

/** How a state looks: its tone and icon, whether it is live, and whether it is a problem. */
export interface MachineStatusLook {
  tone: MachineStatusTone;
  icon: LucideIcon;
  /** Something runs right now: a pulsing dot instead of the icon. */
  live?: boolean;
  problem: boolean;
}

/** The look of a status meta entry. */
function fromMeta(meta: StatusMeta, problem: boolean): MachineStatusLook {
  return { tone: toneOf(meta), icon: meta.icon, live: meta.live, problem };
}

/** A machine-only state (no status meta family has it): its tone, and the tone's icon by default. */
function local(
  tone: MachineStatusTone,
  problem: boolean,
  icon: LucideIcon = STATUS_TONE_ICON[tone],
  live?: boolean,
): MachineStatusLook {
  return { tone, icon, live, problem };
}

export const MACHINE_STATUS_META: Readonly<Record<MachineStatusKey, MachineStatusLook>> = {
  cancelling: local("warning", false, STATUS_TONE_ICON.warning, true),
  running: fromMeta(RUN_STATUS_META.running, false),
  // The agent works on something else (a restore, a restore test).
  busy: local("info", false, STATUS_TONE_ICON.info, true),
  revoked: local("muted", false, Ban),
  failed: fromMeta(RUN_STATUS_META.failed, true),
  restore_failed: fromMeta(READINESS_CATEGORY_META.red, true),
  repository_damaged: fromMeta(STORAGE_INTEGRITY_META.corrupt, true),
  // Facts a person must look at (the attention tone, as in the machine's attention list).
  silent: local("attention", true, Moon),
  backup_overdue: fromMeta(READINESS_FLAG_META.overdue, true),
  partial: fromMeta(RUN_STATUS_META.partial, true),
  no_job: fromMeta(READINESS_FLAG_META.noJob, true),
  never_seen: local("attention", true, WifiOff),
  // No contact for longer than the machine's `revokeHintAfterDays` (#65): revoke, then remove.
  revoke_suggested: local("attention", true, UserX),
  // Never backed up (an open point of the UI rework: amber like a first backup still to come).
  never: local("warning", true, ShieldEllipsis),
  // The machine's readiness: a restore check found something (Needs attention, orange).
  restore_warning: fromMeta(READINESS_CATEGORY_META.yellow, true),
  check_overdue: fromMeta(READINESS_FLAG_META.overdue, false),
  // The agent restarted during the backup and carries on: neither failed nor done.
  interrupted: fromMeta(RUN_STATUS_META.incomplete, false),
  offline: local("muted", false, WifiOff),
  // A backup no restore test has read back is not proven (Unverified, amber).
  unverified: fromMeta(READINESS_CATEGORY_META.unverified, false),
  verified: fromMeta(READINESS_CATEGORY_META.green, false),
  succeeded: fromMeta(RUN_STATUS_META.succeeded, false),
  unknown: local("muted", false),
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
  if (active && attention.has("revoke_suggested")) {
    keys.add("revoke_suggested");
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
    tone: MACHINE_STATUS_META[key].tone,
    problem: MACHINE_STATUS_META[key].problem,
  }));
}

/** Sort rank of a machine's state: its primary state's priority (lower is more urgent). */
export function machineStatusRank(statuses: readonly MachineStatus[]): number {
  const first = statuses[0];
  return first ? MACHINE_STATUS_ORDER.indexOf(first.key) : MACHINE_STATUS_ORDER.length;
}
