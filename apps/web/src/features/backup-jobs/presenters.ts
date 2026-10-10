import type { TFunction } from "i18next";
import { Cloud, Inbox, Laptop, type LucideIcon, Mail, Network, Server } from "lucide-react";

import type { StatusTone } from "@/components/kit";
import { describeCadence } from "@/features/schedules/presenters";

import type {
  BackupJob,
  CopyJobInfo,
  JobKind,
  JobMember,
  JobRestoreCheck,
  JobSchedule,
  JobScope,
  JobState,
  MemberKind,
  Repository,
  RunBackupJobResult,
} from "./api.js";
import { cadenceOfJobSchedule } from "./form.js";

/**
 * Presentation of jobs: the words for a schedule, a scope, a restore check, a
 * state, a last and a next run. Pure functions over the API's shapes, kept free
 * of React so they are unit-tested directly. `t` is bound to the backupjobs
 * namespace, `tSchedules` to the schedules namespace (the words of a cadence).
 */

// --- Kinds --------------------------------------------------------------------------------

/** One icon per meaning (icons table of the 0.2.0 plan): mailbox, OneDrive, IMAP account, server, client. */
export const MEMBER_KIND_ICON: Readonly<Record<MemberKind, LucideIcon>> = {
  mailbox: Mail,
  onedrive: Cloud,
  imap: Inbox,
  server: Server,
  client: Laptop,
  smb: Network,
  nfs: Network,
};

/** The kinds of object or machine a job of this kind holds, in the order a summary lists them. */
export const MEMBER_KINDS_OF: Readonly<Record<JobKind, readonly MemberKind[]>> = {
  mail: ["mailbox", "onedrive", "imap"],
  endpoint: ["server", "client"],
  share: ["smb", "nfs"],
  copy: [],
};

// --- Schedule --------------------------------------------------------------------------------

export interface ScheduleText {
  t: TFunction;
  tSchedules: TFunction;
  language: string;
}

/** How often a job runs, in words ("Every 8 hours", "Daily at 02:00", "On connect, at most every 4 hours"). */
export function describeJobSchedule(schedule: JobSchedule | null, ctx: ScheduleText): string {
  const { t, tSchedules, language } = ctx;
  if (!schedule) {
    return t("schedule.manual");
  }
  switch (schedule.kind) {
    case "on_connect": {
      const minutes = schedule.intervalMinutes;
      if (minutes === undefined) {
        return t("schedule.onConnect");
      }
      return minutes % 60 === 0
        ? t("schedule.onConnectHours", { count: minutes / 60 })
        : t("schedule.onConnectMinutes", { count: minutes });
    }
    default: {
      const cadence = cadenceOfJobSchedule(schedule);
      return cadence ? describeCadence(cadence, tSchedules, language) : t("schedule.manual");
    }
  }
}

/** Whether the zone matters for reading the schedule (clock times: daily, cron). */
export function scheduleUsesZone(schedule: JobSchedule | null): boolean {
  return schedule !== null && (schedule.kind === "cron" || schedule.kind === "daily");
}

// --- Scope ------------------------------------------------------------------------------------

/**
 * What a job covers: "214 mailboxes, 6 OneDrives" or "3 servers"; "Nothing yet" for an
 * empty scope.
 */
export function describeScope(
  scope: Pick<JobScope, "count" | "byKind">,
  kind: JobKind,
  t: TFunction,
  copy?: Pick<CopyJobInfo, "source" | "target" | "targetFolder"> | null,
): string {
  if (kind === "copy" && copy) {
    return t("scope.copyRoute", {
      source: copy.source.name,
      target: copy.target.name,
      folder: copy.targetFolder ? `/${copy.targetFolder}` : "/",
    });
  }
  if (scope.count === 0) {
    return t("scope.nothing");
  }
  const parts = MEMBER_KINDS_OF[kind]
    .filter((memberKind) => (scope.byKind[memberKind] ?? 0) > 0)
    .map((memberKind) => t(`scope.kinds.${memberKind}`, { count: scope.byKind[memberKind] ?? 0 }));
  // A kind the client does not know yet still counts: the rest is "others".
  const known = MEMBER_KINDS_OF[kind].reduce(
    (sum, memberKind) => sum + (scope.byKind[memberKind] ?? 0),
    0,
  );
  if (known < scope.count) {
    parts.push(t("scope.kinds.other", { count: scope.count - known }));
  }
  return parts.join(", ");
}

