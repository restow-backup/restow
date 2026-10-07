import {
  DEFAULT_ENDPOINT_RETENTION,
  DEFAULT_SCHEDULE_TIMEZONE,
  RECOMMENDED_SCHEDULE_DEFAULTS,
  defaultEndpointConfig,
  defaultSchedule,
  effectiveSchedule,
  effectiveSettings,
  mailJobObjectIds,
} from "@restow/core";
import {
  type BackupJob,
  type BackupJobMember,
  type BackupJobSettings,
  backupJobMembers,
  backupJobs,
  endpointRuns,
  endpoints,
  jobs,
  tenants,
} from "@restow/db";
import type { Database } from "@restow/db";
import { type SQL, and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { coverageOf, mailCoverageOf, runsOnSchedule } from "./coverage.js";
import type {
  BackupJobDto,
  BackupJobListDto,
  BackupJobMemberDto,
  BackupJobMembersDto,
  BackupJobRunsDto,
  JobCandidateDto,
  JobCandidatesDto,
  JobDefaultsDto,
  JobKindName,
  JobLastRunDto,
  JobRunDto,
  JobScopeDto,
} from "./dto.js";
import { earliestOf, isOverdue, iso, jobStateOf, latestOf, nextCheckInOf } from "./dto.js";
import {
  type EndpointFact,
  type MailFact,
  type ObjectInfo,
  type SnapshotPolicyInfo,
  endpointName,
  loadAllMembers,
  loadEndpointFacts,
  loadMailFacts,
  loadObjectInfos,
  loadPrimaryTarget,
  loadRepositoryOf,
  loadSnapshotPolicies,
  objectName,
  repositoryDto,
  restoreCheckOf,
} from "./loaders.js";

/**
 * Reading jobs: the list with how each one stands, one job, its members, the runs of its scope,
 * the choices of the editor. Every read runs in the tenant's pinned transaction; none writes.
 */

export const NOT_FOUND = () => new ProblemError(404, "Backup job not found");

/** A hook text is shown only to who may change the configuration (it may hold credentials). */
export interface ReadOptions {
  revealHooks: boolean;
}

const HIDDEN_HOOK = "********";

/** The settings as the viewer may see them. */
export function visibleSettings(settings: BackupJobSettings, reveal: boolean): BackupJobSettings {
  if (reveal || !settings.hooks) {
    return settings;
  }
  const hooks: { pre?: string; post?: string } = {};
  if (settings.hooks.pre) hooks.pre = HIDDEN_HOOK;
  if (settings.hooks.post) hooks.post = HIDDEN_HOOK;
  return { ...settings, hooks };
}

export async function loadJob(tx: Transaction, tenantId: string, id: string): Promise<BackupJob> {
  const [row] = await tx
    .select()
    .from(backupJobs)
    .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.id, id)))
    .limit(1);
  if (!row) {
    throw NOT_FOUND();
  }
  return row;
}

// ---------------------------------------------------------------------------
// The state of a tenant's jobs
// ---------------------------------------------------------------------------

interface TenantFacts {
  objects: ObjectInfo[];
  members: BackupJobMember[];
  /** Per mail job, the objects it covers. */
  covered: Map<string, string[]>;
  mail: Map<string, MailFact>;
  endpoint: Map<string, EndpointFact>;
}

/** What the DTOs of `list` need, in a fixed number of queries whatever the number of jobs. */
async function loadFacts(
  tx: Transaction,
  tenantId: string,
  all: readonly BackupJob[],
  now: Date,
): Promise<TenantFacts> {
  const members = await loadAllMembers(tx, tenantId);
  const mailJobs = all.filter((job) => job.kind === "mail");
  const objects = mailJobs.length > 0 ? await loadObjectInfos(tx, tenantId) : [];
  const covered = new Map<string, string[]>();
  for (const job of mailJobs) {
    covered.set(
      job.id,
      mailJobObjectIds(
        job,
        members.filter((member) => member.protectedObjectId !== null) as {
          jobId: string;
          protectedObjectId: string;
        }[],
        objects,
      ),
    );
  }
  const mailIds = [...new Set([...covered.values()].flat())];
  const endpointIds = members.flatMap((member) => (member.endpointId ? [member.endpointId] : []));
  return {
    objects,
    members,
    covered,
    mail: await loadMailFacts(tx, tenantId, mailIds),
    endpoint: await loadEndpointFacts(tx, tenantId, endpointIds, now),
  };
}

