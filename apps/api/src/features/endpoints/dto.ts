import { createHash } from "node:crypto";
import {
  type Connection,
  DEFAULT_CLIENT_STALE_DAYS,
  DEFAULT_ENDPOINT_RETENTION,
  DEFAULT_SERVER_STALE_HOURS,
  type EndpointQuotaLimits,
  type QuotaLevel,
  type SnapshotFlagReason,
  backupOverdueCause,
  connectionOf,
  endpointBudgetBytes,
  endpointStaleness,
  isInterruptedOnly,
  quotaLevelOf,
  repositoryDamagedCause,
  silentCause,
} from "@restow/core";
import type {
  Endpoint,
  EndpointConfig,
  EndpointHookPolicy,
  EndpointReport,
  EndpointRetention,
  EndpointRun,
  EndpointSettings,
  EndpointTask,
} from "@restow/db";
import { type FailureDto, causeToFailureDto, failureDto } from "../failures/dto.js";
import type { EndpointReadinessDto } from "./readiness.js";

/**
 * The shapes of the session API `/api/v1/endpoints` (the web app reads
 * exactly these). Dates are ISO strings; nothing here is secret: the agent
 * secret and the repository password are never part of a response.
 */

/** Why an endpoint needs attention, machine-readable; the web app words them. */
export type EndpointAttention =
  | "silent"
  | "backup_overdue"
  | "last_backup_failed"
  | "restore_test_failed"
  | "repository_damaged"
  | "never_seen";

export interface ReadinessDto {
  state: EndpointReadinessDto["state"];
  checkedAt: string | null;
  overdue: boolean;
  basis: EndpointReadinessDto["basis"];
  latestSnapshotId: string | null;
}

export interface RunSummaryDto {
  id: string;
  kind: EndpointRun["kind"];
  status: EndpointRun["status"];
  startedAt: string;
  finishedAt: string | null;
  snapshotId: string | null;
  errorCount: number;
  /**
   * The run ended only because the agent was restarted (every error is the
   * code `interrupted`): the agent carries on by itself, so it is no failed
   * backup and is shown neutrally (docs/AGENT.md, error codes of a run).
   */
  interruptedOnly: boolean;
  /**
   * A restore test on the machine (`verify_sample`) that ended without a
   * rating: it could not complete (the agent was stopped or went silent, the
   * machine had no room for the temporary copy, restic could not reach the
   * repository) and proves nothing about the backup, so it is shown neutrally,
   * never as a failure. The server offers the test again (docs/AGENT.md,
   * restore test). False for every other run, and for a test a report rated
   * green or red.
   */
  checkIncomplete: boolean;
  /** Why the run did not end well, explained; null for a good run. */
  failure: FailureDto | null;
  filesNew: number | null;
  dataAdded: number | null;
  totalBytesProcessed: number | null;
  progress: EndpointRun["progress"];
}

