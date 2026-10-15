import { DEFAULT_SHARE_RETENTION } from "@restow/core";
import {
  type BackupJob,
  type BackupJobMember,
  type BackupJobSettings,
  fileShareRuns,
  fileShares,
} from "@restow/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";
import { locationOf } from "../file-shares/dto.js";
import { type ShareFact, loadShareFacts } from "../file-shares/protection.js";
import type {
  BackupJobDto,
  BackupJobMemberDto,
  CopyJobInfoDto,
  JobCandidateDto,
  JobLastRunDto,
  JobRunDto,
  JobScopeDto,
  MemberRestoreState,
} from "./dto.js";
import { earliestOf, isOverdue, iso, jobStateOf, latestOf } from "./dto.js";
import type { SupportedJob } from "./kinds.js";
import { restoreCheckOf } from "./loaders.js";

/**
 * File share jobs and copy jobs in the backup job views (docs/FILESHARES.md 7.5, 12.5, 12.6):
 * how a share job stands from its members' standing (features/file-shares/protection.ts, the
 * one rule of section 13), the members, the candidates and the runs; a copy job from its runs.
 * A copy job is never protection: it has no restore checks and no members.
 */

export interface ShareJobFacts {
  /** The tenant's shares with their standing. */
  shares: Map<string, ShareFact>;
  /** Per copy job, its newest run (running or finished) and the newest successful one. */
  copyRuns: Map<
    string,
    {
      latest: { id: string; status: string; finishedAt: Date | null } | null;
      lastCopied: { snapshotId: string | null; at: Date | null } | null;
    }
  >;
}

export async function loadShareJobFacts(
  tx: Transaction,
  tenantId: string,
  jobs: readonly BackupJob[],
  now: Date,
): Promise<ShareJobFacts> {
  const relevant = jobs.some((job) => job.kind === "share" || job.kind === "copy");
  const shares = new Map<string, ShareFact>();
  if (relevant) {
    for (const fact of await loadShareFacts(tx, tenantId, now)) {
      shares.set(fact.share.id, fact);
    }
  }
  const copyRuns: ShareJobFacts["copyRuns"] = new Map();
  const copyIds = jobs.filter((job) => job.kind === "copy").map((job) => job.id);
  if (copyIds.length > 0) {
    const rows = await tx
      .select({
        id: fileShareRuns.id,
        jobId: fileShareRuns.backupJobId,
        status: fileShareRuns.status,
        finishedAt: fileShareRuns.finishedAt,
        queuedAt: fileShareRuns.queuedAt,
        sourceSnapshotId: fileShareRuns.sourceSnapshotId,
      })
      .from(fileShareRuns)
      .where(and(eq(fileShareRuns.tenantId, tenantId), inArray(fileShareRuns.backupJobId, copyIds)))
      .orderBy(desc(fileShareRuns.queuedAt))
      .limit(2000);
    for (const id of copyIds) {
      const own = rows.filter((row) => row.jobId === id);
      const latest = own[0] ?? null;
      const good = own.find((row) => row.status === "succeeded" || row.status === "warning");
      copyRuns.set(id, {
        latest: latest
          ? { id: latest.id, status: latest.status, finishedAt: latest.finishedAt }
          : null,
        lastCopied: good ? { snapshotId: good.sourceSnapshotId, at: good.finishedAt } : null,
      });
    }
  }
  return { shares, copyRuns };
}

function shareMembersOf(
  job: Pick<BackupJob, "id">,
  members: readonly BackupJobMember[],
): BackupJobMember[] {
  return members.filter((member) => member.jobId === job.id && member.fileShareId);
}

