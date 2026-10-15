import { randomUUID } from "node:crypto";
import {
  type CopyShareFacts,
  type JobKind,
  type JobMemberOverrides,
  type JobSchedule,
  checkCopyRules,
  cleanTargetFolder,
  endpointScheduleOf,
  nextRunAt as firstRunAt,
  jobScheduleFromEndpoint,
  mailCadenceOf,
  mailJobObjectIds,
  normalizeMailSchedule,
  scheduleKey,
  validateJobSchedule,
} from "@restow/core";
import {
  type BackupJob,
  type BackupJobMember,
  type BackupJobSettings,
  type Database,
  type FileShare,
  backupJobMembers,
  backupJobs,
  endpointTasks,
  endpoints,
  fileShareRuns,
  fileShares,
  retentionPolicies,
} from "@restow/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { ENDPOINT_AUDIT_ACTIONS, auditEndpoint } from "../endpoints/audit.js";
import { type BandwidthWindowsProblem, checkedBandwidthWindows } from "../endpoints/bandwidth.js";
import { hookFingerprint } from "../endpoints/dto.js";
import { AGENT_TASK_TTL_MS } from "../endpoints/service.js";
import { FILE_SHARE_TENANT_AUDIT_ACTIONS, auditShare } from "../file-shares/audit.js";
import { FILE_SHARE_PROBLEMS } from "../file-shares/constants.js";
import { listShareSource } from "../file-shares/service.js";
import { backupBlockedReason } from "../jobs/dto.js";
import { isMissingQueueSchema } from "../jobs/queue.js";
import { enqueueBackup } from "../jobs/service.js";
import type { BackupJobDto, RunBackupJobResult } from "./dto.js";
import { releaseEndpointConfigs, syncEndpointConfigs } from "./endpoint-sync.js";
import { sameJson } from "./json.js";
import { type SupportedJob, assertSupportedJob, hasMembers } from "./kinds.js";
import { loadAllMembers, loadObjectInfos, loadPrimaryTarget, objectName } from "./loaders.js";
import { type ReadOptions, jobDto, loadJob } from "./read.js";
import {
  type AddMembersInput,
  COPY_CONFIRM_PROBLEM,
  COPY_UNSAFE_TARGET_PROBLEM,
  type CreateBackupJobInput,
  IN_OTHER_JOB_PROBLEM,
  JOB_STATE_PROBLEM,
  type ReplaceMembersInput,
  type RunBackupJobInput,
  type SetOverridesInput,
  type UpdateBackupJobInput,
  jobProblem,
} from "./schemas.js";
import { BACKUP_JOB_AUDIT_ACTIONS, type JobActor, type JobContext } from "./service-types.js";

/**
 * Changing jobs. Everything runs in the tenant's pinned transaction and ends with an audit entry
 * written in the same transaction. A job's schedule is checked with the rules of its kind (the
 * schedules page's for mail, the agent contract's for machines), an object or machine belongs to
 * one job at most, and whenever something changes that a machine reads, the machine's
 * configuration is rewritten from the job (endpoint-sync.ts).
 */

const UNIQUE_NAME = "backup_jobs_tenant_kind_name_uq";
const UNIQUE_ALL = "backup_jobs_tenant_kind_all_uq";

/** Postgres' unique violation on `constraint`, including the cause chain drizzle wraps. */
function isUnique(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Schedules and overrides
// ---------------------------------------------------------------------------

/** A schedule checked for the job's kind and stored in its normal form (a daily mail time as cron). */
function checkedSchedule(
  kind: JobKind,
  schedule: JobSchedule,
  now: Date,
  path: readonly string[],
): JobSchedule {
  const field = path[path.length - 1] ?? "schedule";
  const issue = validateJobSchedule(kind, schedule, now, field);
  if (issue) {
    throw jobProblem([...path.slice(0, -1), ...issue.path], issue.code, issue.message);
  }
  return kind === "endpoint"
    ? jobScheduleFromEndpoint(endpointScheduleOf(schedule))
    : normalizeMailSchedule(schedule);
}

/** When a mail schedule runs next, from its last run; null for no schedule. */
function nextOf(schedule: JobSchedule | null, now: Date, lastRunAt: Date | null): Date | null {
  const cadence = schedule ? mailCadenceOf(schedule) : null;
  return cadence ? firstRunAt(cadence, { now, lastRunAt }) : null;
}

/** A refused time window as the form shows it: the field and the code name what is wrong. */
function windowsProblem(problem: BandwidthWindowsProblem) {
  return jobProblem(problem.path, problem.code, problem.message);
}

const MAIL_OVERRIDE_KEYS = ["schedule", "verifySchedule"] as const;
const ENDPOINT_OVERRIDE_KEYS = [
  "schedule",
  "paths",
  "excludes",
  "excludeLargerThanGib",
  "hooks",
  "bandwidthKbps",
  "bandwidthWindows",
  "retention",
] as const;

const SHARE_OVERRIDE_KEYS = [
  "schedule",
  "includes",
  "excludes",
  "presets",
  "fileTypes",
  "excludeLargerThanGib",
  "bandwidthKbps",
  "bandwidthWindows",
  "readConcurrency",
  "skipOffline",
  "retention",
] as const;

function overrideKeysOf(kind: JobKind): readonly string[] {
  switch (kind) {
    case "mail":
      return MAIL_OVERRIDE_KEYS;
    case "share":
      return SHARE_OVERRIDE_KEYS;
    case "copy":
      return [];
    default:
      return ENDPOINT_OVERRIDE_KEYS;
  }
}

function overrideRefusal(kind: JobKind): string {
  switch (kind) {
    case "mail":
      return "A mailbox can only have its own schedule and restore check.";
    case "share":
      return "A file share has no restore-check schedule or hooks of its own: every backup is checked.";
    case "copy":
      return "A copy job has no members.";
    default:
      return "A machine has no restore-check schedule of its own: every backup is checked.";
  }
}

/** An override checked for the kind of job (a mail member only has schedules) and normalised. */
function checkedOverrides(
  kind: JobKind,
  overrides: JobMemberOverrides | undefined,
  now: Date,
  path: readonly string[],
): JobMemberOverrides {
  const input = overrides ?? {};
  const allowed = overrideKeysOf(kind);
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !allowed.includes(key)) {
      throw jobProblem([...path, key], "override_not_supported", overrideRefusal(kind));
    }
  }
  const result: JobMemberOverrides = { ...input };
  if (input.bandwidthWindows !== undefined) {
    // Kept even when empty: a member that states its own limit states "no windows" with it.
    result.bandwidthWindows = checkedBandwidthWindows(
      input.bandwidthWindows,
      [...path, "bandwidthWindows"],
      windowsProblem,
      { keepEmpty: true },
    );
  }
  if (input.schedule) {
    result.schedule = checkedSchedule(kind, input.schedule, now, [...path, "schedule"]);
  }
  if (input.verifySchedule) {
    result.verifySchedule = checkedSchedule(kind, input.verifySchedule, now, [
      ...path,
      "verifySchedule",
    ]);
  }
  for (const key of Object.keys(result) as (keyof JobMemberOverrides)[]) {
    if (result[key] === undefined) {
      delete result[key];
    }
  }
  return result;
}

/**
 * Whether two schedules run at the same times. Compared by what they mean (`scheduleKey`: the
 * cadence, the cron expression without its spacing, the zone where a clock time needs one), not
 * by how they are written: a schedule that did not change keeps its timer.
 */
export function sameSchedule(
  a: JobSchedule | null | undefined,
  b: JobSchedule | null | undefined,
): boolean {
  return scheduleKey(a) === scheduleKey(b);
}