function policyNameOf(job: BackupJob, policies: readonly SnapshotPolicyInfo[]): string | null {
  const named = job.retentionPolicyId
    ? policies.find((policy) => policy.id === job.retentionPolicyId)
    : undefined;
  return (named ?? policies.find((policy) => policy.isDefault))?.name ?? null;
}

/** What `outcomeCounts` needs of a member's newest backup. */
interface MemberOutcome {
  status: string | null;
  finishedAt: Date | null;
  /** The newest backup of the member, whatever its state. */
  runId: string | null;
  /** The newest backup of the member that finished. */
  finishedRunId: string | null;
  /** A requested backup waits for the machine and none is running. */
  queued?: boolean;
}

function outcomeCounts(states: readonly MemberOutcome[]): JobLastRunDto {
  let failed = 0;
  let partial = 0;
  let running = 0;
  let queued = 0;
  let runningRun: string | null = null;
  let newest: { at: Date; runId: string } | null = null;
  for (const state of states) {
    if (state.status === "failed") failed++;
    else if (state.status === "partial") partial++;
    else if (state.status === "running" || state.status === "active") {
      running++;
      runningRun ??= state.runId;
    } else if (state.queued) {
      queued++;
    }
    if (state.finishedAt && state.finishedRunId && (!newest || state.finishedAt > newest.at)) {
      newest = { at: state.finishedAt, runId: state.finishedRunId };
    }
  }
  return {
    at: iso(latestOf(states.map((state) => state.finishedAt))),
    failed,
    partial,
    running,
    queued,
    runId: runningRun ?? newest?.runId ?? null,
  };
}