/** The second line under a scope: "All of them, new ones included", or what differs. */
export function scopeNote(
  job: Pick<BackupJob, "scopeMode" | "scope" | "kind">,
  t: TFunction,
): string | null {
  const parts: string[] = [];
  if (job.scopeMode === "all") {
    parts.push(t("scope.allLine"));
  }
  if (job.scope.overrides > 0) {
    parts.push(t("scope.overridesNote", { count: job.scope.overrides }));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// --- State --------------------------------------------------------------------------------------

export interface StateView {
  tone: StatusTone;
  /** `backupjobs:state.<key>`. */
  key: JobState;
  live: boolean;
}

/**
 * The badge of a job's state. A running job is Lapis (info), a queued one waits (muted), problems are amber or
 * red, a job that is merely fine is the neutral outline: green is for a restore
 * check that passed, which is what the restore check column says.
 */
export function stateView(state: JobState): StateView {
  switch (state) {
    case "paused":
      return { tone: "muted", key: state, live: false };
    case "failing":
      return { tone: "destructive", key: state, live: false };
    case "running":
      return { tone: "info", key: state, live: true };
    case "queued":
      return { tone: "muted", key: state, live: false };
    case "attention":
      return { tone: "warning", key: state, live: false };
    case "empty":
      return { tone: "muted", key: state, live: false };
    // Each of these looks active but backs up nothing on its own: never the neutral "Active".
    case "storage_error":
      return { tone: "destructive", key: state, live: false };
    case "overdue":
    case "manual":
      return { tone: "warning", key: state, live: false };
    default:
      return { tone: "neutral", key: "ok", live: false };
  }
}

// --- Restore check -------------------------------------------------------------------------------

export interface RestoreCheckView {
  tone: StatusTone;
  /** What is checked: every object or machine of the scope. */
  total: number;
  passed: number;
  /** The facts that are not "passed", in the order of their weight; the badge's tooltip lists them. */
  details: { key: "failed" | "warning" | "unverified" | "noBackup"; count: number }[];
  /** `none`: nothing in scope to check. */
  state: "none" | "passed" | "attention" | "failed";
}

/**
 * The restore checks of a scope in one badge: "5 of 6 passed". Green only when
 * every object passed, red when one failed, amber for warnings, objects not
 * checked yet and objects without a backup.
 */
export function restoreCheckView(check: JobRestoreCheck): RestoreCheckView {
  const details = (
    [
      ["failed", check.failed],
      ["warning", check.warning],
      ["unverified", check.unverified],
      ["noBackup", check.noBackup],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, count }));
  const base = { total: check.total, passed: check.passed, details };
  if (check.total === 0) {
    return { ...base, tone: "muted", state: "none" };
  }
  if (check.failed > 0) {
    return { ...base, tone: "destructive", state: "failed" };
  }
  if (check.passed === check.total) {
    return { ...base, tone: "success", state: "passed" };
  }
  return { ...base, tone: "warning", state: "attention" };
}

// --- Runs -------------------------------------------------------------------------------------------

export interface LastRunView {
  at: string | null;
  running: number;
  queued: number;
  failed: number;
  partial: number;
  /** Nothing ran yet and nothing runs: "No backup yet". */
  never: boolean;
}

export function lastRunView(job: Pick<BackupJob, "lastRun">): LastRunView {
  const { at, running, queued, failed, partial } = job.lastRun;
  return {
    at,
    running,
    queued,
    failed,
    partial,
    never: at === null && running === 0 && queued === 0 && failed === 0,
  };
}

export type NextRunView =
  | { kind: "at"; at: string }
  | { kind: "overdue"; at: string }
  | { kind: "paused" }
  | { kind: "manual" }
  | { kind: "onConnect" }
  | { kind: "empty" }
  | { kind: "unknown" };

/** A planned run this far in the past did not happen (the API's `OVERDUE_GRACE_MS`). */
export const OVERDUE_GRACE_MS = 60 * 60_000;

/**
 * When a job runs next, or why it does not say. A planned run long past is "overdue", not a
 * plain relative time: nothing ran when it should have.
 */
export function nextRunView(
  job: Pick<BackupJob, "enabled" | "schedule" | "nextRunAt" | "scope">,
  now: number = Date.now(),
): NextRunView {
  if (!job.enabled) return { kind: "paused" };
  if (job.nextRunAt) {
    const at = Date.parse(job.nextRunAt);
    if (job.schedule?.kind !== "on_connect" && now - at > OVERDUE_GRACE_MS) {
      return { kind: "overdue", at: job.nextRunAt };
    }
    return { kind: "at", at: job.nextRunAt };
  }
  if (job.schedule === null) return { kind: "manual" };
  if (job.scope.count === 0) return { kind: "empty" };
  if (job.schedule.kind === "on_connect") return { kind: "onConnect" };
  return { kind: "unknown" };
}

// --- What the actions say ----------------------------------------------------------------------------------

/** A machine job cannot be paused: the agent decides when to back up. A mail job can. */
export function canPause(job: Pick<BackupJob, "kind">): boolean {
  return job.kind === "mail";
}

/** What can be offered to switch a job: pause a mail job that runs, resume any job that is off. */
export function switchAction(job: Pick<BackupJob, "kind" | "enabled">): "pause" | "resume" | null {
  if (!job.enabled) return "resume";
  return canPause(job) ? "pause" : null;
}

/** The repository in words: its name, or the installation's default. */
export function repositoryLabel(repository: Repository, t: TFunction): string {
  if (repository.kind === "installation_default" || repository.name === null) {
    return t("repository.installationDefault");
  }
  return repository.name;
}

/** The retention of a job in words: the policy of a mail job, the numbers of a machine job. */
export function retentionLabel(job: Pick<BackupJob, "kind" | "retention">, t: TFunction): string {
  if (job.kind === "mail") {
    return job.retention.policyName
      ? job.retention.policyId
        ? job.retention.policyName
        : t("retention.tenantDefaultNamed", { name: job.retention.policyName })
      : t("retention.tenantDefault");
  }
  if (job.kind === "copy") {
    return t("retention.copy");
  }
  const keep = job.retention.keep;
  return keep ? t("retention.keep", { ...keep }) : t("retention.machineOwn");
}

// --- Members ----------------------------------------------------------------------------------------------

/** Whether a member's last backup needs a word: running, failed or partial. */
export function memberOutcomeTone(outcome: JobMember["lastBackup"]["outcome"]): StatusTone | null {
  switch (outcome) {
    case "running":
      return "info";
    case "failed":
      return "destructive";
    case "partial":
      return "warning";
    case "queued":
      return "muted";
    default:
      return null;
  }
}

export type PendingBackupView =
  | { kind: "starting" }
  | { kind: "waiting"; minutes: number }
  /** The check-in is due or unknown: the machine starts it with its next contact. */
  | { kind: "due" };

/**
 * What a requested backup that has not started says: on the machine already ("starting"), or
 * waiting for its next check-in, in whole minutes rounded up.
 */
export function pendingBackupView(
  pending: NonNullable<JobMember["pendingBackup"]>,
  now: number,
): PendingBackupView {
  if (pending.status === "delivered") {
    return { kind: "starting" };
  }
  const at = pending.nextCheckInAt ? Date.parse(pending.nextCheckInAt) : Number.NaN;
  if (Number.isNaN(at) || at <= now) {
    return { kind: "due" };
  }
  return { kind: "waiting", minutes: Math.max(1, Math.ceil((at - now) / 60_000)) };
}

/**
 * What the toast of "Run now" says. When every backup asked for already waits (a machine's request
 * until its next check-in, a mail backup in the queue or running), that is "waiting", not
 * "nothing started".
 */
export type RunOutcomeView = "queued" | "waiting" | "nothing";

export function runOutcomeView(
  result: Pick<RunBackupJobResult, "queued" | "skipped">,
): RunOutcomeView {
  if (result.queued > 0) {
    return "queued";
  }
  if (
    result.skipped.length > 0 &&
    result.skipped.every((entry) => entry.reason === "already_queued")
  ) {
    return "waiting";
  }
  return "nothing";
}