/**
 * The timers of a member with a schedule of its own (mail jobs only: the scheduler plans them; a
 * machine's own schedule is written into its configuration and the agent keeps the time). A timer
 * whose schedule did not change is kept.
 */
function timers(
  kind: JobKind,
  overrides: JobMemberOverrides,
  now: Date,
  before?: BackupJobMember,
): Pick<BackupJobMember, "nextRunAt" | "lastRunAt" | "verifyNextRunAt" | "verifyLastRunAt"> {
  if (kind !== "mail" && kind !== "share") {
    return { nextRunAt: null, lastRunAt: null, verifyNextRunAt: null, verifyLastRunAt: null };
  }
  const keep = (schedule: JobSchedule | undefined, previous: JobSchedule | undefined) =>
    schedule !== undefined &&
    previous !== undefined &&
    scheduleKey(schedule) === scheduleKey(previous);
  const backupKept = before && keep(overrides.schedule, before.overrides.schedule);
  const verifyKept = before && keep(overrides.verifySchedule, before.overrides.verifySchedule);
  return {
    nextRunAt: backupKept ? before.nextRunAt : nextOf(overrides.schedule ?? null, now, null),
    lastRunAt: backupKept ? before.lastRunAt : null,
    verifyNextRunAt: verifyKept
      ? before.verifyNextRunAt
      : nextOf(overrides.verifySchedule ?? null, now, null),
    verifyLastRunAt: verifyKept ? before.verifyLastRunAt : null,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SHARE_SETTING_KEYS = [
  "excludes",
  "presets",
  "fileTypes",
  "excludeLargerThanGib",
  "bandwidthKbps",
  "bandwidthWindows",
  "readConcurrency",
  "skipOffline",
  "retention",
];
const COPY_SETTING_KEYS = ["targetFolder", "mode", "restorePermissions", "verify"];
const ENDPOINT_SETTING_KEYS = [
  "paths",
  "excludes",
  "excludeLargerThanGib",
  "hooks",
  "bandwidthKbps",
  "bandwidthWindows",
  "retention",
];

/** Settings checked for the job: a machine job needs folders, a mail job takes none. */
function checkedSettings(
  kind: JobKind,
  settings: BackupJobSettings,
  options: { requirePaths: boolean },
): BackupJobSettings {
  const entries = Object.entries(settings).filter(([, value]) => value !== undefined);
  const allowed =
    kind === "share"
      ? SHARE_SETTING_KEYS
      : kind === "copy"
        ? COPY_SETTING_KEYS
        : kind === "endpoint"
          ? ENDPOINT_SETTING_KEYS
          : [];
  const foreign = entries.find(([key]) => kind !== "mail" && !allowed.includes(key));
  if (foreign) {
    throw jobProblem(
      ["settings", foreign[0]],
      "settings_not_supported",
      `A ${kind} job has no setting "${foreign[0]}".`,
    );
  }
  if (kind === "copy") {
    if (settings.mode === undefined) {
      throw jobProblem(["settings", "mode"], "required", "Choose overwrite or mirror.");
    }
    const clean: BackupJobSettings = {
      targetFolder: cleanTargetFolder(settings.targetFolder ?? ""),
      mode: settings.mode,
      restorePermissions: settings.restorePermissions === true,
    };
    if (settings.verify !== undefined) {
      clean.verify = settings.verify;
    }
    return clean;
  }
  if (kind === "share") {
    const clean: BackupJobSettings = {};
    for (const [key, value] of entries) {
      if (key !== "bandwidthWindows") {
        (clean as Record<string, unknown>)[key] = value;
      }
    }
    const windows = checkedBandwidthWindows(
      settings.bandwidthWindows,
      ["settings", "bandwidthWindows"],
      windowsProblem,
    );
    if (windows) {
      clean.bandwidthWindows = windows;
    }
    return clean;
  }
  if (kind === "mail") {
    if (entries.length > 0) {
      throw jobProblem(
        ["settings", entries[0]?.[0] ?? "settings"],
        "settings_not_supported",
        "A mail job has no folders, exclusions, hooks, bandwidth or machine retention.",
      );
    }
    return {};
  }
  if (options.requirePaths && !(settings.paths && settings.paths.length > 0)) {
    throw jobProblem(["settings", "paths"], "required", "Choose at least one folder to back up.");
  }
  const clean: BackupJobSettings = {};
  for (const [key, value] of entries) {
    if (key !== "bandwidthWindows") {
      (clean as Record<string, unknown>)[key] = value;
    }
  }
  if (clean.hooks) {
    const hooks: { pre?: string; post?: string } = {};
    if (clean.hooks.pre) hooks.pre = clean.hooks.pre;
    if (clean.hooks.post) hooks.post = clean.hooks.post;
    clean.hooks = hooks;
  }
  // Checked (no overlap) and in the normal order; a job without windows stores none.
  const windows = checkedBandwidthWindows(
    settings.bandwidthWindows,
    ["settings", "bandwidthWindows"],
    windowsProblem,
  );
  if (windows) {
    clean.bandwidthWindows = windows;
  }
  return clean;
}

function checkedBase(
  kind: JobKind,
  input: {
    schedule?: JobSchedule | null;
    verifySchedule?: JobSchedule | null;
    retentionPolicyId?: string | null;
  },
  now: Date,
): { schedule: JobSchedule | null; verifySchedule: JobSchedule | null } {
  let schedule: JobSchedule | null = null;
  if (input.schedule) {
    schedule = checkedSchedule(kind, input.schedule, now, ["schedule"]);
  } else if (kind === "endpoint") {
    throw jobProblem(
      ["schedule"],
      "required",
      "A machine job needs a schedule: the agent decides from it when to back up.",
    );
  }
  if ((kind === "share" || kind === "copy") && input.verifySchedule) {
    throw jobProblem(
      ["verifySchedule"],
      "restore_check_not_supported",
      kind === "share"
        ? "Every new restore point of a file share is checked; there is no schedule to set."
        : "A copy job has no restore checks: it is not a backup.",
    );
  }
  if ((kind === "share" || kind === "copy") && input.retentionPolicyId) {
    throw jobProblem(
      ["retentionPolicyId"],
      "retention_policy_not_supported",
      "A file share job sets how many daily, weekly and monthly restore points to keep instead.",
    );
  }
  if (kind === "endpoint" && input.verifySchedule) {
    throw jobProblem(
      ["verifySchedule"],
      "restore_check_not_supported",
      "Every backup of a machine is checked; there is no schedule to set.",
    );
  }
  if (kind === "endpoint" && input.retentionPolicyId) {
    throw jobProblem(
      ["retentionPolicyId"],
      "retention_policy_not_supported",
      "A machine job sets how many daily, weekly and monthly restore points to keep instead.",
    );
  }
  const verifySchedule = input.verifySchedule
    ? checkedSchedule(kind, input.verifySchedule, now, ["verifySchedule"])
    : null;
  return { schedule, verifySchedule };
}

async function checkRepository(
  tx: Transaction,
  tenantId: string,
  storageTargetId: string | null | undefined,
): Promise<string | null> {
  if (!storageTargetId) {
    return null;
  }
  const primary = await loadPrimaryTarget(tx, tenantId);
  if (primary?.id !== storageTargetId) {
    throw jobProblem(
      ["storageTargetId"],
      "repository_not_supported",
      "Jobs write to the primary repository of the tenant; another repository cannot be chosen yet.",
    );
  }
  return storageTargetId;
}

async function checkRetentionPolicy(
  tx: Transaction,
  tenantId: string,
  policyId: string | null | undefined,
): Promise<string | null> {
  if (!policyId) {
    return null;
  }
  const [row] = await tx
    .select({ id: retentionPolicies.id, appliesTo: retentionPolicies.appliesTo })
    .from(retentionPolicies)
    .where(and(eq(retentionPolicies.tenantId, tenantId), eq(retentionPolicies.id, policyId)))
    .limit(1);
  const target = (row?.appliesTo as { target?: unknown } | null)?.target;
  if (!row || target !== "snapshots") {
    throw jobProblem(
      ["retentionPolicyId"],
      "policy_not_found",
      "The retention policy does not exist in this tenant, or it governs the archive.",
    );
  }
  return policyId;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

interface ResolvedMember {
  targetId: string;
  overrides: JobMemberOverrides;
  before?: BackupJobMember;
}

/** The objects (mail) or machines (machine jobs) of the tenant that may join a job. */
async function assertTargets(
  tx: Transaction,
  tenantId: string,
  kind: JobKind,
  targetIds: readonly string[],
  pathOf: (index: number) => readonly string[],
): Promise<void> {
  const ids = [...new Set(targetIds)];
  if (ids.length === 0) {
    return;
  }
  if (kind === "mail") {
    const found = new Map(
      (await loadObjectInfos(tx, tenantId, ids)).map((object) => [object.id, object]),
    );
    targetIds.forEach((id, index) => {
      const object = found.get(id);
      if (!object) {
        throw jobProblem(
          pathOf(index),
          "object_not_found",
          "The protected object does not exist in this tenant.",
        );
      }
      if (object.sourceKind === "import") {
        throw jobProblem(
          pathOf(index),
          "object_not_supported",
          "An imported mailbox is not backed up, so it cannot be in a job.",
        );
      }
    });
    return;
  }
  if (kind === "share") {
    const shares = await tx
      .select({ id: fileShares.id, retiredAt: fileShares.retiredAt })
      .from(fileShares)
      .where(and(eq(fileShares.tenantId, tenantId), inArray(fileShares.id, ids)));
    const known = new Map(shares.map((row) => [row.id, row]));
    targetIds.forEach((id, index) => {
      const row = known.get(id);
      if (!row) {
        throw jobProblem(
          pathOf(index),
          "file_share_not_found",
          "The file share does not exist in this tenant.",
        );
      }
      if (row.retiredAt) {
        throw jobProblem(
          pathOf(index),
          "file_share_retired",
          "A retired file share cannot be in a job. Reactivate it first.",
        );
      }
    });
    return;
  }
  if (kind === "copy") {
    if (ids.length > 0) {
      throw jobProblem(pathOf(0), "members_not_supported", "A copy job has no members.");
    }
    return;
  }
  const rows = await tx
    .select({ id: endpoints.id, status: endpoints.status })
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), inArray(endpoints.id, ids)));
  const found = new Map(rows.map((row) => [row.id, row]));
  targetIds.forEach((id, index) => {
    const row = found.get(id);
    if (!row) {
      throw jobProblem(
        pathOf(index),
        "endpoint_not_found",
        "The machine does not exist in this tenant.",
      );
    }
    if (row.status !== "active") {
      throw jobProblem(pathOf(index), "endpoint_revoked", "A revoked machine cannot be in a job.");
    }
  });
}