export interface EndpointSummaryDto {
  id: string;
  hostname: string;
  displayName: string | null;
  os: Endpoint["os"];
  arch: Endpoint["arch"];
  profile: Endpoint["profile"];
  agentVersion: string | null;
  osVersion: string | null;
  status: Endpoint["status"];
  connection: Connection;
  agentState: "idle" | "running" | null;
  lastSeenAt: string | null;
  lastBackupAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  readiness: ReadinessDto;
  latestRun: RunSummaryDto | null;
  attention: EndpointAttention[];
  /** The backup job the machine belongs to; null for a machine in no job. */
  job: { id: string; name: string } | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface RunDetailDto extends RunSummaryDto {
  taskId: string | null;
  errors: EndpointRun["errors"];
  logTail: string | null;
  stats: EndpointRun["stats"];
}

export interface TaskDto {
  id: string;
  kind: EndpointTask["kind"];
  status: EndpointTask["status"];
  params: Record<string, unknown>;
  createdAt: string;
  deliveredAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  /**
   * A restore-test request (`verify_sample`) that failed without a rating: it
   * expired, the machine was revoked, the agent stopped reporting, or its run
   * could not complete. Like `RunSummaryDto.checkIncomplete`, it proves
   * nothing about the backup; a request whose test found the backup damaged
   * is `false`.
   */
  checkIncomplete: boolean;
}

export interface ReportDto {
  id: string;
  kind: EndpointReport["kind"];
  origin: EndpointReport["origin"];
  snapshotId: string | null;
  readiness: EndpointReport["readiness"];
  summary: EndpointReport["summary"];
  checkedAt: string;
}

export interface EffectiveSettingsDto {
  retention: EndpointRetention;
  staleAfterHours: number;
  staleAfterDays: number;
  /** The endpoint's own storage budget in GiB; null when the installation's default applies. */
  quotaGib: number | null;
}

/** What the repository takes in the storage and what it may take (docs/AGENT.md, "Speicherbudget"). */
export interface EndpointStorageDto {
  /** Bytes the repository takes; null until it was first measured. */
  usedBytes: number | null;
  measuredAt: string | null;
  /** The budget of this endpoint in bytes; null when there is none. */
  budgetBytes: number | null;
  /** The endpoint has a budget of its own (else the installation's default applies). */
  ownBudget: boolean;
  /** The installation's default budget of one endpoint; null when there is none. */
  defaultBudgetBytes: number | null;
  /** All endpoint repositories of the tenant together, and their common budget. */
  tenantUsedBytes: number;
  tenantBudgetBytes: number | null;
  /** `near` from 90 percent of a budget; `exceeded` when one is used up or an upload was refused today. */
  level: QuotaLevel;
  /** The last upload refused because a budget was used up. */
  refusedAt: string | null;
}

/** One reason an endpoint needs attention, explained. */
export interface EndpointProblemDto {
  attention: EndpointAttention;
  failure: FailureDto;
}

export interface EndpointDetailDto extends EndpointSummaryDto {
  config: EndpointConfig;
  configVersion: number;
  /** The configuration version the agent runs; differs from `configVersion` until it fetched the change. */
  agentConfigVersion: number | null;
  settings: EffectiveSettingsDto;
  /** What needs attention, each with its explanation and what to do (`attention` names them). */
  problems: EndpointProblemDto[];
  runs: RunSummaryDto[];
  /** Requests that still wait for the machine: queued, or handed over and not finished. */
  tasks: TaskDto[];
  /** The last finished requests (done or failed), newest first. */
  recentTasks: TaskDto[];
  reports: ReportDto[];
  /** What the last retention run found; null before the first one. */
  repository: { bytes: number | null; snapshots: number | null; at: string } | null;
  /** Storage use and budget of the repository. */
  storage: EndpointStorageDto;
  lastRetentionAt: string | null;
  lastCheckAt: string | null;
  lastRestoreTestAt: string | null;
  commands: {
    uninstallScript: string;
    uninstallAgent: string;
    /** What an administrator of the machine runs to allow hooks (docs/AGENT.md, "Hooks"). */
    hooksScripts: string;
    hooksAny: string;
  } | null;
  /** Hooks: what the machine allows and what is configured (docs/AGENT.md, "Hooks"). */
  hooks: EndpointHooksDto;
  /** No new agent release is installed on this machine: the tenant paused updates, or the machine is paused on its own. */
  autoUpdatePaused: boolean;
  /** The machine is paused on its own (an override that outlives the tenant's setting). */
  autoUpdateOwnPause: boolean;
}

/** One configured hook as everybody may see it: whether it is set, and a fingerprint of its text. */
export interface HookSummaryDto {
  set: boolean;
  fingerprint: string | null;
}

export interface EndpointHooksDto {
  /**
   * The machine's local hook policy as its agent reports it: off, scripts
   * (named scripts in /etc/restow-agent/hooks.d) or any. null: the agent does
   * has not reported one yet; hooks cannot be set until it does.
   */
  policy: EndpointHookPolicy | null;
  /** The script names the agent offers (policy scripts). */
  scripts: string[];
  /**
   * Whether the hook texts are in `config.hooks`. Below the right to change
   * the configuration they are not (a hook may hold credentials); `pre` and
   * `post` say whether one is set.
   */
  visible: boolean;
  pre: HookSummaryDto;
  post: HookSummaryDto;
}

/** A short fingerprint of a hook text (the same the audit log records), null for none. */
export function hookFingerprint(value: string | undefined): string | null {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 16) : null;
}