function mailJobDto(
  job: BackupJob,
  facts: TenantFacts,
  repository: BackupJobDto["repository"],
  policies: readonly SnapshotPolicyInfo[],
  reveal: boolean,
  now: Date,
): BackupJobDto {
  const coveredIds = facts.covered.get(job.id) ?? [];
  const own = facts.members.filter((member) => member.jobId === job.id);
  const ownByObject = new Map(own.map((member) => [member.protectedObjectId, member]));
  const objectsById = new Map(facts.objects.map((object) => [object.id, object]));
  const byKind: Record<string, number> = {};
  const states: { state: MailFact["restore"]["state"]; checkedAt: Date | null }[] = [];
  const runs: MemberOutcome[] = [];
  const times: (Date | null)[] = [];
  let overrides = 0;
  let jobLevel = 0;
  for (const id of coveredIds) {
    const object = objectsById.get(id);
    if (object) byKind[object.kind] = (byKind[object.kind] ?? 0) + 1;
    const fact = facts.mail.get(id);
    states.push(fact?.restore ?? { state: "no_backup", checkedAt: null });
    runs.push({
      status: fact?.latest?.status ?? null,
      finishedAt: fact?.finishedAt ?? null,
      runId: fact?.latest?.id ?? null,
      finishedRunId: fact?.finishedId ?? null,
    });
    const member = ownByObject.get(id);
    if (member?.overrides.schedule) {
      times.push(member.nextRunAt);
    } else {
      jobLevel++;
    }
  }
  for (const member of own) {
    if (Object.keys(member.overrides).length > 0) overrides++;
  }
  if (jobLevel > 0 && job.schedule) {
    times.push(job.nextRunAt);
  }
  const scope: JobScopeDto = { count: coveredIds.length, byKind, overrides };
  const lastRun = outcomeCounts(runs);
  const restoreCheck = restoreCheckOf(states);
  const nextRunAt = job.enabled && coveredIds.length > 0 ? earliestOf(times.filter(Boolean)) : null;
  const ownSchedules = coveredIds.some((id) => ownByObject.get(id)?.overrides.schedule);
  return {
    id: job.id,
    kind: job.kind,
    name: job.name,
    enabled: job.enabled,
    archive: job.archive,
    origin: job.origin,
    scopeMode: job.scopeMode,
    schedule: job.schedule,
    verifySchedule: job.verifySchedule,
    repository,
    retention: {
      policyId: job.retentionPolicyId,
      policyName: policyNameOf(job, policies),
      keep: null,
    },
    scope,
    lastRun,
    nextRunAt: iso(nextRunAt),
    restoreCheck,
    state: jobStateOf({
      enabled: job.enabled,
      scopeCount: scope.count,
      failed: lastRun.failed,
      running: lastRun.running,
      queued: lastRun.queued,
      partial: lastRun.partial,
      restore: restoreCheck,
      manual: job.schedule === null && !ownSchedules,
      overdue: isOverdue({
        schedule: job.schedule,
        nextRunAt,
        lastAt: lastRun.at,
        createdAt: job.createdAt,
        now,
      }),
      storageError: repository.status === "error",
    }),
    settings: visibleSettings(job.settings ?? {}, reveal),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

/** A backup requested for the machine waits, and none is running now. */
function memberQueued(fact: EndpointFact): boolean {
  return fact.pendingBackup !== null && fact.latest?.status !== "running";
}

function endpointJobDto(
  job: BackupJob,
  facts: TenantFacts,
  repository: BackupJobDto["repository"],
  reveal: boolean,
  now: Date,
): BackupJobDto {
  const own = facts.members.filter((member) => member.jobId === job.id && member.endpointId);
  const live = own.filter(
    (member) => facts.endpoint.get(member.endpointId as string)?.status === "active",
  );
  const byKind: Record<string, number> = {};
  const states: { state: MailFact["restore"]["state"]; checkedAt: Date | null }[] = [];
  const runs: MemberOutcome[] = [];
  const next: (Date | null)[] = [];
  let overrides = 0;
  for (const member of live) {
    const fact = facts.endpoint.get(member.endpointId as string) as EndpointFact;
    byKind[fact.profile] = (byKind[fact.profile] ?? 0) + 1;
    states.push(fact.restore);
    runs.push({
      // An acknowledged warning (features/warnings) no longer asks for attention.
      status:
        fact.latest?.status === "partial" && fact.warningAcknowledged
          ? "succeeded"
          : (fact.latest?.status ?? null),
      finishedAt: fact.latest?.finishedAt ?? null,
      runId: fact.latest?.id ?? null,
      // An agent run that is over is the newest finished one; one still running has no end yet.
      finishedRunId: fact.latest?.finishedAt ? fact.latest.id : null,
      queued: memberQueued(fact),
    });
    next.push(fact.nextRunAt);
    if (Object.keys(member.overrides).length > 0) overrides++;
  }
  const scope: JobScopeDto = { count: live.length, byKind, overrides };
  const lastRun = outcomeCounts(runs);
  const restoreCheck = restoreCheckOf(states);
  const nextRunAt = earliestOf(next);
  const ownSchedules = live.some((member) => member.overrides.schedule);
  return {
    id: job.id,
    kind: job.kind,
    name: job.name,
    enabled: job.enabled,
    archive: job.archive,
    origin: job.origin,
    scopeMode: job.scopeMode,
    schedule: job.schedule,
    verifySchedule: null,
    repository,
    retention: { policyId: null, policyName: null, keep: job.settings?.retention ?? null },
    scope,
    lastRun,
    nextRunAt: iso(nextRunAt),
    restoreCheck,
    state: jobStateOf({
      enabled: job.enabled,
      scopeCount: scope.count,
      failed: lastRun.failed,
      running: lastRun.running,
      queued: lastRun.queued,
      partial: lastRun.partial,
      restore: restoreCheck,
      manual: job.schedule === null && !ownSchedules,
      overdue: isOverdue({
        schedule: job.schedule,
        nextRunAt,
        lastAt: lastRun.at,
        createdAt: job.createdAt,
        now,
      }),
      storageError: repository.status === "error",
    }),
    settings: visibleSettings(job.settings ?? {}, reveal),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

/** The DTOs of `selected` out of all the tenant's jobs (the others are needed for the scope rule). */
async function buildDtos(
  tx: Transaction,
  tenantId: string,
  all: readonly BackupJob[],
  selected: readonly BackupJob[],
  options: ReadOptions,
  now: Date,
): Promise<{ items: BackupJobDto[]; facts: TenantFacts }> {
  const facts = await loadFacts(tx, tenantId, all, now);
  const primary = await loadPrimaryTarget(tx, tenantId);
  const policies = selected.some((job) => job.kind === "mail")
    ? await loadSnapshotPolicies(tx, tenantId)
    : [];
  const items: BackupJobDto[] = [];
  for (const job of selected) {
    const repository = await loadRepositoryOf(tx, tenantId, job, primary);
    items.push(
      job.kind === "mail"
        ? mailJobDto(job, facts, repository, policies, options.revealHooks, now)
        : endpointJobDto(job, facts, repository, options.revealHooks, now),
    );
  }
  return { items, facts };
}

export async function listBackupJobs(
  db: Database,
  tenantId: string,
  query: { kind?: JobKindName },
  options: ReadOptions,
  now: Date = new Date(),
): Promise<BackupJobListDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const all = await tx
      .select()
      .from(backupJobs)
      .where(eq(backupJobs.tenantId, tenantId))
      .orderBy(asc(backupJobs.kind), asc(backupJobs.name));
    const selected = query.kind ? all.filter((job) => job.kind === query.kind) : all;
    const { items, facts } = await buildDtos(tx, tenantId, all, selected, options, now);
    // Without a mail job nothing was loaded for the scope rule; every eligible object is then uncovered.
    const objects = facts.objects.length > 0 ? facts.objects : await loadObjectInfos(tx, tenantId);
    const links = mailCoverageOf(all, facts.members, objects);
    const mail = { none: 0, unscheduled: 0 };
    for (const object of objects) {
      const coverage = coverageOf(object, links);
      if (coverage === "none") mail.none++;
      else if (coverage === "unscheduled") mail.unscheduled++;
    }
    const jobsById = new Map(all.map((job) => [job.id, job]));
    const machineMember = new Map(
      facts.members.flatMap((member) =>
        member.endpointId ? [[member.endpointId, member] as const] : [],
      ),
    );
    const active = await tx
      .select({ id: endpoints.id })
      .from(endpoints)
      .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.status, "active")));
    let uncoveredMachines = 0;
    let unscheduledMachines = 0;
    for (const row of active) {
      const member = machineMember.get(row.id);
      const job = member ? jobsById.get(member.jobId) : undefined;
      if (!member || !job) uncoveredMachines++;
      else if (!runsOnSchedule(job, member)) unscheduledMachines++;
    }
    return {
      items,
      uncovered: { mail: mail.none, endpoint: uncoveredMachines },
      unscheduled: { mail: mail.unscheduled, endpoint: unscheduledMachines },
    };
  });
}