/** The member column of a kind's targets. */
function memberColumn(kind: JobKind) {
  switch (kind) {
    case "mail":
      return backupJobMembers.protectedObjectId;
    case "share":
    case "copy":
      return backupJobMembers.fileShareId;
    default:
      return backupJobMembers.endpointId;
  }
}

function memberTarget(kind: JobKind, targetId: string) {
  switch (kind) {
    case "mail":
      return { protectedObjectId: targetId };
    case "share":
    case "copy":
      return { fileShareId: targetId };
    default:
      return { endpointId: targetId };
  }
}

function targetWords(kind: JobKind): string {
  return kind === "mail" ? "objects" : kind === "endpoint" ? "machines" : "file shares";
}

/** Which of `targetIds` already belong to a job other than `jobId`. */
async function conflictsOf(
  tx: Transaction,
  tenantId: string,
  jobId: string | null,
  kind: JobKind,
  targetIds: readonly string[],
): Promise<{ member: BackupJobMember; jobName: string }[]> {
  if (targetIds.length === 0) {
    return [];
  }
  const column = memberColumn(kind);
  const rows = await tx
    .select({ member: backupJobMembers, jobName: backupJobs.name })
    .from(backupJobMembers)
    .innerJoin(backupJobs, eq(backupJobs.id, backupJobMembers.jobId))
    .where(and(eq(backupJobMembers.tenantId, tenantId), inArray(column, [...targetIds])));
  return rows.filter((row) => row.member.jobId !== jobId);
}

function targetOf(member: BackupJobMember): string {
  return (member.protectedObjectId ?? member.endpointId ?? member.fileShareId) as string;
}

/**
 * Take the targets out of the jobs they belong to (when `move` allows it) or refuse them with
 * the list of what is in the way. Returns the source jobs with how many they lost.
 */
async function releaseTargets(
  tx: Transaction,
  tenantId: string,
  jobId: string | null,
  kind: JobKind,
  targetIds: readonly string[],
  move: boolean,
): Promise<Map<string, { name: string; targets: string[] }>> {
  const conflicts = await conflictsOf(tx, tenantId, jobId, kind, targetIds);
  if (conflicts.length === 0) {
    return new Map();
  }
  if (!move) {
    throw new ProblemError(409, "Already in another job", {
      type: IN_OTHER_JOB_PROBLEM,
      detail: `${conflicts.length} of the chosen ${targetWords(kind)} already belong to another job. An object, machine or file share is in one job at a time.`,
      extensions: {
        conflicts: conflicts.map(({ member, jobName }) => ({
          targetId: targetOf(member),
          jobId: member.jobId,
          jobName,
        })),
      },
    });
  }
  const sources = new Map<string, { name: string; targets: string[] }>();
  for (const { member, jobName } of conflicts) {
    const entry = sources.get(member.jobId) ?? { name: jobName, targets: [] };
    entry.targets.push(targetOf(member));
    sources.set(member.jobId, entry);
  }
  await tx.delete(backupJobMembers).where(
    inArray(
      backupJobMembers.id,
      conflicts.map(({ member }) => member.id),
    ),
  );
  return sources;
}

async function auditMoved(
  tx: Transaction,
  tenantId: string,
  actor: JobActor,
  sources: Map<string, { name: string; targets: string[] }>,
  into: { id: string; name: string },
): Promise<void> {
  for (const [jobId, entry] of sources) {
    await auditJob(tx, tenantId, actor, BACKUP_JOB_AUDIT_ACTIONS.scopeChanged, jobId, {
      name: entry.name,
      removed: entry.targets.length,
      movedTo: into,
      targets: entry.targets.slice(0, 50),
    });
  }
}

async function auditJob(
  tx: Transaction,
  tenantId: string,
  actor: JobActor,
  action: string,
  jobId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await audit(tx, {
    tenantId,
    actor: actor.label,
    actorUserId: actor.userId,
    ip: actor.ip,
    action,
    target: jobId,
    targetType: "backup_job",
    details,
  });
}

/** Insert member rows of a job. */
async function insertMembers(
  tx: Transaction,
  tenantId: string,
  job: SupportedJob,
  members: readonly ResolvedMember[],
  now: Date,
): Promise<void> {
  if (members.length === 0) {
    return;
  }
  await tx.insert(backupJobMembers).values(
    members.map((member) => ({
      id: randomUUID(),
      tenantId,
      jobId: job.id,
      ...memberTarget(job.kind, member.targetId),
      overrides: member.overrides,
      ...timers(job.kind, member.overrides, now),
    })),
  );
}