/** What a member's newest backup says, in the words of the job views. */
function outcomeOf(fact: ShareFact): BackupJobMemberDto["lastBackup"]["outcome"] {
  if (fact.activeRun && fact.activeRun.kind === "backup") {
    return fact.activeRun.status === "queued" ? "queued" : "running";
  }
  switch (fact.lastBackupRun?.status) {
    case "succeeded":
      return "succeeded";
    case "warning":
      return fact.warnings ? "partial" : "succeeded";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

function restoreStateOf(fact: ShareFact): MemberRestoreState {
  return fact.readiness.state;
}

/** A share job: its members' standing in the job's figures. */
export function shareJobDto(
  job: SupportedJob,
  members: readonly BackupJobMember[],
  facts: ShareJobFacts,
  repository: BackupJobDto["repository"],
  now: Date,
): BackupJobDto {
  const own = shareMembersOf(job, members);
  const live = own.filter((member) => {
    const fact = facts.shares.get(member.fileShareId as string);
    return fact !== undefined && fact.share.retiredAt === null;
  });
  const byKind: Record<string, number> = {};
  const states: { state: MemberRestoreState; checkedAt: Date | null }[] = [];
  let failed = 0;
  let partial = 0;
  let running = 0;
  let queued = 0;
  let runningRun: string | null = null;
  let newest: { at: Date; runId: string } | null = null;
  const next: (Date | null)[] = [];
  let overrides = 0;
  let jobLevel = 0;
  for (const member of live) {
    const fact = facts.shares.get(member.fileShareId as string) as ShareFact;
    byKind[fact.share.protocol] = (byKind[fact.share.protocol] ?? 0) + 1;
    states.push({ state: restoreStateOf(fact), checkedAt: fact.readiness.checkedAt });
    const outcome = outcomeOf(fact);
    if (outcome === "failed") failed++;
    else if (outcome === "partial") partial++;
    else if (outcome === "running") {
      running++;
      runningRun ??= fact.activeRun?.id ?? null;
    } else if (outcome === "queued") queued++;
    const finished = fact.lastBackupRun;
    if (finished?.finishedAt && (!newest || finished.finishedAt > newest.at)) {
      newest = { at: finished.finishedAt, runId: finished.id };
    }
    if (member.overrides.schedule) {
      next.push(member.nextRunAt);
    } else {
      jobLevel++;
    }
    if (Object.keys(member.overrides).length > 0) overrides++;
  }
  if (jobLevel > 0 && job.schedule) {
    next.push(job.nextRunAt);
  }
  const scope: JobScopeDto = { count: live.length, byKind, overrides };
  const lastRun: JobLastRunDto = {
    at: iso(newest?.at ?? null),
    failed,
    partial,
    running,
    queued,
    runId: runningRun ?? newest?.runId ?? null,
  };
  const restoreCheck = restoreCheckOf(states);
  const nextRunAt = job.enabled && live.length > 0 ? earliestOf(next.filter(Boolean)) : null;
  const ownSchedules = live.some((member) => member.overrides.schedule);
  return {
    id: job.id,
    kind: job.kind,
    name: job.name,
    enabled: job.enabled,
    archive: false,
    origin: job.origin,
    scopeMode: job.scopeMode,
    schedule: job.schedule,
    verifySchedule: null,
    repository,
    retention: {
      policyId: null,
      policyName: null,
      keep: job.settings?.retention ?? { ...DEFAULT_SHARE_RETENTION },
    },
    scope,
    lastRun,
    nextRunAt: iso(nextRunAt),
    restoreCheck,
    state: jobStateOf({
      enabled: job.enabled,
      scopeCount: scope.count,
      failed,
      running,
      queued,
      partial,
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
    settings: job.settings ?? {},
    copy: null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export function copyInfoOf(job: BackupJob, facts: ShareJobFacts): CopyJobInfoDto | null {
  const source = job.sourceFileShareId ? facts.shares.get(job.sourceFileShareId) : undefined;
  const target = job.targetFileShareId ? facts.shares.get(job.targetFileShareId) : undefined;
  if (!source || !target) {
    return null;
  }
  const copied = facts.copyRuns.get(job.id)?.lastCopied ?? null;
  return {
    source: {
      id: source.share.id,
      name: source.share.name,
      retired: source.share.retiredAt !== null,
    },
    target: {
      id: target.share.id,
      name: target.share.name,
      retired: target.share.retiredAt !== null,
      allowRestore: target.share.allowRestore,
    },
    mode: job.settings.mode ?? "overwrite",
    targetFolder: job.settings.targetFolder ?? "",
    mirrorConfirmedAt: job.settings.mirrorConfirmedAt ?? null,
    lastCopied: copied ? { snapshotId: copied.snapshotId, at: iso(copied.at) } : null,
  };
}

/** A copy job: never protection, so it has no restore checks; its state comes from its runs. */
export function copyJobDto(
  job: SupportedJob,
  facts: ShareJobFacts,
  repository: BackupJobDto["repository"],
  now: Date,
): BackupJobDto {
  const info = copyInfoOf(job, facts);
  const runs = facts.copyRuns.get(job.id);
  const latest = runs?.latest ?? null;
  const usable = info !== null && !info.source.retired && !info.target.retired;
  const running = latest && (latest.status === "running" || latest.status === "starting") ? 1 : 0;
  const queued = latest?.status === "queued" ? 1 : 0;
  const failed = latest?.status === "failed" ? 1 : 0;
  const partial = latest?.status === "warning" ? 1 : 0;
  const lastAt = runs?.lastCopied?.at ?? null;
  const lastRun: JobLastRunDto = {
    at: iso(latestOf([lastAt, latest?.finishedAt ?? null])),
    failed,
    partial,
    running,
    queued,
    runId: latest?.id ?? null,
  };
  const restoreCheck = restoreCheckOf([]);
  const nextRunAt = job.enabled && usable ? job.nextRunAt : null;
  return {
    id: job.id,
    kind: job.kind,
    name: job.name,
    enabled: job.enabled,
    archive: false,
    origin: job.origin,
    scopeMode: "selected",
    schedule: job.schedule,
    verifySchedule: null,
    repository,
    retention: { policyId: null, policyName: null, keep: null },
    scope: { count: usable ? 1 : 0, byKind: usable ? { copy: 1 } : {}, overrides: 0 },
    lastRun,
    nextRunAt: iso(nextRunAt),
    restoreCheck,
    state: jobStateOf({
      enabled: job.enabled,
      scopeCount: usable ? 1 : 0,
      failed,
      running,
      queued,
      partial,
      restore: restoreCheck,
      manual: job.schedule === null,
      overdue: isOverdue({
        schedule: job.schedule,
        nextRunAt,
        lastAt: lastRun.at,
        createdAt: job.createdAt,
        now,
      }),
    }),
    settings: job.settings ?? {},
    copy: info,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

/** The settings a share member runs with: the job's, with the member's own on top. */
export function effectiveShareSettings(
  settings: BackupJobSettings,
  overrides: BackupJobMember["overrides"],
): BackupJobSettings {
  const { schedule: _schedule, verifySchedule: _verify, includes: _includes, ...own } = overrides;
  const merged: BackupJobSettings = { ...settings };
  for (const [key, value] of Object.entries(own)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

export function shareMembers(
  job: BackupJob,
  own: readonly BackupJobMember[],
  facts: ShareJobFacts,
): BackupJobMemberDto[] {
  const items: BackupJobMemberDto[] = [];
  for (const member of own) {
    const fact = member.fileShareId ? facts.shares.get(member.fileShareId) : undefined;
    if (!member.fileShareId || !fact) continue;
    const overrides = member.overrides ?? {};
    const schedule = overrides.schedule ?? job.schedule;
    const retired = fact.share.retiredAt !== null;
    items.push({
      targetId: member.fileShareId,
      kind: fact.share.protocol,
      name: fact.share.name,
      detail: locationOf(fact.share),
      status: retired ? "retired" : "active",
      covered: !retired,
      explicit: true,
      overrides,
      effective: {
        schedule,
        verifySchedule: null,
        settings: effectiveShareSettings(job.settings ?? {}, overrides),
      },
      lastBackup: {
        at: iso(fact.lastBackupRun?.finishedAt ?? null),
        outcome: outcomeOf(fact),
      },
      pendingBackup: null,
      restoreCheck: { state: restoreStateOf(fact), checkedAt: iso(fact.readiness.checkedAt) },
      nextRunAt:
        !retired && job.enabled && schedule
          ? iso(overrides.schedule ? member.nextRunAt : job.nextRunAt)
          : null,
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function shareCandidates(
  tx: Transaction,
  tenantId: string,
  query: { q?: string; limit: number },
  members: readonly BackupJobMember[],
  jobName: Map<string, string>,
): Promise<{ items: JobCandidateDto[]; total: number }> {
  const rows = await tx
    .select()
    .from(fileShares)
    .where(and(eq(fileShares.tenantId, tenantId), isNull(fileShares.retiredAt)))
    .orderBy(fileShares.name);
  const needle = query.q?.toLowerCase() ?? "";
  const shown = rows.filter(
    (row) =>
      needle === "" ||
      row.name.toLowerCase().includes(needle) ||
      locationOf(row).toLowerCase().includes(needle),
  );
  const byShare = new Map(
    members.flatMap((member) =>
      member.fileShareId ? [[member.fileShareId, member] as const] : [],
    ),
  );
  return {
    total: shown.length,
    items: shown.slice(0, query.limit).map((row) => {
      const member = byShare.get(row.id);
      return {
        targetId: row.id,
        kind: row.protocol,
        name: row.name,
        detail: locationOf(row),
        status: "active",
        job: member ? { id: member.jobId, name: jobName.get(member.jobId) ?? "" } : null,
      };
    }),
  };
}

/** The runs of a share job's members, or of a copy job. */
export async function shareJobRuns(
  tx: Transaction,
  tenantId: string,
  job: BackupJob,
  members: readonly BackupJobMember[],
  limit: number,
): Promise<JobRunDto[]> {
  const shareIds =
    job.kind === "share"
      ? shareMembersOf(job, members).map((member) => member.fileShareId as string)
      : [];
  const rows = await tx
    .select({
      id: fileShareRuns.id,
      kind: fileShareRuns.kind,
      trigger: fileShareRuns.trigger,
      status: fileShareRuns.status,
      fileShareId: fileShareRuns.fileShareId,
      name: fileShares.name,
      startedAt: fileShareRuns.startedAt,
      finishedAt: fileShareRuns.finishedAt,
      queuedAt: fileShareRuns.queuedAt,
    })
    .from(fileShareRuns)
    .innerJoin(fileShares, eq(fileShares.id, fileShareRuns.fileShareId))
    .where(
      and(
        eq(fileShareRuns.tenantId, tenantId),
        job.kind === "copy"
          ? eq(fileShareRuns.backupJobId, job.id)
          : shareIds.length > 0
            ? and(eq(fileShareRuns.kind, "backup"), inArray(fileShareRuns.fileShareId, shareIds))
            : eq(fileShareRuns.backupJobId, job.id),
      ),
    )
    .orderBy(desc(fileShareRuns.queuedAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    source: "file_share",
    type: row.trigger === "copy" ? "copy" : row.kind,
    status: row.status,
    targetId: row.fileShareId,
    targetName: row.name,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    createdAt: row.queuedAt.toISOString(),
  }));
}
