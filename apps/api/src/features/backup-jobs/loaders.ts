import { cutoffDays, parseSnapshotPolicy } from "@restow/core";
import {
  type BackupJob,
  type BackupJobMember,
  backupJobMembers,
  endpointRuns,
  endpointTasks,
  endpoints,
  jobs,
  protectedObjects,
  retentionPolicies,
  sources,
  storageTargets,
} from "@restow/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";
import { loadEndpointReadiness } from "../endpoints/readiness.js";
import { loadObjectVerifications } from "../verify/verification-state.js";
import { loadMachineWarnings } from "../warnings/state.js";
import type { JobRestoreCheckDto, MemberRestoreState, RepositoryDto } from "./dto.js";
import { iso } from "./dto.js";

/** Everything the job pages read, in queries that never name more than the tenant's own rows. */

export interface ObjectInfo {
  id: string;
  kind: "mailbox" | "onedrive" | "imap";
  status: "active" | "excluded" | "orphaned";
  displayName: string | null;
  externalId: string;
  sourceId: string;
  sourceKind: "m365" | "imap" | "import";
  sourceStatus: "pending" | "active" | "error" | "disabled";
  /** The scheduler may plan it: active, on a source that works (or fails and is retried), not imported. */
  eligible: boolean;
}

/** The scheduler's rule for a source it works against (apps/scheduler planning.ts `sourceUsable`). */
export function sourceUsable(kind: string, status: string): boolean {
  return kind !== "import" && (status === "active" || status === "error");
}

export async function loadObjectInfos(
  tx: Transaction,
  tenantId: string,
  ids?: readonly string[],
): Promise<ObjectInfo[]> {
  if (ids && ids.length === 0) {
    return [];
  }
  const rows = await tx
    .select({
      id: protectedObjects.id,
      kind: protectedObjects.kind,
      status: protectedObjects.status,
      displayName: protectedObjects.displayName,
      externalId: protectedObjects.externalId,
      sourceId: protectedObjects.sourceId,
      sourceKind: sources.kind,
      sourceStatus: sources.status,
    })
    .from(protectedObjects)
    .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        ids ? inArray(protectedObjects.id, [...ids]) : undefined,
      ),
    )
    .orderBy(asc(protectedObjects.displayName), asc(protectedObjects.externalId));
  return rows.map((row) => ({
    ...row,
    eligible: row.status === "active" && sourceUsable(row.sourceKind, row.sourceStatus),
  }));
}

export function objectName(object: Pick<ObjectInfo, "displayName" | "externalId">): string {
  const name = object.displayName?.trim();
  return name && name.length > 0 ? name : object.externalId;
}

/** Every member row of the tenant's jobs (the scope of an "all" job needs to know the others'). */
export async function loadAllMembers(
  tx: Transaction,
  tenantId: string,
): Promise<BackupJobMember[]> {
  return tx.select().from(backupJobMembers).where(eq(backupJobMembers.tenantId, tenantId));
}

export interface MailFact {
  /** The newest backup job of the object, whatever its state. */
  latest: { id: string; status: "queued" | "active" | "completed" | "failed" | "cancelled" } | null;
  /** When the newest finished (completed or failed) backup ended. */
  finishedAt: Date | null;
  /** That backup's job (the run History opens). */
  finishedId: string | null;
  restore: { state: MemberRestoreState; checkedAt: Date | null };
}