function resolveInputs(
  kind: JobKind,
  inputs: readonly { id: string; overrides?: JobMemberOverrides }[],
  now: Date,
  path: readonly string[],
): ResolvedMember[] {
  const seen = new Set<string>();
  return inputs.map((input, index) => {
    if (seen.has(input.id)) {
      throw jobProblem([...path, String(index), "id"], "duplicate_member", "Listed twice.");
    }
    seen.add(input.id);
    return {
      targetId: input.id,
      overrides: checkedOverrides(kind, input.overrides, now, [
        ...path,
        String(index),
        "overrides",
      ]),
    };
  });
}

// ---------------------------------------------------------------------------
// Copy jobs (docs/FILESHARES.md 4.10)
// ---------------------------------------------------------------------------

function assertHasMembers(job: SupportedJob): void {
  if (!hasMembers(job.kind)) {
    throw new ProblemError(409, "A copy job has no members", {
      type: JOB_STATE_PROBLEM,
      detail: "A copy job names its source and target file share; it has no members to change.",
      extensions: { code: "members_not_supported" },
    });
  }
}

function copyFactsOf(share: FileShare): CopyShareFacts {
  return {
    id: share.id,
    protocol: share.protocol,
    server: share.server,
    shareName: share.shareName,
    exportPath: share.exportPath,
    subfolder: share.subfolder,
    allowRestore: share.allowRestore,
    retiredAt: share.retiredAt,
  };
}

async function loadCopyShares(
  tx: Transaction,
  tenantId: string,
  sourceId: string | null | undefined,
  targetId: string | null | undefined,
): Promise<{ source: FileShare; target: FileShare }> {
  if (!sourceId) {
    throw jobProblem(["sourceFileShareId"], "required", "Choose the file share to copy from.");
  }
  if (!targetId) {
    throw jobProblem(["targetFileShareId"], "required", "Choose the file share to copy into.");
  }
  const rows = await tx
    .select()
    .from(fileShares)
    .where(and(eq(fileShares.tenantId, tenantId), inArray(fileShares.id, [sourceId, targetId])));
  const source = rows.find((row) => row.id === sourceId);
  const target = rows.find((row) => row.id === targetId);
  if (!source) {
    throw jobProblem(
      ["sourceFileShareId"],
      "file_share_not_found",
      "The file share does not exist in this tenant.",
    );
  }
  if (!target) {
    throw jobProblem(
      ["targetFileShareId"],
      "file_share_not_found",
      "The file share does not exist in this tenant.",
    );
  }
  return { source, target };
}

/** Rules 1 to 3 of 4.10 when a copy job is saved: a refusal names the rule. */
function assertCopyRules(source: FileShare, target: FileShare, settings: BackupJobSettings): void {
  const result = checkCopyRules(copyFactsOf(source), copyFactsOf(target), {
    mode: settings.mode ?? "overwrite",
    targetFolder: settings.targetFolder ?? "",
  });
  if (result.ok) {
    return;
  }
  if (result.rule === "restore_not_allowed") {
    throw new ProblemError(422, "Restore not allowed", {
      type: FILE_SHARE_PROBLEMS.restoreNotAllowed,
      detail: `"${target.name}" does not allow restores into it, so nothing can be copied there. Switch on "Allow restore to this share" in its settings first.`,
      extensions: { field: "targetFileShareId", rule: result.rule },
    });
  }
  const detail =
    result.rule === "same_share"
      ? "Source and target are the same place. A copy never writes into the share it copies."
      : result.rule === "share_root"
        ? "A mirror deletes what the source does not have, so it never writes into the root of a share. Choose a folder."
        : "A retired file share cannot be copied from or into.";
  throw new ProblemError(422, "Unsafe copy target", {
    type: COPY_UNSAFE_TARGET_PROBLEM,
    detail,
    extensions: {
      field: result.rule === "share_root" ? "settings" : "targetFileShareId",
      rule: result.rule,
    },
  });
}

/**
 * How many entries the mirror's target folder has (4.10 rule 4): 0 when it is empty or does not
 * exist yet (Restow creates it and writes its marker), null when the share could not be asked
 * (then the admin confirms as for a non-empty folder).
 */
async function mirrorFolderEntries(
  db: Database,
  tenantId: string,
  target: FileShare,
  folder: string,
  actor: JobActor,
  context: JobContext,
): Promise<number | null> {
  try {
    const listing = await listShareSource(
      db,
      tenantId,
      target.id,
      { path: folder, limit: 2000 },
      {
        actor,
        isProviderAdmin: false,
        providerRole: null,
        now: context.now,
        runner: context.fileShares?.runner,
        resolve: context.fileShares?.resolve,
      },
    );
    if (listing.ok) {
      return listing.entries.length;
    }
    return listing.cause === "share.not_found" ? 0 : null;
  } catch {
    return null;
  }
}