export function hooksOf(
  config: EndpointConfig,
  settings: EndpointSettings | null,
  visible: boolean,
): EndpointHooksDto {
  const agent = settings?.agent;
  return {
    policy: agent?.hooks ?? null,
    scripts: agent?.hooks === "scripts" ? (agent.hookScripts ?? []) : [],
    visible,
    pre: { set: Boolean(config.hooks.pre), fingerprint: hookFingerprint(config.hooks.pre) },
    post: { set: Boolean(config.hooks.post), fingerprint: hookFingerprint(config.hooks.post) },
  };
}

export interface EnrollmentTokenDto {
  id: string;
  profile: Endpoint["profile"];
  displayName: string | null;
  createdAt: string;
  expiresAt: string;
  state: "valid" | "expired" | "used" | "revoked";
  usedByEndpointId: string | null;
}

export interface CreatedTokenDto extends EnrollmentTokenDto {
  /** The token, shown exactly once. */
  token: string;
  os: "linux" | "darwin";
  instanceUrl: string;
  /** The install command asks for the token on the terminal; `installUnattended` reads it from a file. */
  commands: {
    install: string;
    installUnattended: string;
    /** Where `installUnattended` expects the token (root's home folder of the system). */
    tokenFile: string;
    uninstallScript: string;
    uninstallAgent: string;
    hooksScripts: string;
    hooksAny: string;
  };
  /** Things the operator should know before running the command. */
  warnings: ("insecure_transport" | "instance_url_not_configured")[];
}

export interface SnapshotDto {
  id: string;
  shortId: string;
  time: string;
  hostname: string;
  paths: string[];
  filesNew: number | null;
  totalFilesProcessed: number | null;
  totalBytesProcessed: number | null;
  /** The readiness rating of exactly this snapshot (restore tests). */
  verification: { state: "green" | "red" | "unverified"; checkedAt: string | null };
  /**
   * Why retention found this snapshot suspicious: no backup run reported it
   * (`unrecorded`), or it is dated in the future (`future_time`). Empty for a
   * normal snapshot, and before the first retention run looked at it.
   */
  flags: SnapshotFlagReason[];
}

export interface BrowseEntryDto {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number | null;
  mtime: string | null;
}

export interface BrowseDto {
  snapshotId: string;
  path: string;
  entries: BrowseEntryDto[];
  /** Pass it as `cursor` for the next page; null when the folder has no more entries. */
  nextCursor: string | null;
}