export async function getBackupJob(
  db: Database,
  tenantId: string,
  id: string,
  options: ReadOptions,
  now: Date = new Date(),
): Promise<BackupJobDto> {
  return withTenantTx(db, tenantId, (tx) => jobDto(tx, tenantId, id, options, now));
}

/** One job's DTO inside an open transaction (the answer of every change). */
export async function jobDto(
  tx: Transaction,
  tenantId: string,
  id: string,
  options: ReadOptions,
  now: Date,
): Promise<BackupJobDto> {
  const all = await tx.select().from(backupJobs).where(eq(backupJobs.tenantId, tenantId));
  const job = all.find((candidate) => candidate.id === id);
  if (!job) {
    throw NOT_FOUND();
  }
  const { items } = await buildDtos(tx, tenantId, all, [job], options, now);
  return items[0] as BackupJobDto;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function listMembers(
  db: Database,
  tenantId: string,
  id: string,
  options: ReadOptions,
  now: Date = new Date(),
): Promise<BackupJobMembersDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const all = await tx.select().from(backupJobs).where(eq(backupJobs.tenantId, tenantId));
    const job = all.find((candidate) => candidate.id === id);
    if (!job) {
      throw NOT_FOUND();
    }
    const facts = await loadFacts(tx, tenantId, all, now);
    const own = facts.members.filter((member) => member.jobId === id);
    const items =
      job.kind === "mail"
        ? mailMembers(job, own, facts, options)
        : endpointMembers(job, own, facts, options);
    return { mode: job.scopeMode, items };
  });
}

function maskedOverrides(overrides: BackupJobMember["overrides"], reveal: boolean) {
  if (reveal || !overrides.hooks) {
    return overrides;
  }
  return { ...overrides, hooks: visibleSettings({ hooks: overrides.hooks }, false).hooks };
}