/** The settings of a copy job after the mirror check: confirmed now, kept, or refused (409). */
async function confirmedCopySettings(
  db: Database,
  tenantId: string,
  target: FileShare,
  settings: BackupJobSettings,
  previous: { targetId: string | null; settings: BackupJobSettings } | null,
  confirm: boolean,
  actor: JobActor,
  context: JobContext,
): Promise<BackupJobSettings> {
  const { mirrorConfirmedAt: _dropped, ...rest } = settings;
  const next: BackupJobSettings = rest;
  if (settings.mode !== "mirror") {
    return next;
  }
  const sameTarget =
    previous !== null &&
    previous.targetId === target.id &&
    (previous.settings.targetFolder ?? "") === (settings.targetFolder ?? "") &&
    previous.settings.mode === "mirror";
  if (sameTarget && previous?.settings.mirrorConfirmedAt) {
    // Nothing about the target changed: the confirmation stays (changing it clears it).
    next.mirrorConfirmedAt = previous.settings.mirrorConfirmedAt;
    return next;
  }
  if (confirm) {
    next.mirrorConfirmedAt = context.now.toISOString();
    return next;
  }
  if (sameTarget) {
    return next;
  }
  const folder = settings.targetFolder ?? "";
  const entries = await mirrorFolderEntries(db, tenantId, target, folder, actor, context);
  if (entries === 0) {
    return next;
  }
  throw new ProblemError(409, "Confirm the mirror", {
    type: COPY_CONFIRM_PROBLEM,
    detail:
      entries === null
        ? `The folder "${folder}" on "${target.name}" could not be read. A mirror deletes everything in the folder that is not in the source; confirm to go on.`
        : `The folder "${folder}" on "${target.name}" is not empty (${entries} entries). Everything in it that is not in the source will be deleted; confirm to go on.`,
    extensions: { field: "settings", folder, entries, targetName: target.name },
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function hookDetails(settings: BackupJobSettings) {
  return settings.hooks
    ? { pre: hookFingerprint(settings.hooks.pre), post: hookFingerprint(settings.hooks.post) }
    : undefined;
}

/** What an audit entry says about a job's definition: never a hook text. */
function definitionOf(job: BackupJob): Record<string, unknown> {
  const { hooks: _hooks, ...settings } = job.settings ?? {};
  return {
    kind: job.kind,
    name: job.name,
    scopeMode: job.scopeMode,
    enabled: job.enabled,
    archive: job.archive,
    schedule: job.schedule,
    verifySchedule: job.verifySchedule,
    retentionPolicyId: job.retentionPolicyId,
    settings,
    hooks: hookDetails(job.settings ?? {}),
    ...(job.kind === "copy"
      ? {
          sourceFileShareId: job.sourceFileShareId,
          targetFileShareId: job.targetFileShareId,
          mode: job.settings.mode ?? "overwrite",
          mirrorConfirmed: Boolean(job.settings.mirrorConfirmedAt),
        }
      : {}),
  };
}

export async function createBackupJob(
  db: Database,
  tenantId: string,
  input: CreateBackupJobInput,
  actor: JobActor,
  context: JobContext,
  options: ReadOptions,
): Promise<BackupJobDto> {
  const { now } = context;
  const kind = input.kind;
  const { schedule, verifySchedule } = checkedBase(kind, input, now);
  let settings = checkedSettings(kind, input.settings, { requirePaths: true });
  if (kind !== "copy" && (input.sourceFileShareId || input.targetFileShareId)) {
    throw jobProblem(
      [input.sourceFileShareId ? "sourceFileShareId" : "targetFileShareId"],
      "not_a_copy_job",
      "Only a copy job names a source and a target file share.",
    );
  }
  if (kind === "copy") {
    if (input.scope.mode === "all" || input.scope.members.length > 0) {
      throw jobProblem(["scope"], "members_not_supported", "A copy job has no members.");
    }
    const { source, target } = await withTenantTx(db, tenantId, (tx) =>
      loadCopyShares(tx, tenantId, input.sourceFileShareId, input.targetFileShareId),
    );
    assertCopyRules(source, target, settings);
    settings = await confirmedCopySettings(
      db,
      tenantId,
      target,
      settings,
      null,
      input.confirmMirror,
      actor,
      context,
    );
  }
  if (kind === "share" && input.scope.mode === "all") {
    throw jobProblem(
      ["scope", "mode"],
      "scope_all_not_supported",
      "A file share job covers the shares you choose.",
    );
  }
  if ((kind === "share" || kind === "copy") && input.archive) {
    throw jobProblem(["archive"], "archive_not_supported", archiveMessage());
  }
  if (kind === "endpoint" && input.scope.mode === "all") {
    throw jobProblem(
      ["scope", "mode"],
      "scope_all_not_supported",
      "A machine job covers the machines you choose; machines enrolled later are not added by themselves.",
    );
  }
  if (kind === "endpoint" && input.enabled === false) {
    throw jobProblem(["enabled"], "pause_not_supported", pauseMessage());
  }
  if (kind === "endpoint" && input.archive) {
    throw jobProblem(["archive"], "archive_not_supported", archiveMessage());
  }
  return withTenantTx(db, tenantId, async (tx) => {
    const storageTargetId = await checkRepository(tx, tenantId, input.storageTargetId);
    const retentionPolicyId = await checkRetentionPolicy(tx, tenantId, input.retentionPolicyId);
    await assertNameFree(tx, tenantId, kind, input.name, null);
    if (input.scope.mode === "all") {
      await assertNoOtherAllJob(tx, tenantId, kind, null);
    }
    const members = resolveInputs(kind, input.scope.members, now, ["scope", "members"]);
    await assertTargets(
      tx,
      tenantId,
      kind,
      members.map((m) => m.targetId),
      (i) => ["scope", "members", String(i), "id"],
    );
    const moved = await releaseTargets(
      tx,
      tenantId,
      null,
      kind,
      members.map((member) => member.targetId),
      input.moveMembers,
    );
    let job: BackupJob | undefined;
    try {
      [job] = await tx
        .insert(backupJobs)
        .values({
          tenantId,
          kind,
          name: input.name,
          scopeMode: input.scope.mode,
          schedule,
          verifySchedule,
          storageTargetId,
          retentionPolicyId,
          settings,
          enabled: input.enabled,
          archive: input.archive,
          origin: "user",
          nextRunAt: kind === "endpoint" ? null : nextOf(schedule, now, null),
          verifyNextRunAt: kind === "mail" ? nextOf(verifySchedule, now, null) : null,
          sourceFileShareId: kind === "copy" ? (input.sourceFileShareId ?? null) : null,
          targetFileShareId: kind === "copy" ? (input.targetFileShareId ?? null) : null,
          createdBy: actor.userId,
        })
        .returning();
    } catch (error) {
      throw translateUnique(error, input.name);
    }
    if (!job) {
      throw new Error("backup job insert returned no row");
    }
    assertSupportedJob(job);
    await insertMembers(tx, tenantId, job, members, now);
    if (kind === "endpoint") {
      await syncEndpointConfigs(tx, tenantId, job, {
        actor,
        now,
        confirmHookChange: context.confirmHookChange,
      });
    }
    await auditMoved(tx, tenantId, actor, moved, { id: job.id, name: job.name });
    await auditJob(tx, tenantId, actor, BACKUP_JOB_AUDIT_ACTIONS.created, job.id, {
      ...definitionOf(job),
      members: members.length,
      overrides: members.filter((member) => Object.keys(member.overrides).length > 0).length,
    });
    return jobDto(tx, tenantId, job.id, options, now);
  });
}

/** Why a machine job cannot archive: the archive is mail captured by journaling. */
function archiveMessage(): string {
  return "Archiving is for mail jobs: Exchange journals every mail of their mailboxes to the archive. A machine job keeps snapshots only.";
}

function pauseMessage(): string {
  return "A machine job cannot be paused: the agent on each machine decides when to back up. Remove the machine from the job to stop it.";
}

async function assertNameFree(
  tx: Transaction,
  tenantId: string,
  kind: JobKind,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const rows = await tx
    .select({ id: backupJobs.id })
    .from(backupJobs)
    .where(
      and(
        eq(backupJobs.tenantId, tenantId),
        eq(backupJobs.kind, kind),
        sql`lower(${backupJobs.name}) = lower(${name})`,
      ),
    );
  if (rows.some((row) => row.id !== exceptId)) {
    throw jobProblem(["name"], "name_taken", "Another job of this kind has this name.");
  }
}

async function assertNoOtherAllJob(
  tx: Transaction,
  tenantId: string,
  kind: JobKind,
  exceptId: string | null,
): Promise<void> {
  const rows = await tx
    .select({ id: backupJobs.id, name: backupJobs.name })
    .from(backupJobs)
    .where(
      and(
        eq(backupJobs.tenantId, tenantId),
        eq(backupJobs.kind, kind),
        eq(backupJobs.scopeMode, "all"),
      ),
    );
  const other = rows.find((row) => row.id !== exceptId);
  if (other) {
    throw new ProblemError(409, "Another job covers all objects", {
      type: JOB_STATE_PROBLEM,
      detail: `"${other.name}" already covers every object that is in no other job; there is one such job per tenant.`,
      extensions: { code: "all_job_exists", jobId: other.id, jobName: other.name },
    });
  }
}

function translateUnique(error: unknown, name: string): unknown {
  if (isUnique(error, UNIQUE_NAME)) {
    return jobProblem(["name"], "name_taken", `Another job of this kind is named "${name}".`);
  }
  if (isUnique(error, UNIQUE_ALL)) {
    return new ProblemError(409, "Another job covers all objects", {
      type: JOB_STATE_PROBLEM,
      extensions: { code: "all_job_exists" },
    });
  }
  return error;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/** The fields that differ, old and new (a hook text only as fingerprint). */
function describeChanges(before: BackupJob, after: BackupJob): Record<string, unknown> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const compare = (key: string, from: unknown, to: unknown) => {
    if (!sameJson(from, to)) {
      changes[key] = { from, to };
    }
  };
  compare("name", before.name, after.name);
  compare("enabled", before.enabled, after.enabled);
  compare("archive", before.archive, after.archive);
  if (!sameSchedule(before.schedule, after.schedule)) {
    changes.schedule = { from: before.schedule, to: after.schedule };
  }
  if (!sameSchedule(before.verifySchedule, after.verifySchedule)) {
    changes.verifySchedule = { from: before.verifySchedule, to: after.verifySchedule };
  }
  compare("storageTargetId", before.storageTargetId, after.storageTargetId);
  compare("sourceFileShareId", before.sourceFileShareId, after.sourceFileShareId);
  compare("targetFileShareId", before.targetFileShareId, after.targetFileShareId);
  compare("retentionPolicyId", before.retentionPolicyId, after.retentionPolicyId);
  const a = before.settings ?? {};
  const b = after.settings ?? {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === "hooks") {
      compare("settings.hooks", hookDetails(a), hookDetails(b));
    } else {
      compare(
        `settings.${key}`,
        a[key as keyof BackupJobSettings],
        b[key as keyof BackupJobSettings],
      );
    }
  }
  return changes;
}

export async function updateBackupJob(
  db: Database,
  tenantId: string,
  id: string,
  patch: UpdateBackupJobInput,
  actor: JobActor,
  context: JobContext,
  options: ReadOptions,
): Promise<BackupJobDto> {
  const { now } = context;
  return withTenantTx(db, tenantId, async (tx) => {
    const [before] = await tx
      .select()
      .from(backupJobs)
      .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.id, id)))
      .for("update");
    if (!before) {
      throw new ProblemError(404, "Backup job not found");
    }
    assertSupportedJob(before);
    const kind = before.kind;
    const scheduleGiven = patch.schedule !== undefined;
    const base = checkedBase(
      kind,
      {
        schedule: scheduleGiven ? patch.schedule : before.schedule,
        verifySchedule:
          patch.verifySchedule !== undefined ? patch.verifySchedule : before.verifySchedule,
        retentionPolicyId:
          patch.retentionPolicyId !== undefined
            ? patch.retentionPolicyId
            : before.retentionPolicyId,
      },
      now,
    );
    if (patch.name !== undefined && patch.name !== before.name) {
      await assertNameFree(tx, tenantId, kind, patch.name, id);
    }
    if (kind === "endpoint" && patch.enabled === false) {
      throw jobProblem(["enabled"], "pause_not_supported", pauseMessage());
    }
    if (kind !== "mail" && patch.archive) {
      throw jobProblem(["archive"], "archive_not_supported", archiveMessage());
    }
    let settings =
      patch.settings !== undefined
        ? checkedSettings(kind, patch.settings, { requirePaths: true })
        : (before.settings ?? {});
    let sourceFileShareId = before.sourceFileShareId;
    let targetFileShareId = before.targetFileShareId;
    if (kind !== "copy" && (patch.sourceFileShareId || patch.targetFileShareId)) {
      throw jobProblem(
        [patch.sourceFileShareId ? "sourceFileShareId" : "targetFileShareId"],
        "not_a_copy_job",
        "Only a copy job names a source and a target file share.",
      );
    }
    if (kind === "copy") {
      sourceFileShareId = patch.sourceFileShareId ?? before.sourceFileShareId;
      targetFileShareId = patch.targetFileShareId ?? before.targetFileShareId;
      const { source, target } = await loadCopyShares(
        tx,
        tenantId,
        sourceFileShareId,
        targetFileShareId,
      );
      assertCopyRules(source, target, settings);
      settings = await confirmedCopySettings(
        db,
        tenantId,
        target,
        settings,
        { targetId: before.targetFileShareId, settings: before.settings ?? {} },
        patch.confirmMirror === true,
        actor,
        context,
      );
    }
    const storageTargetId =
      patch.storageTargetId !== undefined
        ? await checkRepository(tx, tenantId, patch.storageTargetId)
        : before.storageTargetId;
    const retentionPolicyId =
      patch.retentionPolicyId !== undefined
        ? await checkRetentionPolicy(tx, tenantId, patch.retentionPolicyId)
        : before.retentionPolicyId;
    const enabled = patch.enabled ?? before.enabled;
    const scheduleChanged = !sameSchedule(base.schedule, before.schedule);
    const verifyChanged = !sameSchedule(base.verifySchedule, before.verifySchedule);
    const resumed = !before.enabled && enabled;
    const [after] = await tx
      .update(backupJobs)
      .set({
        name: patch.name ?? before.name,
        schedule: base.schedule,
        verifySchedule: kind === "mail" ? base.verifySchedule : null,
        storageTargetId,
        retentionPolicyId,
        settings,
        enabled,
        archive: patch.archive ?? before.archive,
        sourceFileShareId,
        targetFileShareId,
        // A new or resumed cadence starts from its last run; an untouched one keeps its timer.
        ...(kind !== "endpoint" && (scheduleChanged || resumed)
          ? { nextRunAt: nextOf(base.schedule, now, before.lastRunAt) }
          : {}),
        ...(kind === "mail" && (verifyChanged || resumed)
          ? { verifyNextRunAt: nextOf(base.verifySchedule, now, before.verifyLastRunAt) }
          : {}),
      })
      .where(eq(backupJobs.id, id))
      .returning();
    if (!after) {
      throw new ProblemError(404, "Backup job not found");
    }
    const changes = describeChanges(before, after);
    if (Object.keys(changes).length === 0) {
      return jobDto(tx, tenantId, id, options, now);
    }
    let synced = 0;
    if (kind === "endpoint" && (scheduleChanged || patch.settings !== undefined)) {
      const result = await syncEndpointConfigs(tx, tenantId, after, {
        actor,
        now,
        confirmHookChange: context.confirmHookChange,
      });
      synced = result.updated.length;
    }
    await auditJob(tx, tenantId, actor, BACKUP_JOB_AUDIT_ACTIONS.updated, id, {
      name: after.name,
      kind,
      changes,
      ...(kind === "endpoint" ? { machinesUpdated: synced } : {}),
    });
    return jobDto(tx, tenantId, id, options, now);
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteBackupJob(
  db: Database,
  tenantId: string,
  id: string,
  actor: JobActor,
  now: Date = new Date(),
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    const job = await loadJob(tx, tenantId, id);
    const members = await tx
      .select({ id: backupJobMembers.id, endpointId: backupJobMembers.endpointId })
      .from(backupJobMembers)
      .where(eq(backupJobMembers.jobId, id));
    // The schedules this job replaced stay replaced (no foreign key on purpose): deleting a job
    // never revives them. Its machines go back to waiting for a job (schedule `none`).
    await tx.delete(backupJobs).where(eq(backupJobs.id, id));
    if (job.kind === "endpoint") {
      await releaseEndpointConfigs(
        tx,
        tenantId,
        job,
        members.flatMap((member) => (member.endpointId ? [member.endpointId] : [])),
        { actor, now },
      );
    }
    await auditJob(tx, tenantId, actor, BACKUP_JOB_AUDIT_ACTIONS.deleted, id, {
      ...definitionOf(job),
      members: members.length,
    });
  });
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

function overridesOf(member: BackupJobMember): JobMemberOverrides {
  return member.overrides ?? {};
}

export async function replaceMembers(
  db: Database,
  tenantId: string,
  id: string,
  input: ReplaceMembersInput,
  actor: JobActor,
  context: JobContext,
  options: ReadOptions,
): Promise<BackupJobDto> {
  const { now } = context;
  return withTenantTx(db, tenantId, async (tx) => {
    const [job] = await tx
      .select()
      .from(backupJobs)
      .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.id, id)))
      .for("update");
    if (!job) {
      throw new ProblemError(404, "Backup job not found");
    }
    assertSupportedJob(job);
    assertHasMembers(job);
    const mode = input.mode ?? job.scopeMode;
    if ((job.kind === "endpoint" || job.kind === "share") && mode === "all") {
      throw jobProblem(
        ["mode"],
        "scope_all_not_supported",
        "A machine job covers the machines you choose.",
      );
    }
    if (mode === "all" && job.scopeMode !== "all") {
      await assertNoOtherAllJob(tx, tenantId, job.kind, id);
    }
    const wanted = resolveInputs(job.kind, input.members, now, ["members"]);
    await assertTargets(
      tx,
      tenantId,
      job.kind,
      wanted.map((m) => m.targetId),
      (i) => ["members", String(i), "id"],
    );
    const existing = await tx.select().from(backupJobMembers).where(eq(backupJobMembers.jobId, id));
    const existingByTarget = new Map(existing.map((member) => [targetOf(member), member]));
    const wantedIds = new Set(wanted.map((member) => member.targetId));
    const removed = existing.filter((member) => !wantedIds.has(targetOf(member)));
    const added = wanted.filter((member) => !existingByTarget.has(member.targetId));
    const moved = await releaseTargets(
      tx,
      tenantId,
      id,
      job.kind,
      added.map((member) => member.targetId),
      input.move,
    );
    if (removed.length > 0) {
      await tx.delete(backupJobMembers).where(
        inArray(
          backupJobMembers.id,
          removed.map((member) => member.id),
        ),
      );
    }
    let overridesChanged = 0;
    const touched: string[] = [];
    for (const member of wanted) {
      const before = existingByTarget.get(member.targetId);
      if (before && !sameJson(overridesOf(before), member.overrides)) {
        await tx
          .update(backupJobMembers)
          .set({ overrides: member.overrides, ...timers(job.kind, member.overrides, now, before) })
          .where(eq(backupJobMembers.id, before.id));
        overridesChanged++;
        touched.push(member.targetId);
      }
    }
    await insertMembers(tx, tenantId, job, added, now);
    if (mode !== job.scopeMode) {
      await tx.update(backupJobs).set({ scopeMode: mode }).where(eq(backupJobs.id, id));
    }
    if (job.kind === "endpoint") {
      await syncEndpointConfigs(tx, tenantId, job, {
        targetIds: [...added.map((member) => member.targetId), ...touched],
        actor,
        now,
        confirmHookChange: context.confirmHookChange,
      });
      await releaseEndpointConfigs(
        tx,
        tenantId,
        job,
        removed.map((member) => targetOf(member)),
        { actor, now },
      );
    }
    if (added.length + removed.length + overridesChanged > 0 || mode !== job.scopeMode) {
      await auditMoved(tx, tenantId, actor, moved, { id, name: job.name });
      await auditJob(tx, tenantId, actor, BACKUP_JOB_AUDIT_ACTIONS.scopeChanged, id, {
        name: job.name,
        mode,
        previousMode: job.scopeMode,
        added: added.length,
        removed: removed.length,
        overridesChanged,
        targets: [
          ...added.map((member) => member.targetId),
          ...removed.map((member) => targetOf(member)),
        ].slice(0, 50),
      });
    }
    return jobDto(tx, tenantId, id, options, now);
  });
}