/** A ZIP download that was checked and waits to be started (`GET .../downloads/:id`). */
export interface PreparedDownloadDto {
  id: string;
  /** After this time the download can no longer be started; prepare it again. */
  expiresAt: string;
  /** Files and folders the ZIP will hold. */
  items: number;
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export function effectiveSettings(settings: EndpointSettings | null): EffectiveSettingsDto {
  return {
    retention: settings?.retention ?? { ...DEFAULT_ENDPOINT_RETENTION },
    staleAfterHours: settings?.staleAfterHours ?? DEFAULT_SERVER_STALE_HOURS,
    staleAfterDays: settings?.staleAfterDays ?? DEFAULT_CLIENT_STALE_DAYS,
    quotaGib: settings?.quotaGib ?? null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LEVEL_RANK: Record<QuotaLevel, number> = { ok: 0, near: 1, exceeded: 2 };

/** The storage use of an endpoint against its budget and the tenant's. */
export function storageOf(
  endpoint: Pick<
    Endpoint,
    "settings" | "repositoryBytes" | "repositoryMeasuredAt" | "quotaRefusedAt"
  >,
  tenantUsedBytes: number,
  limits: EndpointQuotaLimits,
  now: Date,
): EndpointStorageDto {
  const budgetBytes = endpointBudgetBytes(endpoint.settings, limits);
  const used = endpoint.repositoryBytes;
  const levels: QuotaLevel[] = [
    used === null ? "ok" : quotaLevelOf(used, budgetBytes),
    quotaLevelOf(tenantUsedBytes, limits.tenantBytes),
  ];
  const refusedToday =
    endpoint.quotaRefusedAt !== null && now.getTime() - endpoint.quotaRefusedAt.getTime() < DAY_MS;
  if (refusedToday) {
    levels.push("exceeded");
  }
  const level = levels.reduce((worst, next) =>
    LEVEL_RANK[next] > LEVEL_RANK[worst] ? next : worst,
  );
  return {
    usedBytes: used,
    measuredAt: iso(endpoint.repositoryMeasuredAt),
    budgetBytes,
    ownBudget: typeof endpoint.settings?.quotaGib === "number",
    defaultBudgetBytes: limits.endpointBytes,
    tenantUsedBytes,
    tenantBudgetBytes: limits.tenantBytes,
    level,
    refusedAt: iso(endpoint.quotaRefusedAt),
  };
}

/**
 * The restore tests on the machine that a report rated, green or red: the
 * ids of their runs and of the tasks those runs carried out. A finished
 * `verify_sample` run, or a failed `verify_sample` task, that is not listed
 * rated nothing (the agent's test could not complete, @restow/core
 * `judgeAgentRestoreTest`; or the monitor closed it). Loaded by
 * `loadRatedTests` for exactly the runs and tasks a response shows.
 */
export interface RatedTests {
  runs: ReadonlySet<string>;
  tasks: ReadonlySet<string>;
}

/** For runs and tasks that cannot be a finished restore test (a task just queued). */
export const NO_RATED_TESTS: RatedTests = { runs: new Set(), tasks: new Set() };

/** See {@link RunSummaryDto.checkIncomplete}. */
export function isIncompleteTestRun(
  run: Pick<EndpointRun, "id" | "kind" | "status">,
  rated: RatedTests,
): boolean {
  return run.kind === "verify_sample" && run.status !== "running" && !rated.runs.has(run.id);
}

/** See {@link TaskDto.checkIncomplete}. */
export function isIncompleteTestTask(
  task: Pick<EndpointTask, "id" | "kind" | "status">,
  rated: RatedTests,
): boolean {
  return task.kind === "verify_sample" && task.status === "failed" && !rated.tasks.has(task.id);
}

export function toRunSummary(run: EndpointRun, rated: RatedTests): RunSummaryDto {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: iso(run.finishedAt),
    snapshotId: run.snapshotId,
    errorCount: run.errors.length,
    interruptedOnly: run.status === "failed" && isInterruptedOnly(run.errors),
    checkIncomplete: isIncompleteTestRun(run, rated),
    failure: failureDto(run.failure),
    filesNew: run.stats?.filesNew ?? null,
    dataAdded: run.stats?.dataAdded ?? null,
    totalBytesProcessed: run.stats?.totalBytesProcessed ?? null,
    progress: run.status === "running" ? run.progress : null,
  };
}

export function toRunDetail(run: EndpointRun, rated: RatedTests): RunDetailDto {
  return {
    ...toRunSummary(run, rated),
    taskId: run.taskId,
    errors: run.errors,
    logTail: run.logTail,
    stats: run.stats,
  };
}

export function toTask(task: EndpointTask, rated: RatedTests): TaskDto {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    params: task.params,
    createdAt: task.createdAt.toISOString(),
    deliveredAt: iso(task.deliveredAt),
    finishedAt: iso(task.finishedAt),
    errorMessage: task.errorMessage,
    checkIncomplete: isIncompleteTestTask(task, rated),
  };
}

export function toReport(report: EndpointReport): ReportDto {
  return {
    id: report.id,
    kind: report.kind,
    origin: report.origin,
    snapshotId: report.snapshotId,
    readiness: report.readiness,
    summary: report.summary,
    checkedAt: report.checkedAt.toISOString(),
  };
}

export function toReadiness(readiness: EndpointReadinessDto): ReadinessDto {
  return {
    state: readiness.state,
    checkedAt: iso(readiness.checkedAt),
    overdue: readiness.overdue,
    basis: readiness.basis,
    latestSnapshotId: readiness.latestSnapshotId,
  };
}

/** What needs an admin's eye, in order of weight. */
export function attentionOf(
  endpoint: Endpoint,
  latestRun: EndpointRun | null,
  readiness: EndpointReadinessDto,
  now: Date,
): EndpointAttention[] {
  if (endpoint.status !== "active") {
    return [];
  }
  const attention: EndpointAttention[] = [];
  const staleness = endpointStaleness(
    {
      profile: endpoint.profile,
      status: endpoint.status,
      createdAt: endpoint.createdAt,
      lastSeenAt: endpoint.lastSeenAt,
      lastSuccessAt: endpoint.lastSuccessAt,
      settings: endpoint.settings,
    },
    now,
  );
  if (!endpoint.lastSeenAt) {
    attention.push("never_seen");
  } else if (staleness.silent) {
    attention.push("silent");
  }
  if (staleness.backupOverdue) {
    attention.push("backup_overdue");
  }
  if (
    latestRun?.kind === "backup" &&
    latestRun.status === "failed" &&
    !isInterruptedOnly(latestRun.errors ?? [])
  ) {
    attention.push("last_backup_failed");
  }
  if (readiness.state === "red") {
    attention.push(
      readiness.basis === "repository_check" ? "repository_damaged" : "restore_test_failed",
    );
  }
  return attention;
}

export function toSummary(
  endpoint: Endpoint,
  latestRun: EndpointRun | null,
  readiness: EndpointReadinessDto,
  now: Date,
  rated: RatedTests,
  job: { id: string; name: string } | null = null,
): EndpointSummaryDto {
  return {
    id: endpoint.id,
    hostname: endpoint.hostname,
    displayName: endpoint.displayName,
    os: endpoint.os,
    arch: endpoint.arch,
    profile: endpoint.profile,
    agentVersion: endpoint.agentVersion,
    osVersion: endpoint.osVersion,
    status: endpoint.status,
    connection: connectionOf(endpoint.lastSeenAt, now),
    agentState: endpoint.agentState,
    lastSeenAt: iso(endpoint.lastSeenAt),
    lastBackupAt: iso(endpoint.lastBackupAt),
    lastSuccessAt: iso(endpoint.lastSuccessAt),
    nextRunAt: iso(endpoint.nextRunAt),
    readiness: toReadiness(readiness),
    latestRun: latestRun ? toRunSummary(latestRun, rated) : null,
    attention: attentionOf(endpoint, latestRun, readiness, now),
    job,
    createdAt: endpoint.createdAt.toISOString(),
    revokedAt: iso(endpoint.revokedAt),
  };
}

/** Each reason in `attention` explained: what happened, why, what to do. */
export function problemsOf(
  endpoint: Endpoint,
  latestRun: EndpointRun | null,
  readiness: EndpointReadinessDto,
  now: Date,
): EndpointProblemDto[] {
  const problems: EndpointProblemDto[] = [];
  const hoursSince = (at: Date) => (now.getTime() - at.getTime()) / (60 * 60 * 1000);
  for (const attention of attentionOf(endpoint, latestRun, readiness, now)) {
    switch (attention) {
      case "silent":
        problems.push({
          attention,
          failure: causeToFailureDto(
            silentCause(hoursSince(endpoint.lastSeenAt ?? endpoint.createdAt)),
            now,
          ),
        });
        break;
      case "backup_overdue":
        problems.push({
          attention,
          failure: causeToFailureDto(
            backupOverdueCause(hoursSince(endpoint.lastSuccessAt ?? endpoint.createdAt) / 24),
            now,
          ),
        });
        break;
      case "last_backup_failed": {
        const failure = failureDto(latestRun?.failure);
        if (failure) {
          problems.push({ attention, failure });
        }
        break;
      }
      case "restore_test_failed":
        problems.push({
          attention,
          failure: causeToFailureDto(
            { code: "endpoint.hash_mismatch", transient: false, params: {}, technical: {} },
            readiness.checkedAt ?? now,
          ),
        });
        break;
      case "repository_damaged":
        problems.push({
          attention,
          failure: causeToFailureDto(repositoryDamagedCause(), readiness.checkedAt ?? now),
        });
        break;
      default:
        break;
    }
  }
  return problems;
}