function mailMembers(
  job: BackupJob,
  own: readonly BackupJobMember[],
  facts: TenantFacts,
  options: ReadOptions,
): BackupJobMemberDto[] {
  const covered = new Set(facts.covered.get(job.id) ?? []);
  const ownByObject = new Map(own.map((member) => [member.protectedObjectId as string, member]));
  const objectsById = new Map(facts.objects.map((object) => [object.id, object]));
  const ids = [...new Set([...covered, ...ownByObject.keys()])];
  const items: BackupJobMemberDto[] = [];
  for (const id of ids) {
    const object = objectsById.get(id);
    if (!object) continue;
    const member = ownByObject.get(id);
    const overrides = member?.overrides ?? {};
    const fact = facts.mail.get(id);
    const isCovered = covered.has(id);
    const schedule = effectiveSchedule(job.schedule, overrides);
    items.push({
      targetId: id,
      kind: object.kind,
      name: objectName(object),
      detail: object.externalId,
      status: object.status,
      covered: isCovered,
      explicit: member !== undefined,
      overrides: maskedOverrides(overrides, options.revealHooks),
      effective: {
        schedule,
        verifySchedule: overrides.verifySchedule ?? job.verifySchedule,
        settings: {},
      },
      lastBackup: {
        at: iso(fact?.finishedAt ?? null),
        outcome: mailOutcome(fact?.latest?.status ?? null),
      },
      pendingBackup: null,
      restoreCheck: {
        state: fact?.restore.state ?? "no_backup",
        checkedAt: iso(fact?.restore.checkedAt ?? null),
      },
      nextRunAt:
        isCovered && job.enabled && schedule
          ? iso(overrides.schedule ? (member?.nextRunAt ?? null) : job.nextRunAt)
          : null,
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function mailOutcome(status: string | null): BackupJobMemberDto["lastBackup"]["outcome"] {
  switch (status) {
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "active":
      return "running";
    case "queued":
      return "queued";
    default:
      return null;
  }
}

function endpointMembers(
  job: BackupJob,
  own: readonly BackupJobMember[],
  facts: TenantFacts,
  options: ReadOptions,
): BackupJobMemberDto[] {
  const items: BackupJobMemberDto[] = [];
  for (const member of own) {
    const fact = member.endpointId ? facts.endpoint.get(member.endpointId) : undefined;
    if (!member.endpointId || !fact) continue;
    const overrides = member.overrides ?? {};
    items.push({
      targetId: member.endpointId,
      kind: fact.profile,
      name: endpointName(fact),
      detail: fact.os,
      status: fact.status,
      covered: fact.status === "active",
      explicit: true,
      overrides: maskedOverrides(overrides, options.revealHooks),
      effective: {
        schedule: effectiveSchedule(job.schedule, overrides),
        verifySchedule: null,
        settings: visibleSettings(
          effectiveSettings(job.settings ?? {}, overrides),
          options.revealHooks,
        ),
      },
      lastBackup: {
        at: iso(fact.latest?.finishedAt ?? null),
        outcome: memberQueued(fact) ? "queued" : (fact.latest?.status ?? null),
      },
      pendingBackup: fact.pendingBackup
        ? {
            status: fact.pendingBackup.status,
            requestedAt: fact.pendingBackup.requestedAt.toISOString(),
            nextCheckInAt: iso(nextCheckInOf(fact.lastSeenAt)),
          }
        : null,
      restoreCheck: { state: fact.restore.state, checkedAt: iso(fact.restore.checkedAt) },
      nextRunAt: iso(fact.nextRunAt),
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Runs of a job's scope
// ---------------------------------------------------------------------------

export async function listJobRuns(
  db: Database,
  tenantId: string,
  id: string,
  limit: number,
): Promise<BackupJobRunsDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const all = await tx.select().from(backupJobs).where(eq(backupJobs.tenantId, tenantId));
    const job = all.find((candidate) => candidate.id === id);
    if (!job) {
      throw NOT_FOUND();
    }
    const members = await loadAllMembers(tx, tenantId);
    const items: JobRunDto[] = [];
    if (job.kind === "mail") {
      const objects = await loadObjectInfos(tx, tenantId);
      const ids = mailJobObjectIds(
        job,
        members.filter((member) => member.protectedObjectId !== null) as {
          jobId: string;
          protectedObjectId: string;
        }[],
        objects,
      );
      // A job that was removed from its scope still shows what it did: the runs it queued itself.
      const names = new Map(objects.map((object) => [object.id, objectName(object)]));
      const scope = ids.length > 0 ? inArray(jobs.protectedObjectId, ids) : undefined;
      const mine = sql`${jobs.payload}->>'backupJobId' = ${id}`;
      const rows = await tx
        .select({
          id: jobs.id,
          queue: jobs.queue,
          status: jobs.status,
          objectId: jobs.protectedObjectId,
          startedAt: jobs.startedAt,
          completedAt: jobs.completedAt,
          createdAt: jobs.createdAt,
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.tenantId, tenantId),
            inArray(jobs.queue, ["backup", "verify"]),
            scope ? or(scope, mine) : mine,
          ),
        )
        .orderBy(desc(jobs.createdAt))
        .limit(limit);
      for (const row of rows) {
        items.push({
          id: row.id,
          source: "mail",
          type: row.queue,
          status: row.status,
          targetId: row.objectId,
          targetName: row.objectId ? (names.get(row.objectId) ?? null) : null,
          startedAt: iso(row.startedAt),
          finishedAt: iso(row.completedAt),
          createdAt: row.createdAt.toISOString(),
        });
      }
    } else {
      const ids = members
        .filter((member) => member.jobId === id && member.endpointId)
        .map((member) => member.endpointId as string);
      if (ids.length > 0) {
        const rows = await tx
          .select({
            id: endpointRuns.id,
            kind: endpointRuns.kind,
            status: endpointRuns.status,
            endpointId: endpointRuns.endpointId,
            startedAt: endpointRuns.startedAt,
            finishedAt: endpointRuns.finishedAt,
            createdAt: endpointRuns.createdAt,
            hostname: endpoints.hostname,
            displayName: endpoints.displayName,
          })
          .from(endpointRuns)
          .innerJoin(endpoints, eq(endpoints.id, endpointRuns.endpointId))
          .where(and(eq(endpointRuns.tenantId, tenantId), inArray(endpointRuns.endpointId, ids)))
          .orderBy(desc(endpointRuns.startedAt))
          .limit(limit);
        for (const row of rows) {
          items.push({
            id: row.id,
            source: "endpoint",
            type: row.kind,
            status: row.status,
            targetId: row.endpointId,
            targetName: row.displayName?.trim() || row.hostname,
            startedAt: row.startedAt.toISOString(),
            finishedAt: iso(row.finishedAt),
            createdAt: row.createdAt.toISOString(),
          });
        }
      }
    }
    return { items };
  });
}

// ---------------------------------------------------------------------------
// The editor's choices
// ---------------------------------------------------------------------------

export async function listCandidates(
  db: Database,
  tenantId: string,
  query: { kind: JobKindName; q?: string; limit: number },
): Promise<JobCandidatesDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const members = await loadAllMembers(tx, tenantId);
    const allJobs = await tx.select().from(backupJobs).where(eq(backupJobs.tenantId, tenantId));
    const jobName = new Map(allJobs.map((job) => [job.id, job.name]));
    const jobOf = (member: BackupJobMember | undefined) =>
      member ? { id: member.jobId, name: jobName.get(member.jobId) ?? "" } : null;
    const term = query.q ? `%${query.q.replace(/[%_\\]/g, (char) => `\\${char}`)}%` : null;
    if (query.kind === "mail") {
      const byObject = new Map(
        members.flatMap((member) =>
          member.protectedObjectId ? [[member.protectedObjectId, member] as const] : [],
        ),
      );
      const objects = (await loadObjectInfos(tx, tenantId)).filter(
        (object) =>
          object.status === "active" &&
          object.sourceKind !== "import" &&
          (term === null ||
            objectName(object)
              .toLowerCase()
              .includes((query.q ?? "").toLowerCase()) ||
            object.externalId.toLowerCase().includes((query.q ?? "").toLowerCase())),
      );
      return {
        total: objects.length,
        items: objects.slice(0, query.limit).map<JobCandidateDto>((object) => ({
          targetId: object.id,
          kind: object.kind,
          name: objectName(object),
          detail: object.externalId,
          status: object.status,
          job: jobOf(byObject.get(object.id)),
        })),
      };
    }
    const byEndpoint = new Map(
      members.flatMap((member) =>
        member.endpointId ? [[member.endpointId, member] as const] : [],
      ),
    );
    const filters: SQL[] = [eq(endpoints.tenantId, tenantId), eq(endpoints.status, "active")];
    if (term) {
      const match = or(ilike(endpoints.hostname, term), ilike(endpoints.displayName, term));
      if (match) filters.push(match);
    }
    const rows = await tx
      .select()
      .from(endpoints)
      .where(and(...filters))
      .orderBy(asc(endpoints.hostname));
    return {
      total: rows.length,
      items: rows.slice(0, query.limit).map<JobCandidateDto>((row) => ({
        targetId: row.id,
        kind: row.profile,
        name: row.displayName?.trim() || row.hostname,
        detail: row.os,
        status: row.status,
        job: jobOf(byEndpoint.get(row.id)),
      })),
    };
  });
}

const MACHINE_OS = ["linux", "darwin", "windows"] as const;
type MachineOs = (typeof MACHINE_OS)[number];

/**
 * What a new machine job starts with for the chosen machines. Each operating system and profile
 * has its own folders (a Mac keeps its data under /Users, not /etc); a mixed choice gets the union,
 * in order, and says it is mixed. Only clients: back up when they connect, not at 22:00 when a
 * laptop is usually off. Without machines: a Linux server, as before.
 */
export function machineJobDefaults(
  machines: readonly { os: string; profile: "server" | "client" }[],
  timeZone: string,
): {
  schedule: JobDefaultsDto["schedule"];
  paths: string[];
  excludes: string[];
  basis: JobDefaultsDto["basis"];
} {
  const known = machines.filter(
    (machine): machine is { os: MachineOs; profile: "server" | "client" } =>
      (MACHINE_OS as readonly string[]).includes(machine.os),
  );
  const pairs = known.length > 0 ? known : [{ os: "linux" as const, profile: "server" as const }];
  const paths: string[] = [];
  const excludes: string[] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    const key = `${pair.os}:${pair.profile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const config = defaultEndpointConfig(pair.os, pair.profile, { timeZone });
    for (const path of config.paths) if (!paths.includes(path)) paths.push(path);
    for (const pattern of config.excludes) if (!excludes.includes(pattern)) excludes.push(pattern);
  }
  const os = [...new Set(known.map((machine) => machine.os))];
  const profiles = [...new Set(known.map((machine) => machine.profile))];
  const onlyClients = profiles.length === 1 && profiles[0] === "client";
  return {
    schedule: defaultSchedule(onlyClients ? "client" : "server", timeZone),
    paths,
    excludes,
    basis: known.length > 0 ? { os, profiles, mixed: os.length > 1 || profiles.length > 1 } : null,
  };
}

export async function getDefaults(
  db: Database,
  tenantId: string,
  kind: JobKindName,
  options: { endpointIds?: readonly string[] } = {},
): Promise<JobDefaultsDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [tenant] = await tx
      .select({ timeZone: tenants.timeZone })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const timeZone = tenant?.timeZone ?? DEFAULT_SCHEDULE_TIMEZONE;
    const primary = await loadPrimaryTarget(tx, tenantId);
    const policies = kind === "mail" ? await loadSnapshotPolicies(tx, tenantId) : [];
    const backup = RECOMMENDED_SCHEDULE_DEFAULTS.find((entry) => entry.slot === "backup");
    const verify = RECOMMENDED_SCHEDULE_DEFAULTS.find((entry) => entry.slot === "verify");
    const mailSchedule = (entry: typeof backup) =>
      entry?.intervalMinutes != null
        ? ({ kind: "interval", intervalMinutes: entry.intervalMinutes, timeZone } as const)
        : ({ kind: "cron", cron: entry?.cron ?? "0 2 * * *", timeZone } as const);
    if (kind === "mail") {
      return {
        kind,
        timeZone,
        schedule: mailSchedule(backup),
        verifySchedule: mailSchedule(verify),
        settings: {},
        basis: null,
        repository: repositoryDto(primary),
        retentionPolicies: policies.map((policy) => ({ ...policy })),
        endpointRetention: { ...DEFAULT_ENDPOINT_RETENTION },
      };
    }
    const machines =
      options.endpointIds && options.endpointIds.length > 0
        ? await tx
            .select({ os: endpoints.os, profile: endpoints.profile })
            .from(endpoints)
            .where(
              and(
                eq(endpoints.tenantId, tenantId),
                inArray(endpoints.id, [...options.endpointIds]),
              ),
            )
        : [];
    const machine = machineJobDefaults(machines, timeZone);
    return {
      kind,
      timeZone,
      schedule: machine.schedule,
      verifySchedule: null,
      settings: {
        paths: machine.paths,
        excludes: machine.excludes,
        hooks: {},
        bandwidthKbps: null,
      },
      basis: machine.basis,
      repository: repositoryDto(primary),
      retentionPolicies: [],
      endpointRetention: { ...DEFAULT_ENDPOINT_RETENTION },
    };
  });
}