export async function addMembers(
  db: Database,
  tenantId: string,
  id: string,
  input: AddMembersInput,
  actor: JobActor,
  context: JobContext,
  options: ReadOptions,
): Promise<BackupJobDto> {
  const { now } = context;
  return withTenantTx(db, tenantId, async (tx) => {
    const job = await loadJob(tx, tenantId, id);
    assertHasMembers(job);
    const wanted = resolveInputs(job.kind, input.members, now, ["members"]);
    await assertTargets(
      tx,
      tenantId,
      job.kind,
      wanted.map((m) => m.targetId),
      (i) => ["members", String(i), "id"],
    );
    const existing = await tx.select().from(backupJobMembers).where(eq(backupJobMembers.jobId, id));
    const have = new Set(existing.map((member) => targetOf(member)));
    const fresh = wanted.filter((member) => !have.has(member.targetId));
    const moved = await releaseTargets(
      tx,
      tenantId,
      id,
      job.kind,
      fresh.map((member) => member.targetId),
      input.move,
    );
    await insertMembers(tx, tenantId, job, fresh, now);
    if (job.kind === "endpoint") {
      await syncEndpointConfigs(tx, tenantId, job, {
        targetIds: fresh.map((member) => member.targetId),
        actor,
        now,
        confirmHookChange: context.confirmHookChange,
      });
    }
    if (fresh.length > 0) {
      await auditMoved(tx, tenantId, actor, moved, { id, name: job.name });
      await auditJob(tx, tenantId, actor, BACKUP_JOB_AUDIT_ACTIONS.scopeChanged, id, {
        name: job.name,
        mode: job.scopeMode,
        added: fresh.length,
        removed: 0,
        overridesChanged: 0,
        targets: fresh.map((member) => member.targetId).slice(0, 50),
      });
    }
    return jobDto(tx, tenantId, id, options, now);
  });
}