export async function loadMailFacts(
  tx: Transaction,
  tenantId: string,
  objectIds: readonly string[],
): Promise<Map<string, MailFact>> {
  const result = new Map<string, MailFact>();
  if (objectIds.length === 0) {
    return result;
  }
  const ids = [...objectIds];
  const latest = await tx
    .selectDistinctOn([jobs.protectedObjectId], {
      objectId: jobs.protectedObjectId,
      id: jobs.id,
      status: jobs.status,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.queue, "backup"),
        inArray(jobs.protectedObjectId, ids),
      ),
    )
    .orderBy(jobs.protectedObjectId, desc(jobs.createdAt));
  const finished = await tx
    .selectDistinctOn([jobs.protectedObjectId], {
      objectId: jobs.protectedObjectId,
      id: jobs.id,
      completedAt: jobs.completedAt,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.queue, "backup"),
        inArray(jobs.status, ["completed", "failed"]),
        inArray(jobs.protectedObjectId, ids),
      ),
    )
    .orderBy(jobs.protectedObjectId, desc(jobs.createdAt));
  const verification = await loadObjectVerifications(tx, tenantId, ids);
  const latestBy = new Map(latest.map((row) => [row.objectId, row]));
  const finishedBy = new Map(finished.map((row) => [row.objectId, row]));
  for (const id of ids) {
    const facts = verification.get(id);
    const state = facts?.verification.state ?? "no_backup";
    result.set(id, {
      latest: latestBy.get(id)
        ? { id: latestBy.get(id)?.id ?? "", status: latestBy.get(id)?.status ?? "queued" }
        : null,
      finishedAt: finishedBy.get(id)?.completedAt ?? null,
      finishedId: finishedBy.get(id)?.id ?? null,
      restore: {
        state,
        checkedAt: facts?.verification.report?.checkedAt ?? facts?.newest?.checkedAt ?? null,
      },
    });
  }
  return result;
}

export interface EndpointFact {
  hostname: string;
  displayName: string | null;
  os: string;
  profile: "server" | "client";
  status: "active" | "revoked";
  nextRunAt: Date | null;
  /** The newest backup run an agent reported. */
  latest: {
    id: string;
    status: "running" | "succeeded" | "partial" | "failed";
    finishedAt: Date | null;
  } | null;
  /** When the agent last contacted the server. */
  lastSeenAt: Date | null;
  /** A backup requested by hand that the machine has not started yet (an open `backup_now` task). */
  pendingBackup: { status: "pending" | "delivered"; requestedAt: Date } | null;
  restore: { state: MemberRestoreState; checkedAt: Date | null };
  /**
   * The newest backup left files behind and an administrator acknowledged that warning
   * (features/warnings): the job does not ask for attention for it.
   */
  warningAcknowledged: boolean;
}

export async function loadEndpointFacts(
  tx: Transaction,
  tenantId: string,
  endpointIds: readonly string[],
  now: Date,
): Promise<Map<string, EndpointFact>> {
  const result = new Map<string, EndpointFact>();
  if (endpointIds.length === 0) {
    return result;
  }
  const ids = [...endpointIds];
  const rows = await tx
    .select()
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), inArray(endpoints.id, ids)));
  const runs = await tx
    .selectDistinctOn([endpointRuns.endpointId], {
      endpointId: endpointRuns.endpointId,
      id: endpointRuns.id,
      status: endpointRuns.status,
      finishedAt: endpointRuns.finishedAt,
    })
    .from(endpointRuns)
    .where(
      and(
        eq(endpointRuns.tenantId, tenantId),
        eq(endpointRuns.kind, "backup"),
        inArray(endpointRuns.endpointId, ids),
      ),
    )
    .orderBy(endpointRuns.endpointId, desc(endpointRuns.startedAt));
  // The oldest open request of a machine counts: it is the one the agent receives first.
  const tasks = await tx
    .selectDistinctOn([endpointTasks.endpointId], {
      endpointId: endpointTasks.endpointId,
      status: endpointTasks.status,
      createdAt: endpointTasks.createdAt,
    })
    .from(endpointTasks)
    .where(
      and(
        eq(endpointTasks.tenantId, tenantId),
        eq(endpointTasks.kind, "backup_now"),
        inArray(endpointTasks.status, ["pending", "delivered"]),
        inArray(endpointTasks.endpointId, ids),
      ),
    )
    .orderBy(endpointTasks.endpointId, asc(endpointTasks.createdAt));
  const readiness = await loadEndpointReadiness(tx, tenantId, ids, now);
  const warnings = await loadMachineWarnings(tx, tenantId, { ids });
  const runBy = new Map(runs.map((run) => [run.endpointId, run]));
  const taskBy = new Map(tasks.map((task) => [task.endpointId, task]));
  for (const row of rows) {
    const rated = readiness.get(row.id);
    const run = runBy.get(row.id);
    const task = taskBy.get(row.id);
    result.set(row.id, {
      hostname: row.hostname,
      displayName: row.displayName,
      os: row.os,
      profile: row.profile,
      status: row.status,
      nextRunAt: row.nextRunAt,
      latest: run ? { id: run.id, status: run.status, finishedAt: run.finishedAt } : null,
      lastSeenAt: row.lastSeenAt,
      pendingBackup:
        task && (task.status === "pending" || task.status === "delivered")
          ? { status: task.status, requestedAt: task.createdAt }
          : null,
      restore: { state: rated?.state ?? "no_backup", checkedAt: rated?.checkedAt ?? null },
      warningAcknowledged: warnings.get(row.id)?.evaluation.state === "acknowledged",
    });
  }
  return result;
}

