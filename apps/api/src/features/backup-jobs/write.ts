import { randomUUID } from "node:crypto";
import {
  type JobKind,
  type JobMemberOverrides,
  type JobSchedule,
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
  backupJobMembers,
  backupJobs,
  endpointTasks,
  endpoints,
  retentionPolicies,
} from "@restow/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { ENDPOINT_AUDIT_ACTIONS, auditEndpoint } from "../endpoints/audit.js";
import { type BandwidthWindowsProblem, checkedBandwidthWindows } from "../endpoints/bandwidth.js";
import { hookFingerprint } from "../endpoints/dto.js";
import { AGENT_TASK_TTL_MS } from "../endpoints/service.js";
import { backupBlockedReason } from "../jobs/dto.js";
import { isMissingQueueSchema } from "../jobs/queue.js";
import { enqueueBackup } from "../jobs/service.js";
import type { BackupJobDto, RunBackupJobResult } from "./dto.js";
import { releaseEndpointConfigs, syncEndpointConfigs } from "./endpoint-sync.js";
import { sameJson } from "./json.js";
import { loadAllMembers, loadObjectInfos, loadPrimaryTarget, objectName } from "./loaders.js";
import { type ReadOptions, jobDto, loadJob } from "./read.js";
import {
  type AddMembersInput,
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
  return kind === "mail"
    ? normalizeMailSchedule(schedule)
    : jobScheduleFromEndpoint(endpointScheduleOf(schedule));
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

/** An override checked for the kind of job (a mail member only has schedules) and normalised. */
function checkedOverrides(
  kind: JobKind,
  overrides: JobMemberOverrides | undefined,
  now: Date,
  path: readonly string[],
): JobMemberOverrides {
  const input = overrides ?? {};
  const allowed: readonly string[] = kind === "mail" ? MAIL_OVERRIDE_KEYS : ENDPOINT_OVERRIDE_KEYS;
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !allowed.includes(key)) {
      throw jobProblem(
        [...path, key],
        "override_not_supported",
        kind === "mail"
          ? "A mailbox can only have its own schedule and restore check."
          : "A machine has no restore-check schedule of its own: every backup is checked.",
      );
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
  if (kind !== "mail") {
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

/** Machine settings checked for the job: a machine job needs folders, a mail job takes none. */
function checkedSettings(
  kind: JobKind,
  settings: BackupJobSettings,
  options: { requirePaths: boolean },
): BackupJobSettings {
  const entries = Object.entries(settings).filter(([, value]) => value !== undefined);
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
  const column = kind === "mail" ? backupJobMembers.protectedObjectId : backupJobMembers.endpointId;
  const rows = await tx
    .select({ member: backupJobMembers, jobName: backupJobs.name })
    .from(backupJobMembers)
    .innerJoin(backupJobs, eq(backupJobs.id, backupJobMembers.jobId))
    .where(and(eq(backupJobMembers.tenantId, tenantId), inArray(column, [...targetIds])));
  return rows.filter((row) => row.member.jobId !== jobId);
}

function targetOf(member: BackupJobMember): string {
  return (member.protectedObjectId ?? member.endpointId) as string;
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
      detail: `${conflicts.length} of the chosen ${kind === "mail" ? "objects" : "machines"} already belong to another job. An object or machine is in one job at a time.`,
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
  job: BackupJob,
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
      ...(job.kind === "mail"
        ? { protectedObjectId: member.targetId }
        : { endpointId: member.targetId }),
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
    schedule: job.schedule,
    verifySchedule: job.verifySchedule,
    retentionPolicyId: job.retentionPolicyId,
    settings,
    hooks: hookDetails(job.settings ?? {}),
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
  const settings = checkedSettings(kind, input.settings, { requirePaths: true });
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
          origin: "user",
          nextRunAt: nextOf(schedule, now, null),
          verifyNextRunAt: kind === "mail" ? nextOf(verifySchedule, now, null) : null,
          createdBy: actor.userId,
        })
        .returning();
    } catch (error) {
      throw translateUnique(error, input.name);
    }
    if (!job) {
      throw new Error("backup job insert returned no row");
    }
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
  if (!sameSchedule(before.schedule, after.schedule)) {
    changes.schedule = { from: before.schedule, to: after.schedule };
  }
  if (!sameSchedule(before.verifySchedule, after.verifySchedule)) {
    changes.verifySchedule = { from: before.verifySchedule, to: after.verifySchedule };
  }
  compare("storageTargetId", before.storageTargetId, after.storageTargetId);
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
    const settings =
      patch.settings !== undefined
        ? checkedSettings(kind, patch.settings, { requirePaths: true })
        : (before.settings ?? {});
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
        // A new or resumed cadence starts from its last run; an untouched one keeps its timer.
        ...(kind === "mail" && (scheduleChanged || resumed)
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
    const mode = input.mode ?? job.scopeMode;
    if (job.kind === "endpoint" && mode === "all") {
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
    const column =
      job.kind === "mail" ? backupJobMembers.protectedObjectId : backupJobMembers.endpointId;
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
    const overrides = checkedOverrides(job.kind, input.overrides, now, ["overrides"]);
    const column =
      job.kind === "mail" ? backupJobMembers.protectedObjectId : backupJobMembers.endpointId;
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
      targets: (input.targetIds ?? []).slice(0, 50),
    });
    return result;
  });
}