export async function removeMember(
  db: Database,
  tenantId: string,
  id: string,
  targetId: string,
  actor: JobActor,
  options: ReadOptions,
  now: Date,
): Promise<BackupJobDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const job = await loadJob(tx, tenantId, id);
    assertHasMembers(job);
    const column = memberColumn(job.kind);
    const [member] = await tx
      .select()
      .from(backupJobMembers)
      .where(and(eq(backupJobMembers.jobId, id), eq(column, targetId)))
      .limit(1);
    if (!member) {
      throw new ProblemError(404, "Member not found", {
        detail: "This object or machine has no member row in the job.",
      });
    }
    await tx.delete(backupJobMembers).where(eq(backupJobMembers.id, member.id));
    if (job.kind === "endpoint") {
      await releaseEndpointConfigs(tx, tenantId, job, [targetId], { actor, now });
    }
    await auditJob(tx, tenantId, actor, BACKUP_JOB_AUDIT_ACTIONS.scopeChanged, id, {
      name: job.name,
      mode: job.scopeMode,
      added: 0,
      removed: 1,
      overridesChanged: 0,
      targets: [targetId],
    });
    return jobDto(tx, tenantId, id, options, now);
  });
}

export async function setMemberOverrides(
  db: Database,
  tenantId: string,
  id: string,
  targetId: string,
  input: SetOverridesInput,
  actor: JobActor,
  context: JobContext,
  options: ReadOptions,
): Promise<BackupJobDto> {
  const { now } = context;
  return withTenantTx(db, tenantId, async (tx) => {
    const job = await loadJob(tx, tenantId, id);
    assertHasMembers(job);
    const overrides = checkedOverrides(job.kind, input.overrides, now, ["overrides"]);
    const column = memberColumn(job.kind);
    const [member] = await tx
      .select()
      .from(backupJobMembers)
      .where(and(eq(backupJobMembers.jobId, id), eq(column, targetId)))
      .limit(1);
    if (member) {
      if (sameJson(overridesOf(member), overrides)) {
        return jobDto(tx, tenantId, id, options, now);
      }
      await tx
        .update(backupJobMembers)
        .set({ overrides, ...timers(job.kind, overrides, now, member) })
        .where(eq(backupJobMembers.id, member.id));
    } else if (job.kind === "mail" && job.scopeMode === "all") {
      // An "all" job covers the object without a row; the row appears with the first override.
      await assertTargets(tx, tenantId, "mail", [targetId], () => ["targetId"]);
      const covered = await loadAllMembers(tx, tenantId);
      if (covered.some((row) => row.protectedObjectId === targetId)) {
        throw new ProblemError(409, "Already in another job", {
          type: IN_OTHER_JOB_PROBLEM,
          detail: "This object belongs to another job.",
        });
      }
      await insertMembers(tx, tenantId, job, [{ targetId, overrides }], now);
    } else {
      throw new ProblemError(404, "Member not found", {
        detail: "This object or machine is not in the job.",
      });
    }
    if (job.kind === "endpoint") {
      await syncEndpointConfigs(tx, tenantId, job, {
        targetIds: [targetId],
        actor,
        now,
        confirmHookChange: context.confirmHookChange,
      });
    }
    await auditJob(tx, tenantId, actor, BACKUP_JOB_AUDIT_ACTIONS.scopeChanged, id, {
      name: job.name,
      mode: job.scopeMode,
      added: 0,
      removed: 0,
      overridesChanged: 1,
      targets: [targetId],
      overrides: Object.keys(overrides),
    });
    return jobDto(tx, tenantId, id, options, now);
  });
}