export function endpointName(fact: Pick<EndpointFact, "displayName" | "hostname">): string {
  return fact.displayName?.trim() || fact.hostname;
}

/** The tenant's primary storage target, the only repository jobs write to; null without one of its own. */
export async function loadPrimaryTarget(tx: Transaction, tenantId: string) {
  const [row] = await tx
    .select()
    .from(storageTargets)
    .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.role, "primary")))
    .limit(1);
  return row ?? null;
}

type TargetRow = Awaited<ReturnType<typeof loadPrimaryTarget>>;

export function repositoryDto(target: TargetRow): RepositoryDto {
  if (!target) {
    return {
      id: null,
      name: null,
      kind: "installation_default",
      role: null,
      status: null,
      objectLock: null,
    };
  }
  return {
    id: target.id,
    name: target.name,
    kind: target.kind,
    role: target.role,
    status: target.status,
    objectLock:
      target.kind === "s3"
        ? (target.config as { objectLock?: boolean }).objectLock === true
        : false,
  };
}

/** The repository of a job: the target it names, else the tenant's primary one. */
export async function loadRepositoryOf(
  tx: Transaction,
  tenantId: string,
  job: Pick<BackupJob, "storageTargetId">,
  primary: TargetRow,
): Promise<RepositoryDto> {
  if (job.storageTargetId === null || job.storageTargetId === primary?.id) {
    return repositoryDto(primary);
  }
  const [row] = await tx
    .select()
    .from(storageTargets)
    .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.id, job.storageTargetId)))
    .limit(1);
  return repositoryDto(row ?? primary);
}

export interface SnapshotPolicyInfo {
  id: string;
  name: string;
  isDefault: boolean;
  cutoffDays: number | null;
}

/** The tenant's snapshot retention policies (archive policies are another thing and left out). */
export async function loadSnapshotPolicies(
  tx: Transaction,
  tenantId: string,
): Promise<SnapshotPolicyInfo[]> {
  const rows = await tx
    .select({
      id: retentionPolicies.id,
      name: retentionPolicies.name,
      isDefault: retentionPolicies.isDefault,
      appliesTo: retentionPolicies.appliesTo,
      years: retentionPolicies.years,
    })
    .from(retentionPolicies)
    .where(eq(retentionPolicies.tenantId, tenantId))
    .orderBy(asc(retentionPolicies.createdAt));
  const policies: SnapshotPolicyInfo[] = [];
  for (const row of rows) {
    const parsed = parseSnapshotPolicy(row);
    if (parsed) {
      policies.push({
        id: row.id,
        name: row.name,
        // Only a policy for the whole tenant can be its default; an object override cannot.
        isDefault: row.isDefault && parsed.protectedObjectIds === null,
        cutoffDays: cutoffDays(parsed.tiers),
      });
    }
  }
  return policies;
}

/** The restore-check counters of a set of member states. */
export function restoreCheckOf(
  states: readonly { state: MemberRestoreState; checkedAt: Date | null }[],
): JobRestoreCheckDto {
  const dto: JobRestoreCheckDto = {
    passed: 0,
    warning: 0,
    failed: 0,
    unverified: 0,
    noBackup: 0,
    total: states.length,
    checkedAt: null,
  };
  let latest: Date | null = null;
  for (const entry of states) {
    switch (entry.state) {
      case "green":
        dto.passed++;
        break;
      case "yellow":
        dto.warning++;
        break;
      case "red":
        dto.failed++;
        break;
      case "unverified":
        dto.unverified++;
        break;
      default:
        dto.noBackup++;
    }
    if (entry.checkedAt && (latest === null || entry.checkedAt > latest)) {
      latest = entry.checkedAt;
    }
  }
  dto.checkedAt = iso(latest);
  return dto;
}