// ---------------------------------------------------------------------------
// Run now
// ---------------------------------------------------------------------------

export async function runBackupJob(
  db: Database,
  tenantId: string,
  id: string,
  input: RunBackupJobInput,
  actor: JobActor,
  now: Date,
): Promise<RunBackupJobResult> {
  return withTenantTx(db, tenantId, async (tx) => {
    const job = await loadJob(tx, tenantId, id);
    const result: RunBackupJobResult = { queued: 0, skipped: [] };
    const members = await loadAllMembers(tx, tenantId);
    if (job.kind === "mail") {
      const objects = await loadObjectInfos(tx, tenantId);
      const byId = new Map(objects.map((object) => [object.id, object]));
      const covered = new Set(
        mailJobObjectIds(
          job,
          members.filter((member) => member.protectedObjectId !== null) as {
            jobId: string;
            protectedObjectId: string;
          }[],
          objects,
        ),
      );
      // "Run now" also reaches an excluded or orphaned member and says why it was not queued.
      const explicit = members
        .filter((member) => member.jobId === id && member.protectedObjectId)
        .map((member) => member.protectedObjectId as string);
      const scope = input.targetIds ?? [...new Set([...covered, ...explicit])];
      const inJob = new Set([...covered, ...explicit]);
      for (const targetId of scope) {
        const object = byId.get(targetId);
        if (!object || !inJob.has(targetId)) {
          result.skipped.push({
            targetId,
            name: object ? objectName(object) : null,
            reason: "not_in_job",
          });
          continue;
        }
        const blocked = backupBlockedReason(object.status, object.sourceStatus);
        if (blocked) {
          result.skipped.push({ targetId, name: objectName(object), reason: blocked });
          continue;
        }
        let jobId: string | null;
        try {
          jobId = await enqueueBackup(tx, db, tenantId, targetId, input.full, {
            backupJobId: id,
            runNow: true,
          });
        } catch (error) {
          if (isMissingQueueSchema(error)) {
            throw new ProblemError(503, "Job queue not ready", {
              detail: "The worker has not set up its job queues yet. Try again in a minute.",
            });
          }
          throw error;
        }
        if (jobId === null) {
          result.skipped.push({ targetId, name: objectName(object), reason: "already_queued" });
        } else {
          result.queued++;
        }
      }
    } else if (job.kind === "share") {
      const own = members.filter((member) => member.jobId === id && member.fileShareId);
      const ownIds = new Set(own.map((member) => member.fileShareId as string));
      const scope = input.targetIds ?? [...ownIds];
      const rows = scope.length
        ? await tx
            .select()
            .from(fileShares)
            .where(and(eq(fileShares.tenantId, tenantId), inArray(fileShares.id, scope)))
        : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const targetId of scope) {
        const share = byId.get(targetId);
        const name = share?.name ?? null;
        if (!share || !ownIds.has(targetId)) {
          result.skipped.push({ targetId, name, reason: "not_in_job" });
          continue;
        }
        if (share.retiredAt) {
          result.skipped.push({ targetId, name, reason: "retired" });
          continue;
        }
        const [waiting] = await tx
          .select({ id: fileShareRuns.id })
          .from(fileShareRuns)
          .where(
            and(
              eq(fileShareRuns.fileShareId, targetId),
              eq(fileShareRuns.kind, "backup"),
              eq(fileShareRuns.status, "queued"),
            ),
          )
          .limit(1);
        if (waiting) {
          result.skipped.push({ targetId, name, reason: "already_queued" });
          continue;
        }
        const [run] = await tx
          .insert(fileShareRuns)
          .values({
            tenantId,
            fileShareId: targetId,
            lockShareId: targetId,
            kind: "backup",
            status: "queued",
            trigger: "manual",
            backupJobId: id,
            requestedBy: actor.userId,
            queuedAt: now,
          })
          .returning({ id: fileShareRuns.id });
        await auditShare(tx, {
          tenantId,
          actor,
          action: FILE_SHARE_TENANT_AUDIT_ACTIONS.backupRequested,
          shareId: targetId,
          details: {
            name: share.name,
            runId: run?.id ?? null,
            via: { job: { id, name: job.name } },
          },
        });
        result.queued++;
      }
    } else if (job.kind === "copy") {
      const targetId = job.targetFileShareId as string;
      const { source, target } = await loadCopyShares(
        tx,
        tenantId,
        job.sourceFileShareId,
        job.targetFileShareId,
      );
      assertCopyRules(source, target, job.settings ?? {});
      const [waiting] = await tx
        .select({ id: fileShareRuns.id })
        .from(fileShareRuns)
        .where(
          and(
            eq(fileShareRuns.backupJobId, id),
            inArray(fileShareRuns.status, ["queued", "starting", "running"]),
          ),
        )
        .limit(1);
      if (waiting) {
        result.skipped.push({ targetId, name: target.name, reason: "already_queued" });
      } else {
        await tx.insert(fileShareRuns).values({
          tenantId,
          fileShareId: source.id,
          lockShareId: target.id,
          targetShareId: target.id,
          kind: "restore",
          status: "queued",
          trigger: "copy",
          backupJobId: id,
          params: input.force ? { force: true } : {},
          requestedBy: actor.userId,
          queuedAt: now,
        });
        result.queued++;
      }
    } else {
      const own = members.filter((member) => member.jobId === id && member.endpointId);
      const ownIds = new Set(own.map((member) => member.endpointId as string));
      const scope = input.targetIds ?? [...ownIds];
      const rows = scope.length
        ? await tx
            .select()
            .from(endpoints)
            .where(and(eq(endpoints.tenantId, tenantId), inArray(endpoints.id, scope)))
        : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const targetId of scope) {
        const endpoint = byId.get(targetId);
        const name = endpoint ? endpoint.displayName?.trim() || endpoint.hostname : null;
        if (!endpoint || !ownIds.has(targetId)) {
          result.skipped.push({ targetId, name, reason: "not_in_job" });
          continue;
        }
        if (endpoint.status !== "active") {
          result.skipped.push({ targetId, name, reason: "revoked" });
          continue;
        }
        const [waiting] = await tx
          .select({ id: endpointTasks.id })
          .from(endpointTasks)
          .where(
            and(
              eq(endpointTasks.endpointId, targetId),
              eq(endpointTasks.kind, "backup_now"),
              inArray(endpointTasks.status, ["pending", "delivered"]),
            ),
          )
          .limit(1);
        if (waiting) {
          result.skipped.push({ targetId, name, reason: "already_queued" });
          continue;
        }
        const [task] = await tx
          .insert(endpointTasks)
          .values({
            tenantId,
            endpointId: targetId,
            kind: "backup_now",
            params: {},
            createdBy: actor.userId,
            createdAt: now,
            expiresAt: new Date(now.getTime() + AGENT_TASK_TTL_MS),
          })
          .returning();
        await auditEndpoint(tx, {
          tenantId,
          actor,
          action: ENDPOINT_AUDIT_ACTIONS.backupRequested,
          endpointId: targetId,
          details: {
            hostname: endpoint.hostname,
            taskId: task?.id ?? null,
            via: { job: { id, name: job.name } },
          },
        });
        result.queued++;
      }
    }
    await auditJob(tx, tenantId, actor, BACKUP_JOB_AUDIT_ACTIONS.runRequested, id, {
      name: job.name,
      kind: job.kind,
      queued: result.queued,
      skipped: result.skipped.length,
      selected: input.targetIds ? input.targetIds.length : null,
      full: job.kind === "mail" ? input.full : false,
      ...(job.kind === "copy" ? { force: input.force } : {}),
      targets: (input.targetIds ?? []).slice(0, 50),
    });
    return result;
  });
}
